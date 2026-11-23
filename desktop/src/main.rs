//! BuddySocials for the desktop: the same dashboard, Studio with embedded Claude Code,
//! posts, inbox, goals and accounts as the phone app, on the same live backend.

mod auth;
mod backend;
mod claude;
mod config;
mod dither;
mod fmt;
mod home;
mod media;
mod pages;
mod preview;
mod studio;
mod studio_bridge;
mod theme;
mod ui;
mod update;

use std::cell::RefCell;
use std::collections::HashMap;
use std::time::Duration;

use rune::{AppSpec, Cx, El, Pixels, TextEdit, Tx, col, row, text};
use serde_json::{Value as Json, json};

use backend::{AuthState, Backend, Cmd, Event, QuerySpec};

const HOUR_MS: f64 = 3_600_000.0;
const DAY_MS: f64 = 86_400_000.0;
const PAGE: u32 = 100;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tab {
    Home,
    Studio,
    Posts,
    Inbox,
    Goals,
    Accounts,
}

impl Tab {
    const ALL: [Tab; 6] = [Tab::Home, Tab::Studio, Tab::Posts, Tab::Inbox, Tab::Goals, Tab::Accounts];

    fn label(self) -> &'static str {
        match self {
            Tab::Home => "Home",
            Tab::Studio => "Studio",
            Tab::Posts => "Posts",
            Tab::Inbox => "Inbox",
            Tab::Goals => "Goals",
            Tab::Accounts => "Accounts",
        }
    }
}

/// The draft open in the Studio editor.
pub struct DraftEdit {
    /// None while the draft has never been saved.
    pub id: Option<String>,
    pub title: TextEdit,
    pub text: TextEdit,
    /// Optional per-platform copy overrides keyed by platform name.
    pub platform_text: HashMap<String, TextEdit>,
    /// Which copy tab is active in the editor ("core" or a platform name).
    pub active_copy_tab: String,
    /// YouTube privacy status ("public", "unlisted", "private").
    pub youtube_visibility: String,
    pub accounts: Vec<String>,
    /// Publishing is public, so the button asks once more before it sends.
    pub confirming: bool,
    pub show_schedule: bool,
    pub schedule_input: TextEdit,
    pub media: Vec<media::Item>,
    pub cover: Option<media::Cover>,
    /// The attachment being cropped or trimmed.
    pub editing: Option<media::Edit>,
    /// Files are being dragged over the draft.
    pub drop_over: bool,
}

impl DraftEdit {
    pub fn new(id: Option<String>, text: &str, accounts: Vec<String>) -> DraftEdit {
        let mut text = TextEdit::new(text);
        text.focused = true;
        DraftEdit {
            id,
            title: TextEdit::new(""),
            text,
            platform_text: HashMap::new(),
            active_copy_tab: "core".into(),
            youtube_visibility: "unlisted".into(),
            accounts,
            confirming: false,
            show_schedule: false,
            schedule_input: TextEdit::new(""),
            media: Vec::new(),
            cover: None,
            editing: None,
            drop_over: false,
        }
    }

    pub fn has_override(&self, platform: &str) -> bool {
        self.platform_text.get(platform).is_some_and(|edit| !edit.text.trim().is_empty())
    }

    pub fn text_for(&self, platform: &str) -> &str {
        self.platform_text
            .get(platform)
            .map(|e| e.text.as_str())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(self.text.text.as_str())
    }

    pub fn text_edit_for_tab(&self, tab: &str) -> &TextEdit {
        if tab == "core" {
            &self.text
        } else {
            self.platform_text.get(tab).unwrap_or(&self.text)
        }
    }

    pub fn text_edit_mut_for_tab(&mut self, tab: &str) -> &mut TextEdit {
        if tab == "core" {
            &mut self.text
        } else {
            self.platform_text.entry(tab.to_string()).or_insert_with(|| TextEdit::new(""))
        }
    }

