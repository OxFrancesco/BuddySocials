//! The network side of the app, on its own thread: the Convex connection, the
//! signed-in session and every live query. The window never waits on it. Results
//! arrive as events that `poll` folds into state.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use convex::{ConvexClient, FunctionResult, Value};
use futures::StreamExt;
use serde_json::Value as Json;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::auth::{self, Session};
use crate::config;

#[derive(Clone, PartialEq, Debug)]
pub enum AuthState {
    /// Reading the stored session.
    Loading,
    SignedOut,
    /// The browser is open on the sign-in page.
    WaitingForBrowser,
    SignedIn { email: Option<String> },
}

#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct QuerySpec {
    pub name: &'static str,
    /// The arguments as JSON text, so the spec can be a map key.
    pub args: String,
}

impl QuerySpec {
    pub fn new(name: &'static str, args: Json) -> QuerySpec {
        QuerySpec { name, args: args.to_string() }
    }

    pub fn key(&self) -> String {
        format!("{}|{}", self.name, self.args)
    }
}

pub enum Cmd {
    SignIn,
    SignOut,
    /// The full set of queries the window wants live. Anything else is dropped.
    Subscribe(Vec<QuerySpec>),
    Mutation { name: &'static str, args: Json },
    /// Saves the draft, then publishes it. One command, because a new draft has no ID until it is saved.
    PublishDraft { draft: Json },
    /// Starts connecting a platform account; the browser does the rest.
    /// `pages` connects the LinkedIn company Pages the user administers instead of their profile.
    Connect { platform: String, another: bool, pages: bool },
    /// Sends a file to storage and registers it, so a draft can hold it.
    Upload { key: u64, path: PathBuf, mime: String, name: String },
    /// Fetches a saved attachment to a local file.
    Download { key: u64, url: String, to: PathBuf },
}

pub enum Event {
    Auth(AuthState),
    OpenUrl(String),
    Data { key: String, value: Json },
    /// Something the person should read, already worded for them.
    Notice(String),
    /// The server's record of an uploaded file, or why it didn't arrive.
    Uploaded { key: u64, result: Result<Json, String> },
    Downloaded { key: u64, result: Result<PathBuf, String> },
}

enum Internal {
    SignedIn(anyhow::Result<Session>),
}

#[derive(Clone)]
struct Out {
    events: Arc<Mutex<Vec<Event>>>,
    wake: rune::Waker,
}

impl Out {
    fn push(&self, event: Event) {
        self.events.lock().unwrap().push(event);
        (self.wake)();
    }
}

pub struct Backend {
    cmds: mpsc::UnboundedSender<Cmd>,
    events: Arc<Mutex<Vec<Event>>>,
}

impl Backend {
    pub fn start(wake: rune::Waker) -> Backend {
        let (cmds, receiver) = mpsc::unbounded_channel();
        let events = Arc::new(Mutex::new(Vec::new()));
        let out = Out { events: events.clone(), wake };
        std::thread::Builder::new()
            .name("backend".into())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("tokio runtime");
                runtime.block_on(run(receiver, out));
            })
            .expect("backend thread");
        Backend { cmds, events }
    }

    pub fn send(&self, cmd: Cmd) {
        let _ = self.cmds.send(cmd);
    }

    pub fn drain(&self) -> Vec<Event> {
        std::mem::take(&mut *self.events.lock().unwrap())
    }
}

fn args_of(json: &str) -> BTreeMap<String, Value> {
    let Ok(Json::Object(map)) = serde_json::from_str::<Json>(json) else { return BTreeMap::new() };
    map.into_iter().filter_map(|(key, value)| Value::try_from(value).ok().map(|value| (key, value))).collect()
}

/// Convex prefixes thrown errors with where they came from. People only need the sentence.
fn readable(message: &str) -> String {
    let line = message.lines().find(|line| line.contains("Uncaught Error: ")).or_else(|| message.lines().next()).unwrap_or("");
    let text = line.rsplit("Uncaught Error: ").next().unwrap_or(line).trim();
    if text.is_empty() { "Something went wrong. Try again.".to_string() } else { text.to_string() }
}

fn failure(result: &FunctionResult) -> Option<String> {
    match result {
        FunctionResult::Value(_) => None,
        FunctionResult::ErrorMessage(message) => Some(readable(message)),
        FunctionResult::ConvexError(error) => Some(readable(&error.message)),
    }
}

