//! Sign-in with Clerk over OAuth: authorization code with PKCE and a one-shot
//! loopback listener. The session lives in the OS keychain, never in a file.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::config;

const KEYCHAIN_SERVICE: &str = "BuddySocials Desktop";
const KEYCHAIN_ACCOUNT: &str = "session";
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Clone, Serialize, Deserialize)]
pub struct Session {
    /// The OpenID token Convex verifies. Its audience is this app's client ID.
    pub id_token: String,
    pub refresh_token: Option<String>,
    /// Unix seconds.
    pub expires_at: u64,
    pub email: Option<String>,
}

impl Session {
    pub fn seconds_left(&self) -> i64 {
        self.expires_at as i64 - now_secs() as i64
    }
}

/// The sign-in service refused the request: the session was revoked or has expired.
#[derive(Debug)]
pub struct Rejected;

impl std::fmt::Display for Rejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Sign in again to continue.")
    }
}

impl std::error::Error for Rejected {}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn keychain() -> Result<keyring::Entry> {
    Ok(keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)?)
}

/// macOS ties a keychain item to the binary that wrote it and asks again after every rebuild.
/// Debug builds are rebuilt constantly, so they keep the session in a file only the user can read.
fn dev_file() -> Option<std::path::PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let home = std::env::var_os("HOME")?;
    Some(std::path::PathBuf::from(home).join("Library/Application Support/BuddySocials/dev-session.json"))
}

pub fn load() -> Option<Session> {
    let raw = match dev_file() {
        Some(path) => std::fs::read_to_string(path).ok()?,
        None => keychain().ok()?.get_password().ok()?,
    };
    serde_json::from_str(&raw).ok()
}

pub fn save(session: &Session) -> Result<()> {
    let raw = serde_json::to_string(session)?;
    let Some(path) = dev_file() else {
        keychain()?.set_password(&raw)?;
        return Ok(());
    };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&path, raw)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

pub fn clear() {
    match dev_file() {
        Some(path) => {
            let _ = std::fs::remove_file(path);
        }
        None => {
            if let Ok(entry) = keychain() {
                let _ = entry.delete_credential();
            }
        }
    }
}

fn random_token(bytes: usize) -> String {
    let raw: Vec<u8> = (0..bytes).map(|_| rand::random::<u8>()).collect();
    URL_SAFE_NO_PAD.encode(raw)
}

/// A sign-in the browser has been sent to but hasn't come back from yet.
pub struct Pending {
    listener: TcpListener,
    verifier: String,
    state: String,
    redirect_uri: String,
    pub url: String,
}

pub async fn begin() -> Result<Pending> {
    let listener = TcpListener::bind("127.0.0.1:0").await.context("could not open a local port for sign-in")?;
    let port = listener.local_addr()?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");
    let verifier = random_token(48);
    let state = random_token(24);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let mut url = url::Url::parse(&format!("{}/oauth/authorize", config::clerk_issuer()))?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &config::clerk_client_id())
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("scope", "openid profile email offline_access")
        .append_pair("state", &state)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256");
    Ok(Pending { listener, verifier, state, redirect_uri, url: url.into() })
}

fn reply_page(message: &str) -> String {
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>BuddySocials</title><body style=\"margin:0;height:100vh;display:grid;place-items:center;background:#000;color:#fff;font:16px/1.5 ui-monospace,Menlo,monospace\"><p style=\"max-width:32ch;padding:24px;border:2px solid #292929\">{message}</p>"
    );
    format!("HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}", body.len(), body)
}

/// Waits for the browser to land on the loopback address, then trades the code for a session.
pub async fn finish(pending: Pending) -> Result<Session> {
    let code = tokio::time::timeout(SIGN_IN_TIMEOUT, wait_for_code(&pending))
        .await
        .map_err(|_| anyhow!("Sign-in timed out. Try again."))??;
    exchange(&[
        ("grant_type", "authorization_code"),
        ("code", &code),
        ("redirect_uri", &pending.redirect_uri),
        ("client_id", &config::clerk_client_id()),
        ("code_verifier", &pending.verifier),
    ], None)
    .await
}

async fn wait_for_code(pending: &Pending) -> Result<String> {
    loop {
        let (mut stream, _) = pending.listener.accept().await?;
        let mut buffer = vec![0u8; 8192];
        let read = stream.read(&mut buffer).await.unwrap_or(0);
        let request = String::from_utf8_lossy(&buffer[..read]);
        let path = request.lines().next().and_then(|line| line.split_whitespace().nth(1)).unwrap_or("");
        // Browsers also ask for a favicon; only the callback path ends the wait.
        if !path.starts_with("/callback") {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").await;
            continue;
        }
        let url = url::Url::parse(&format!("http://127.0.0.1{path}"))?;
        let param = |name: &str| url.query_pairs().find(|(key, _)| key == name).map(|(_, value)| value.into_owned());
        let outcome = match (param("code"), param("state"), param("error")) {
            (_, _, Some(_)) => Err(anyhow!("Sign-in was cancelled.")),
            (Some(code), Some(state), None) if state == pending.state => Ok(code),
            _ => Err(anyhow!("Sign-in did not complete. Try again.")),
        };
        let message = match &outcome {
            Ok(_) => "You're signed in. You can close this tab and go back to BuddySocials.".to_string(),
            Err(error) => error.to_string(),
        };
        let _ = stream.write_all(reply_page(&message).as_bytes()).await;
        let _ = stream.shutdown().await;
        return outcome;
    }
}

/// A new session from the refresh token. Fails when the session was revoked or has expired.
pub async fn refresh(session: &Session) -> Result<Session> {
    let Some(refresh_token) = session.refresh_token.as_deref() else { bail!("no refresh token") };
    exchange(
        &[("grant_type", "refresh_token"), ("refresh_token", refresh_token), ("client_id", &config::clerk_client_id())],
        Some(session),
    )
    .await
}

#[derive(Deserialize)]
struct TokenResponse {
    id_token: Option<String>,
    refresh_token: Option<String>,
}

#[derive(Deserialize)]
struct Claims {
    exp: u64,
    email: Option<String>,
}

fn claims(id_token: &str) -> Result<Claims> {
    let payload = id_token.split('.').nth(1).ok_or_else(|| anyhow!("malformed token"))?;
    Ok(serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload.trim_end_matches('='))?)?)
}

async fn exchange(form: &[(&str, &str)], previous: Option<&Session>) -> Result<Session> {
    let response = reqwest::Client::new()
        .post(format!("{}/oauth/token", config::clerk_issuer()))
        .form(form)
        .send()
        .await
        .context("could not reach the sign-in service")?;
    if response.status().is_client_error() {
        return Err(Rejected.into());
    }
    if !response.status().is_success() {
        bail!("The sign-in service is having trouble. Try again.");
    }
    let tokens: TokenResponse = response.json().await?;
    let id_token = tokens.id_token.ok_or_else(|| anyhow!("the sign-in service sent no identity token"))?;
    let claims = claims(&id_token)?;
    Ok(Session {
        id_token,
        refresh_token: tokens.refresh_token.or_else(|| previous.and_then(|s| s.refresh_token.clone())),
        expires_at: claims.exp,
        email: claims.email.or_else(|| previous.and_then(|s| s.email.clone())),
    })
}