    /// Pre-flight check matching `shared/drafts.ts`, so live previews flag issues before publishing.
    pub fn live_issue(&self, account: &Json) -> Option<String> {
        let platform = account["platform"].as_str().unwrap_or("");
        let label = theme::platform_label(platform);
        if account["source"] == "demo" {
            return Some("Demo accounts can't post.".into());
        }
        if account["status"] == "reconnect" {
            return Some(format!("Sign in to {label} again."));
        }
        let body = self.text_for(platform).trim();
        let len = body.chars().count();
        if len == 0 && self.media.is_empty() {
            return Some("Write something first.".into());
        }
        let limit = match platform {
            "x" => Some(280),
            "linkedin" => Some(3000),
            "instagram" => Some(2200),
            "facebook" => Some(63206),
            _ => None,
        };
        if let Some(limit) = limit {
            if len > limit {
                return Some(format!("{} over {label}'s {limit} char limit.", len - limit));
            }
        }
        let videos = self.media.iter().filter(|m| m.kind == media::Kind::Video).count();
        if matches!(platform, "tiktok" | "youtube") {
            if videos == 0 {
                return Some(format!("{label} needs a video."));
            }
            if self.media.len() > 1 {
                return Some(format!("{label} takes one video on its own."));
            }
        }
        if platform == "instagram" && self.media.is_empty() {
            return Some("Instagram needs an image or a video.".into());
        }
        if platform == "youtube" {
            let title = self.title.text.trim();
            if body.contains('<') || body.contains('>') || title.contains('<') || title.contains('>') {
                return Some("YouTube doesn't allow < or >.".into());
            }
            if title.chars().count() > 100 {
                return Some("YouTube titles take up to 100 chars.".into());
            }
        }
        None
    }

    pub fn to_save_json(&self) -> Json {
        let mut overrides = serde_json::Map::new();
        for (platform, edit) in &self.platform_text {
            if !edit.text.trim().is_empty() {
                overrides.insert(platform.clone(), json!(edit.text.clone()));
            }
        }
        let title = self.title.text.trim();
        let mut draft = json!({
            "title": if title.is_empty() { Json::Null } else { json!(title) },
            "text": self.text.text.clone(),
            "platformText": if overrides.is_empty() { Json::Null } else { Json::Object(overrides) },
            "youtubeVisibility": self.youtube_visibility.clone(),
            "accountIds": self.accounts,
            "cover": match self.cover.as_ref().and_then(|c| c.storage_id.as_deref()) {
                Some(id) => json!(id),
                None => Json::Null,
            },
        });
        if let Some(id) = &self.id {
            draft["draftId"] = json!(id);
        }
        if let Some(records) = media::records(self) {
            draft["media"] = json!(records);
        }
        draft
    }
}

/// A chart's pixels and what they were drawn from, so it is only redrawn when that changes.
pub struct Chart {
    pub signature: u64,
    pub pixels: Pixels,
}

pub struct App {
    pub backend: Option<Backend>,
    pub auth: AuthState,
    pub tab: Tab,
    /// Latest result of every live query, by `QuerySpec::key`.
    pub data: HashMap<String, Json>,
    wanted: Vec<QuerySpec>,
    /// "all" or a platform.
    pub posts_filter: String,
    /// The Posts tab shows what is published or what is still a draft.
    pub show_drafts: bool,
    pub draft: Option<DraftEdit>,
    /// Embedded Claude Code Studio state.
    pub studio: studio::StudioState,
    pub inbox_open_only: bool,
    pub reply_to: Option<String>,
    pub reply: TextEdit,
    pub confirm_disconnect: Option<String>,
    /// Set after the first press on "Delete my account"; the second press deletes.
    pub confirm_delete_account: bool,
    pub notice: Option<String>,
    pub charts: RefCell<HashMap<String, Chart>>,
    /// The chart under the pointer and how far along it, 0 to 1.
    pub hover: Option<(String, f32)>,
    /// Image and video work running off the window's thread.
    pub jobs: media::Jobs,
    /// Names each attachment for as long as the app runs.
    pub next_key: u64,
    /// Wall clock in milliseconds, refreshed by `poll`.
    pub now: f64,
    /// Small pictures of each draft's first attachment, for the drafts page.
    pub thumbs: preview::Thumbs,
    /// Whether a newer build of the app is waiting, and how far along installing it is.
    pub update: update::State,
    /// When the app last asked for a newer build.
    update_checked: f64,
}