async fn connect(out: &Out) -> ConvexClient {
    let mut told = false;
    loop {
        match ConvexClient::new(&config::convex_url()).await {
            Ok(client) => return client,
            Err(_) => {
                if !told {
                    out.push(Event::Notice("Can't reach BuddySocials. Check your connection.".into()));
                    told = true;
                }
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
        }
    }
}

async fn run(mut cmds: mpsc::UnboundedReceiver<Cmd>, out: Out) {
    let mut client = connect(&out).await;
    let (internal_tx, mut internal) = mpsc::unbounded_channel::<Internal>();
    let mut subscriptions: HashMap<QuerySpec, JoinHandle<()>> = HashMap::new();
    let mut sign_in: Option<JoinHandle<()>> = None;

    let mut session = auth::load();
    if let Some(current) = session.clone() {
        if current.seconds_left() < 60 {
            session = renew(&current).await;
        }
    }
    apply(&mut client, &session, &out).await;

    loop {
        // Renew a minute before the token runs out; retry soon when the last attempt found no network.
        let renew_in = match &session {
            Some(current) => Duration::from_secs((current.seconds_left() - 60).clamp(20, 86_400) as u64),
            None => Duration::from_secs(86_400),
        };
        tokio::select! {
            cmd = cmds.recv() => {
                let Some(cmd) = cmd else { return };
                match cmd {
                    Cmd::SignIn => {
                        if let Some(task) = sign_in.take() { task.abort(); }
                        match auth::begin().await {
                            Ok(pending) => {
                                out.push(Event::OpenUrl(pending.url.clone()));
                                out.push(Event::Auth(AuthState::WaitingForBrowser));
                                let done = internal_tx.clone();
                                sign_in = Some(tokio::spawn(async move {
                                    let _ = done.send(Internal::SignedIn(auth::finish(pending).await));
                                }));
                            }
                            Err(error) => out.push(Event::Notice(error.to_string())),
                        }
                    }
                    Cmd::SignOut => {
                        if let Some(task) = sign_in.take() { task.abort(); }
                        auth::clear();
                        session = None;
                        apply(&mut client, &session, &out).await;
                    }
                    Cmd::Subscribe(wanted) => {
                        subscriptions.retain(|spec, task| {
                            let keep = wanted.contains(spec);
                            if !keep { task.abort(); }
                            keep
                        });
                        for spec in wanted {
                            if subscriptions.contains_key(&spec) { continue; }
                            subscriptions.insert(spec.clone(), tokio::spawn(watch(client.clone(), spec, out.clone())));
                        }
                    }
                    Cmd::Mutation { name, args } => {
                        let mut client = client.clone();
                        let out = out.clone();
                        tokio::spawn(async move {
                            match client.mutation(name, args_of(&args.to_string())).await {
                                Ok(result) => if let Some(message) = failure(&result) { out.push(Event::Notice(message)) },
                                Err(_) => out.push(Event::Notice("That didn't go through. Try again.".into())),
                            }
                        });
                    }
                    Cmd::PublishDraft { draft } => {
                        let mut client = client.clone();
                        let out = out.clone();
                        tokio::spawn(async move {
                            let saved = client.mutation("drafts:save", args_of(&draft.to_string())).await;
                            let draft_id = match saved {
                                Ok(FunctionResult::Value(Value::String(id))) => id,
                                Ok(result) => return out.push(Event::Notice(failure(&result).unwrap_or_else(|| "The draft could not be saved.".into()))),
                                Err(_) => return out.push(Event::Notice("The draft could not be saved.".into())),
                            };
                            let args = serde_json::json!({ "draftId": draft_id });
                            match client.mutation("drafts:publish", args_of(&args.to_string())).await {
                                Ok(result) => if let Some(message) = failure(&result) { out.push(Event::Notice(message)) },
                                Err(_) => out.push(Event::Notice("That didn't go through. Try again.".into())),
                            }
                        });
                    }
                    Cmd::Upload { key, path, mime, name } => {
                        let mut client = client.clone();
                        let out = out.clone();
                        tokio::spawn(async move {
                            let result = upload(&mut client, &path, &mime, &name).await;
                            out.push(Event::Uploaded { key, result });
                        });
                    }
                    Cmd::Download { key, url, to } => {
                        let out = out.clone();
                        tokio::spawn(async move {
                            let result = download(&url, &to).await.map(|()| to).map_err(|_| "This attachment could not be loaded.".to_string());
                            out.push(Event::Downloaded { key, result });
                        });
                    }
                    Cmd::Connect { platform, another, pages } => {
                        let mut client = client.clone();
                        let out = out.clone();
                        tokio::spawn(async move {
                            let args = serde_json::json!({ "platform": platform, "another": another, "client": "desktop", "pages": pages });
                            match client.action("connect:begin", args_of(&args.to_string())).await {
                                Ok(FunctionResult::Value(Value::String(url))) => out.push(Event::OpenUrl(url)),
                                Ok(result) => out.push(Event::Notice(failure(&result).unwrap_or_else(|| "Could not start sign-in.".into()))),
                                Err(_) => out.push(Event::Notice("Could not start sign-in.".into())),
                            }
                        });
                    }
                }
            }
            message = internal.recv() => {
                let Some(Internal::SignedIn(result)) = message else { continue };
                sign_in = None;
                match result {
                    Ok(next) => {
                        if auth::save(&next).is_err() {
                            out.push(Event::Notice("Signed in, but the session could not be saved to the keychain.".into()));
                        }
                        session = Some(next);
                    }
                    Err(error) => out.push(Event::Notice(error.to_string())),
                }
                apply(&mut client, &session, &out).await;
            }
            _ = tokio::time::sleep(renew_in), if session.is_some() => {
                let current = session.clone().expect("guarded by the select condition");
                let next = renew(&current).await;
                let changed = next.as_ref().map(|s| &s.id_token) != Some(&current.id_token);
                session = next;
                if changed { apply(&mut client, &session, &out).await; }
            }
        }
    }
}

/// Uploads a file in three steps: ask where, send the bytes, tell the server it arrived.
pub async fn upload(client: &mut ConvexClient, path: &Path, mime: &str, name: &str) -> Result<Json, String> {
    let failed = || "The upload didn't go through. Try again.".to_string();
    let target = match client.mutation("drafts:generateUploadUrl", BTreeMap::new()).await {
        Ok(FunctionResult::Value(Value::String(url))) => url,
        Ok(result) => return Err(failure(&result).unwrap_or_else(failed)),
        Err(_) => return Err(failed()),
    };
    let file = tokio::fs::File::open(path).await.map_err(|_| "That file could not be read.".to_string())?;
    let length = file.metadata().await.map_err(|_| failed())?.len();
    // Streamed from disk, so a large video never sits in memory whole.
    let response = reqwest::Client::new()
        .post(target)
        .header(reqwest::header::CONTENT_TYPE, mime)
        .header(reqwest::header::CONTENT_LENGTH, length)
        .body(reqwest::Body::from(file))
        .send()
        .await
        .map_err(|_| failed())?;
    if !response.status().is_success() {
        return Err(failed());
    }
    let stored: Json = response.json().await.map_err(|_| failed())?;
    let Some(storage_id) = stored["storageId"].as_str() else { return Err(failed()) };
    let args = serde_json::json!({ "storageId": storage_id, "filename": name });
    match client.mutation("media:attach", args_of(&args.to_string())).await {
        Ok(FunctionResult::Value(value)) => Ok(Json::from(value)),
        Ok(result) => Err(failure(&result).unwrap_or_else(failed)),
        Err(_) => Err(failed()),
    }
}

async fn download(url: &str, to: &Path) -> anyhow::Result<()> {
    use tokio::io::AsyncWriteExt;
    let mut response = reqwest::get(url).await?.error_for_status()?;
    let mut file = tokio::fs::File::create(to).await?;
    while let Some(chunk) = response.chunk().await? {
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    Ok(())
}

/// A fresh session, the same one when the network is down, or none when the sign-in is no longer valid.
async fn renew(current: &Session) -> Option<Session> {
    match auth::refresh(current).await {
        Ok(next) => {
            let _ = auth::save(&next);
            Some(next)
        }
        Err(error) if error.downcast_ref::<auth::Rejected>().is_some() => {
            auth::clear();
            None
        }
        Err(_) => Some(current.clone()),
    }
}

async fn apply(client: &mut ConvexClient, session: &Option<Session>, out: &Out) {
    client.set_auth(session.as_ref().map(|s| s.id_token.clone())).await;
    out.push(Event::Auth(match session {
        Some(session) => AuthState::SignedIn { email: session.email.clone() },
        None => AuthState::SignedOut,
    }));
}

async fn watch(mut client: ConvexClient, spec: QuerySpec, out: Out) {
    let key = spec.key();
    let Ok(mut subscription) = client.subscribe(spec.name, args_of(&spec.args)).await else { return };
    while let Some(result) = subscription.next().await {
        // A failed query keeps the last good result on screen; the next push replaces it.
        if let FunctionResult::Value(value) = result {
            out.push(Event::Data { key: key.clone(), value: Json::from(value) });
        }
    }
}