impl App {
    pub fn query(&self, name: &'static str, args: Json) -> Option<&Json> {
        self.data.get(&QuerySpec::new(name, args).key())
    }

    pub fn today(&self) -> String {
        fmt::day_key(self.now)
    }

    pub fn hour(&self) -> f64 {
        (self.now / HOUR_MS).floor() * HOUR_MS
    }

    pub fn send(&self, cmd: Cmd) {
        if let Some(backend) = &self.backend {
            backend.send(cmd);
        }
    }

    pub fn mutate(&self, name: &'static str, args: Json) {
        self.send(Cmd::Mutation { name, args });
    }

    pub fn accounts(&self) -> &[Json] {
        self.query("accounts:list", json!({})).and_then(Json::as_array).map(Vec::as_slice).unwrap_or(&[])
    }

    /// True while any account's sync is running. A claim past two minutes is treated as dead.
    pub fn syncing(&self) -> bool {
        self.accounts().iter().any(|account| {
            account["status"] == "syncing" && account["syncStartedAt"].as_f64().is_some_and(|started| self.now - started < 120_000.0)
        })
    }

    pub fn posts_args(&self) -> Json {
        let mut args = json!({ "paginationOpts": { "numItems": PAGE, "cursor": null } });
        if self.posts_filter != "all" {
            args["platform"] = json!(self.posts_filter);
        }
        args
    }

    pub fn inbox_args(&self) -> Json {
        json!({ "open": self.inbox_open_only, "paginationOpts": { "numItems": PAGE, "cursor": null } })
    }

    /// Every query the window shows. All of them stay live, so switching tabs never loads.
    fn queries(&self) -> Vec<QuerySpec> {
        let today = self.today();
        let mut wanted = vec![
            QuerySpec::new("accounts:list", json!({})),
            QuerySpec::new("layouts:get", json!({})),
            QuerySpec::new("connectStore:availability", json!({})),
            QuerySpec::new("connectStore:pagesAvailable", json!({})),
            QuerySpec::new("comments:openSummary", json!({})),
            QuerySpec::new("goals:list", json!({ "today": today })),
            QuerySpec::new("dashboard:posts", self.posts_args()),
            QuerySpec::new("comments:list", self.inbox_args()),
            QuerySpec::new("drafts:list", json!({})),
            QuerySpec::new("media:cleanup", json!({})),
        ];
        for widget in self.query("layouts:get", json!({})).and_then(Json::as_array).into_iter().flatten() {
            wanted.extend(home::queries_for(widget, &today, self.hour()));
        }
        wanted.sort_by(|a, b| a.key().cmp(&b.key()));
        wanted.dedup();
        wanted
    }
}

fn cache_path() -> Option<std::path::PathBuf> {
    Some(config::cache_dir()?.join("dashboard.json"))
}

fn init() -> App {
    let mut app = App {
        backend: None,
        auth: AuthState::Loading,
        tab: Tab::Home,
        data: HashMap::new(),
        wanted: Vec::new(),
        posts_filter: "all".into(),
        show_drafts: false,
        draft: None,
        studio: studio::StudioState::new(),
        inbox_open_only: true,
        reply_to: None,
        reply: TextEdit::new(""),
        confirm_disconnect: None,
        confirm_delete_account: false,
        notice: None,
        charts: RefCell::new(HashMap::new()),
        hover: None,
        jobs: media::Jobs::default(),
        next_key: 0,
        now: fmt::now_ms(),
        thumbs: preview::Thumbs::default(),
        update: update::State::Current,
        update_checked: fmt::now_ms(),
    };
    if let Some(path) = std::env::var_os("BUDDYSOCIALS_FIXTURE") {
        if let Some(data) = std::fs::read(path).ok().and_then(|raw| serde_json::from_slice(&raw).ok()) {
            app.data = data;
            app.auth = AuthState::SignedIn { email: Some("you@example.com".into()) };
        }
        if let Some(now) = std::env::var("BUDDYSOCIALS_NOW").ok().and_then(|raw| raw.parse().ok()) {
            app.now = now;
        }
    }
    app
}

fn setup(s: &mut App, wake: rune::Waker) {
    s.jobs.set_waker(wake.clone());
    s.thumbs.set_waker(wake.clone());
    s.studio.runner.set_waker(wake.clone());
    if std::env::var_os("BUDDYSOCIALS_FIXTURE").is_some() {
        return;
    }
    if auth::load().is_some() {
        if let Some(data) = cache_path().and_then(|path| std::fs::read(path).ok()).and_then(|raw| serde_json::from_slice(&raw).ok()) {
            s.data = data;
        }
    }
    s.backend = Some(Backend::start(wake));
}

fn save_cache(data: &HashMap<String, Json>) {
    let Some(path) = cache_path() else { return };
    let Ok(raw) = serde_json::to_vec(data) else { return };
    std::thread::spawn(move || {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(path, raw);
    });
}

/// Folds what the backend and Claude Code sent into state and keeps subscriptions in step.
fn absorb(s: &mut App) -> (bool, Vec<String>) {
    let fixture = s.backend.is_none();
    let mut changed = false;
    let mut links = Vec::new();
    let now = fmt::now_ms();
    if !fixture && (now - s.now).abs() >= 30_000.0 {
        s.now = now;
        changed = true;
    }
    let mut new_data = false;
    for event in s.backend.as_ref().map(Backend::drain).unwrap_or_default() {
        changed = true;
        match event {
            Event::Auth(auth) => {
                if auth == AuthState::SignedOut {
                    s.data.clear();
                    s.charts.borrow_mut().clear();
                    if let Some(path) = cache_path() {
                        let _ = std::fs::remove_file(path);
                    }
                }
                if matches!(auth, AuthState::SignedIn { .. }) && !matches!(s.auth, AuthState::SignedIn { .. }) {
                    s.mutate("profiles:ensure", json!({}));
                }
                s.auth = auth;
            }
            Event::OpenUrl(url) => links.push(url),
            Event::Data { key, value } => {
                s.data.insert(key, value);
                new_data = true;
            }
            Event::Notice(message) => s.notice = Some(message),
            Event::Uploaded { key, result } => media::uploaded(s, key, result),
            Event::CoverUploaded { key, result } => media::cover_uploaded(s, key, result),
            Event::Downloaded { key, result } => media::downloaded(s, key, result),
            Event::DraftSaved(id) => {
                if let Some(edit) = &mut s.draft {
                    if edit.id.is_none() {
                        edit.id = Some(id);
                    }
                }
            }
            Event::BridgeReady(info) => s.studio.bridge = Some(info),
            Event::StudioApplyDraft(patch) => {
                studio::apply_patch(s, patch);
                s.tab = Tab::Studio;
            }
            Event::StudioOpenDraft(draft_id) => {
                studio::open_draft_by_id(s, &draft_id);
                s.tab = Tab::Studio;
            }
            Event::StudioAttachUploaded { path, record, as_cover } => {
                media::attach_uploaded(s, path, record, as_cover);
                if let Some(edit) = &s.draft {
                    let payload = edit.to_save_json();
                    s.send(Cmd::SaveDraft { draft: payload, quiet: true });
                }
            }
            Event::UpdateAvailable(latest) => {
                if matches!(s.update, update::State::Current | update::State::Available(_)) {
                    s.update = update::State::Available(latest);
                }
            }
            Event::UpdateInstalled(Ok(relaunch)) => s.update = update::State::Ready(relaunch),
            Event::UpdateInstalled(Err(message)) => {
                if let update::State::Installing(latest) = &s.update {
                    s.update = update::State::Available(latest.clone());
                }
                s.notice = Some(message);
            }
        }
    }
    changed |= media::absorb(s);
    changed |= preview::absorb(s);
    changed |= studio::absorb_claude(s);
    if (s.tab == Tab::Posts && s.show_drafts) || s.tab == Tab::Studio {
        preview::sync(s, fixture);
    }
    if s.tab == Tab::Studio && s.draft.is_none() && matches!(s.auth, AuthState::SignedIn { .. }) {
        studio::ensure_draft(s);
    }
    if new_data && matches!(s.auth, AuthState::SignedIn { .. }) {
        save_cache(&s.data);
    }
    if !fixture {
        studio::sync_snapshot(s);
        let wanted = if matches!(s.auth, AuthState::SignedIn { .. }) { s.queries() } else { Vec::new() };
        if wanted != s.wanted {
            let keys: Vec<String> = wanted.iter().map(QuerySpec::key).collect();
            s.data.retain(|key, _| keys.contains(key));
            s.send(Cmd::Subscribe(wanted.clone()));
            s.wanted = wanted;
        }
    }
    (changed, links)
}

fn poll(s: &mut App, _clock: f64, tx: &mut Tx) -> bool {
    let (mut changed, links) = absorb(s);
    changed |= media::tick(s, tx);
    for url in links {
        if tx.open_url(&url).is_err() {
            s.notice = Some("Could not open your browser.".into());
        }
    }
    if s.backend.is_some() {
        tx.wake_after(Duration::from_secs(30));
        if s.now - s.update_checked > 6.0 * HOUR_MS {
            s.update_checked = s.now;
            s.send(Cmd::CheckUpdate);
        }
    }
    if let update::State::Ready(relaunch) = &s.update {
        match relaunch.start() {
            Ok(()) => std::process::exit(0),
            Err(_) => {
                s.update = update::State::Current;
                s.notice = Some("BuddySocials is updated. Close it and open it again to use the new version.".into());
                changed = true;
            }
        }
    }
    changed
}

fn fetch(path: &str) -> Result<(), String> {
    let mut app = init();
    app.backend = Some(Backend::start(std::sync::Arc::new(|| {})));
    let started = std::time::Instant::now();
    let mut asked = false;
    let mut settled = 0;
    while started.elapsed() < Duration::from_secs(330) {
        std::thread::sleep(Duration::from_millis(250));
        let (_, links) = absorb(&mut app);
        for url in links {
            println!("OPEN {url}");
        }
        if let Some(notice) = app.notice.take() {
            eprintln!("NOTICE {notice}");
        }
        match app.auth {
            AuthState::SignedOut if !asked => {
                asked = true;
                app.send(Cmd::SignIn);
            }
            AuthState::SignedIn { .. } => {
                let complete = !app.wanted.is_empty() && app.wanted.iter().all(|spec| app.data.contains_key(&spec.key()));
                settled = if complete { settled + 1 } else { 0 };
                if settled >= 4 {
                    let raw = serde_json::to_vec(&app.data).map_err(|e| e.to_string())?;
                    std::fs::write(path, raw).map_err(|e| e.to_string())?;
                    println!("FETCHED {} queries", app.data.len());
                    return Ok(());
                }
            }
            _ => {}
        }
    }
    Err("timed out".into())
}

fn wait_for(app: &mut App, seconds: u64, done: impl Fn(&App) -> bool) -> bool {
    let started = std::time::Instant::now();
    while started.elapsed() < Duration::from_secs(seconds) {
        std::thread::sleep(Duration::from_millis(200));
        absorb(app);
        if let Some(notice) = app.notice.take() {
            eprintln!("NOTICE {notice}");
        }
        if done(app) {
            return true;
        }
    }
    false
}

fn check_media(path: &str) -> Result<(), String> {
    let settled = |app: &App| app.draft.as_ref().is_some_and(|draft| !media::working(draft) || draft.media.iter().any(|item| item.error.is_some()));
    let first = |app: &App| -> Result<Json, String> {
        let item = app.draft.as_ref().and_then(|draft| draft.media.first()).ok_or("the attachment is gone")?;
        match (&item.error, &item.saved) {
            (Some(error), _) => Err(error.clone()),
            (None, Some(saved)) => Ok(saved.clone()),
            (None, None) => Err("timed out".into()),
        }
    };
    let unused = |app: &App| app.query("media:cleanup", json!({})).and_then(|state| state["files"].as_f64());
    let mut app = init();
    app.backend = Some(Backend::start(std::sync::Arc::new(|| {})));
    if !wait_for(&mut app, 30, |app| matches!(app.auth, AuthState::SignedIn { .. }) && unused(app).is_some() && app.query("drafts:list", json!({})).is_some()) {
        return Err("not signed in: open the app and sign in first".into());
    }
    let before = unused(&app).unwrap_or(0.0);
    media::add(&mut app, &[std::path::PathBuf::from(path)]);
    wait_for(&mut app, 180, settled);
    let uploaded = first(&app)?;
    println!("UPLOADED {uploaded}");
    if !wait_for(&mut app, 20, |app| unused(app) == Some(before + 1.0)) {
        return Err("the upload was not counted as unused".into());
    }
    println!("UNUSED {} -> {}", before, before + 1.0);
    if app.draft.as_ref().is_some_and(|draft| draft.media[0].kind == media::Kind::Image) {
        if !media::edit_first(&mut app) {
            return Err("the editor did not open".into());
        }
        wait_for(&mut app, 180, settled);
        let edited = first(&app)?;
        if edited["storageId"] == uploaded["storageId"] {
            return Err("the edit did not produce a new file".into());
        }
        println!("EDITED {edited}");
    }
    let kept = first(&app)?;
    let draft = app.draft.take().ok_or("the draft is gone")?;
    let mut saved = pages::draft_json(&draft);
    saved["text"] = json!("media check (safe to delete)");
    app.mutate("drafts:save", saved);
    let mine = |app: &App| {
        let drafts = app.query("drafts:list", json!({}))?.as_array()?;
        drafts.iter().find(|draft| draft["text"] == "media check (safe to delete)").cloned()
    };
    if !wait_for(&mut app, 20, |app| mine(app).is_some()) {
        return Err("the draft was not saved".into());
    }
    let stored = mine(&app).ok_or("the draft is gone")?;
    if stored["media"][0]["storageId"] != kept["storageId"] || stored["media"][0]["url"].as_str().is_none() {
        return Err(format!("the saved draft has the wrong attachment: {}", stored["media"]));
    }
    println!("SAVED draft with {} attachment, issues: {}", stored["media"].as_array().map(Vec::len).unwrap_or(0), stored["targets"]);
    let expected = if kept["storageId"] == uploaded["storageId"] { before } else { before + 1.0 };
    if !wait_for(&mut app, 20, |app| unused(app) == Some(expected)) {
        return Err(format!("unused files should be {expected}, found {:?}", unused(&app)));
    }
    println!("HELD unused is {expected}");
    app.mutate("drafts:remove", json!({ "draftId": stored["_id"] }));
    if !wait_for(&mut app, 20, |app| mine(app).is_none()) {
        return Err("the draft was not deleted".into());
    }
    println!("REMOVED draft");
    if expected > before {
        app.mutate("media:cleanupNow", json!({}));
        if !wait_for(&mut app, 20, |app| unused(app) == Some(0.0)) {
            return Err("cleanup left files behind".into());
        }
        println!("CLEANED unused is 0");
    }
    Ok(())
}

/// Height of the empty band at the top of the window on macOS, where the close, minimise and zoom buttons sit.
const TITLEBAR: f32 = if cfg!(target_os = "macos") { 36.0 } else { 0.0 };

fn view(s: &App, cx: &mut Cx<App>) -> El {
    let page = match &s.auth {
        AuthState::Loading => col().w_full().h_full().fill(theme::BG),
        AuthState::SignedOut | AuthState::WaitingForBrowser => sign_in(s),
        AuthState::SignedIn { .. } => shell(s, cx),
    };
    col()
        .w_full()
        .h_full()
        .fill(theme::BG)
        .child(rune::el().key("titlebar").w_full().h(TITLEBAR).window_drag())
        .child(col().w_full().grow(1.0).min_h(0.0).child(page))
}

fn sign_in(s: &App) -> El {
    let waiting = s.auth == AuthState::WaitingForBrowser;
    let mut page = col().w_full().h_full().center().gap(20.0).fill(theme::BG);
    page = page.child(text("BUDDYSOCIALS").font(theme::display(34.0)).color(theme::FG));
    page = page.child(
        ui::button("sign-in", if waiting { "Open the browser again" } else { "Sign in" }, ui::Kind::Primary)
            .on_press(|s: &mut App| s.send(Cmd::SignIn)),
    );
    if waiting {
        page = page.child(text("Finish signing in in your browser.").font(theme::mono(13.0)).color(theme::DIM));
    }
    if let Some(notice) = &s.notice {
        page = page.child(text(notice.clone()).font(theme::mono(13.0)).color(theme::coral()));
    }
    page
}

fn shell(s: &App, cx: &mut Cx<App>) -> El {
    let page = match s.tab {
        Tab::Home => home::view(s, cx),
        Tab::Studio => studio::view(s),
        Tab::Posts => pages::posts(s),
        Tab::Inbox => pages::inbox(s),
        Tab::Goals => pages::goals(s),
        Tab::Accounts => pages::accounts(s),
    };
    let mut main = col().key("main").grow(1.0).min_w(0.0).min_h(0.0).h_full();
    if let Some(notice) = &s.notice {
        main = main.child(
            row()
                .key("notice")
                .px(24.0)
                .py(12.0)
                .gap(16.0)
                .center_y()
                .border_sides([0.0, 0.0, 2.0, 0.0], theme::coral())
                .child(text(notice.clone()).font(theme::mono(13.0)).color(theme::coral()).wrap().grow(1.0))
                .child(ui::button("dismiss-notice", "Dismiss", ui::Kind::Ghost).on_press(|s: &mut App| s.notice = None)),
        );
    }
    main = main.child(page);
    row().w_full().h_full().fill(theme::BG).child(sidebar(s)).child(rune::el().w(2.0).h_full().fill(theme::line())).child(main)
}

fn sidebar(s: &App) -> El {
    let open = s.query("comments:openSummary", json!({})).and_then(|summary| summary["count"].as_f64()).unwrap_or(0.0);
    let waiting_drafts = s
        .query("drafts:list", json!({}))
        .and_then(Json::as_array)
        .map(|drafts| drafts.iter().filter(|d| d["status"] != "published").count())
        .unwrap_or(0);
    let mut nav = col().key("nav").w(184.0).h_full();
    for tab in Tab::ALL {
        let active = s.tab == tab;
        let ink = if active { theme::BG } else { theme::FG };
        let mut item = row()
            .key(format!("tab-{}", tab.label().to_lowercase()))
            .role("tab")
            .label(tab.label())
            .h(48.0)
            .px(20.0)
            .gap(8.0)
            .center_y()
            .fill(if active { theme::coral() } else { theme::BG })
            .cursor(rune::Cursor::Pointer)
            .on_press(move |s: &mut App| {
                s.tab = tab;
                if tab == Tab::Studio {
                    studio::ensure_draft(s);
                }
            })
            .child(text(tab.label().to_uppercase()).font(theme::label(12.0)).color(ink));
        if tab == Tab::Studio && waiting_drafts > 0 {
            item = item.child(text(format!("{waiting_drafts}")).font(theme::label(11.0)).color(if active { theme::BG } else { theme::coral() }));
        }
        if tab == Tab::Inbox && open > 0.0 {
            let count = if open >= 100.0 { "99+".to_string() } else { format!("{open}") };
            item = item.child(text(count).font(theme::label(11.0)).color(if active { theme::BG } else { theme::coral() }));
        }
        nav = nav.child(item);
    }
    let last = s.accounts().iter().filter_map(|account| account["lastSyncedAt"].as_f64()).fold(0.0, f64::max);
    let status = if s.syncing() {
        "Syncing".to_string()
    } else if last > 0.0 {
        format!("Updated {}", fmt::relative_time(last, s.now))
    } else {
        String::new()
    };
    let mut foot = col().padding(20.0).gap(12.0).items_start();
    match &s.update {
        update::State::Available(latest) => {
            let latest = latest.clone();
            foot = foot.child(text("NEW VERSION").key("update-status").font(theme::label(10.0)).color(theme::coral())).child(
                ui::button("update", "Update", ui::Kind::Primary).on_press(move |s: &mut App| {
                    s.update = update::State::Installing(latest.clone());
                    s.send(Cmd::InstallUpdate(latest.clone()));
                }),
            );
        }
        update::State::Installing(_) | update::State::Ready(_) => {
            foot = foot.child(text("UPDATING…").key("update-status").font(theme::label(10.0)).color(theme::coral()));
        }
        update::State::Current => {}
    }
    nav.child(col().grow(1.0)).child(
        foot.child(text(status.to_uppercase()).key("sync-status").font(theme::label(10.0)).color(theme::DIM))
            .child(ui::button("refresh", "Refresh", ui::Kind::Outline).on_press(|s: &mut App| s.mutate("accounts:syncNow", json!({})))),
    )
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if let Some(path) = args.iter().position(|arg| arg == "--fetch").and_then(|at| args.get(at + 1)) {
        if let Err(error) = fetch(path) {
            eprintln!("fetch failed: {error}");
            std::process::exit(1);
        }
        return;
    }
    if args.iter().any(|arg| arg == "--update") {
        if let Err(error) = update::run_from_terminal() {
            eprintln!("update failed: {error}");
            std::process::exit(1);
        }
        return;
    }
    if let Some(path) = args.iter().position(|arg| arg == "--check-media").and_then(|at| args.get(at + 1)) {
        if let Err(error) = check_media(path) {
            eprintln!("media check failed: {error}");
            std::process::exit(1);
        }
        return;
    }
    rune::run(AppSpec::<App> {
        min_size: Some((860.0, 560.0)),
        fonts: &[
            include_bytes!("../../assets/fonts/IBMPlexMono-Regular.ttf"),
            include_bytes!("../../assets/fonts/IBMPlexMono-Bold.ttf"),
            include_bytes!("../../assets/fonts/ChakraPetch-Bold.ttf"),
        ],
        families: ("IBM Plex Mono", "IBM Plex Mono"),
        scenes: &[
            ("studio", studio::sample_scene),
            ("posts", |s| s.tab = Tab::Posts),
            ("drafts", |s| {
                s.tab = Tab::Posts;
                s.show_drafts = true;
                preview::sync(s, true);
            }),
            ("draft-editor", studio::sample_scene),
            ("media-editor", |s| {
                s.tab = Tab::Studio;
                let accounts = s.accounts().iter().filter(|a| a["platform"] == "linkedin" || a["platform"] == "x").filter_map(|a| a["_id"].as_str().map(str::to_string)).collect();
                s.draft = Some(DraftEdit::new(None, "Shipping the desktop app this week. Same dashboard, bigger screen.", accounts));
                media::sample(s);
            }),
            ("draft-media", |s| {
                s.tab = Tab::Studio;
                let accounts = s.accounts().iter().filter(|a| a["platform"] == "linkedin" || a["platform"] == "x").filter_map(|a| a["_id"].as_str().map(str::to_string)).collect();
                s.draft = Some(DraftEdit::new(None, "Shipping the desktop app this week. Same dashboard, bigger screen.", accounts));
                media::sample(s);
                if let Some(draft) = &mut s.draft {
                    draft.editing = None;
                }
            }),
            ("chart-hover", |s| {
                let first = s.query("layouts:get", json!({})).and_then(Json::as_array).and_then(|widgets| widgets.iter().find(|w| w["type"] == "mix")).and_then(|w| w["id"].as_str()).map(str::to_string);
                s.hover = first.map(|id| (id, 0.3));
            }),
            ("inbox", |s| s.tab = Tab::Inbox),
            ("goals", |s| s.tab = Tab::Goals),
            ("accounts", |s| s.tab = Tab::Accounts),
            ("signed-out", |s| s.auth = AuthState::SignedOut),
            ("update", |s| {
                s.update = update::State::Available(update::Latest { version: "0.1.0".into(), url: String::new(), file_sha256: String::new(), program_sha256: String::new() });
            }),
        ],
        setup: Some(setup),
        poll: Some(poll),
        ..AppSpec::new("BuddySocials", (1280.0, 800.0), init, view)
    });
}

/// Milliseconds in the last `days` days, for queries bounded by a range.
pub fn days_ms(days: f64) -> f64 {
    days * DAY_MS
}
