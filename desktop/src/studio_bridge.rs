//! Loopback MCP server for the embedded Claude Code collaborator.
//!
//! Spins up a localhost-only HTTP JSON-RPC 2.0 endpoint authenticated with a random
//! per-launch bearer token and passed to `claude --mcp-config`. That lets Claude Code
//! read live Studio state (accounts, drafts, recent posts, comments), update the
//! open draft right inside the window, upload local media/covers directly to Convex,
//! schedule posts, and publish — with zero extra login or external MCP setup.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use convex::{ConvexClient, FunctionResult, Value};
use serde_json::{Value as Json, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::backend::{self, Event, Out};

const PROTOCOL_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

/// Live state mirrored from the UI thread so Claude Code can read it immediately.
#[derive(Clone, Default)]
pub struct Snapshot {
    pub accounts: Json,
    pub drafts: Json,
    pub posts: Json,
    pub comments: Json,
    pub active_draft: Option<ActiveDraftSnapshot>,
}

#[derive(Clone, Debug)]
pub struct ActiveDraftSnapshot {
    pub id: Option<String>,
    pub title: String,
    pub text: String,
    pub platform_text: HashMap<String, String>,
    pub youtube_visibility: String,
    pub accounts: Vec<String>,
    pub media: Vec<Json>,
    pub cover_storage_id: Option<String>,
}

/// Live update applied straight back into the Studio editor when Claude edits or creates a draft.
#[derive(Clone, Debug)]
pub struct DraftPatch {
    pub draft_id: String,
    pub title: Option<String>,
    pub text: String,
    pub platform_text: HashMap<String, String>,
    pub youtube_visibility: String,
    pub accounts: Vec<String>,
    pub open_if_different: bool,
}

#[derive(Clone)]
pub struct BridgeInfo {
    pub url: String,
    pub token: String,
}

impl BridgeInfo {
    /// Inline `--mcp-config` JSON passed to `claude`.
    pub fn mcp_config_json(&self) -> String {
        json!({
            "mcpServers": {
                "buddysocials": {
                    "type": "http",
                    "url": self.url,
                    "headers": {
                        "Authorization": format!("Bearer {}", self.token)
                    }
                }
            }
        })
        .to_string()
    }
}

fn random_token() -> String {
    let raw: Vec<u8> = (0..32).map(|_| rand::random::<u8>()).collect();
    URL_SAFE_NO_PAD.encode(raw)
}

pub async fn start(client: ConvexClient, snapshot: Arc<Mutex<Snapshot>>, out: Out) -> Option<BridgeInfo> {
    let listener = TcpListener::bind("127.0.0.1:0").await.ok()?;
    let port = listener.local_addr().ok()?.port();
    let token = random_token();
    let info = BridgeInfo { url: format!("http://127.0.0.1:{port}/mcp"), token: token.clone() };
    let out_ready = out.clone();
    out_ready.push(Event::BridgeReady(info.clone()));

    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else { continue };
            let client = client.clone();
            let snapshot = snapshot.clone();
            let out = out.clone();
            let token = token.clone();
            tokio::spawn(async move {
                let _ = handle_connection(stream, client, snapshot, out, token).await;
            });
        }
    });
    Some(info)
}

async fn read_http(stream: &mut TcpStream) -> Option<(String, String, HashMap<String, String>, Vec<u8>)> {
    let mut buf = Vec::with_capacity(4096);
    let mut tmp = [0u8; 4096];
    let header_end = loop {
        let n = stream.read(&mut tmp).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
        if buf.len() > 64 * 1024 {
            return None;
        }
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).into_owned();
    let mut lines = head.split("\r\n");
    let first = lines.next()?;
    let mut parts = first.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    let content_len: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    if content_len > 8 * 1024 * 1024 {
        return None;
    }
    let mut body = buf[header_end..].to_vec();
    while body.len() < content_len {
        let n = stream.read(&mut tmp).await.ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&tmp[..n]);
    }
    body.truncate(content_len);
    Some((method, path, headers, body))
}

async fn write_http(stream: &mut TcpStream, status: &str, body: &[u8], extra: &str) {
    let head = format!(
        "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n{extra}\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes()).await;
    if !body.is_empty() {
        let _ = stream.write_all(body).await;
    }
    let _ = stream.shutdown().await;
}

async fn handle_connection(
    mut stream: TcpStream,
    client: ConvexClient,
    snapshot: Arc<Mutex<Snapshot>>,
    out: Out,
    token: String,
) -> anyhow::Result<()> {
    let Some((method, path, headers, body)) = read_http(&mut stream).await else { return Ok(()) };
    if method == "OPTIONS" {
        write_http(&mut stream, "204 No Content", b"", "allow: POST, OPTIONS\r\n").await;
        return Ok(());
    }
    if path != "/mcp" {
        write_http(&mut stream, "404 Not Found", b"{\"error\":\"not found\"}", "").await;
        return Ok(());
    }
    let auth = headers.get("authorization").map(String::as_str).unwrap_or("");
    let bearer = auth.strip_prefix("Bearer ").or_else(|| auth.strip_prefix("bearer ")).unwrap_or("");
    if bearer != token {
        write_http(&mut stream, "401 Unauthorized", b"{\"error\":\"unauthorized\"}", "").await;
        return Ok(());
    }
    if method == "GET" {
        write_http(&mut stream, "405 Method Not Allowed", b"", "allow: POST, OPTIONS\r\n").await;
        return Ok(());
    }
    if method != "POST" {
        write_http(&mut stream, "405 Method Not Allowed", b"", "allow: POST, OPTIONS\r\n").await;
        return Ok(());
    }
    let Ok(parsed) = serde_json::from_slice::<Json>(&body) else {
        let err = json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "Parse error." } });
        write_http(&mut stream, "400 Bad Request", err.to_string().as_bytes(), "").await;
        return Ok(());
    };
    if let Some(array) = parsed.as_array() {
        let mut answers = Vec::new();
        for item in array {
            if let Some(reply) = answer(item, &client, &snapshot, &out).await {
                answers.push(reply);
            }
        }
        if answers.is_empty() {
            write_http(&mut stream, "202 Accepted", b"", "").await;
        } else {
            let bytes = serde_json::to_vec(&answers).unwrap_or_default();
            write_http(&mut stream, "200 OK", &bytes, "").await;
        }
        return Ok(());
    }
    match answer(&parsed, &client, &snapshot, &out).await {
        Some(reply) => {
            let bytes = serde_json::to_vec(&reply).unwrap_or_default();
            write_http(&mut stream, "200 OK", &bytes, "").await;
        }
        None => write_http(&mut stream, "202 Accepted", b"", "").await,
    }
    Ok(())
}

fn tools_schema() -> Json {
    json!([
        {
            "name": "studio_get_context",
            "description": "Returns the currently open draft in BuddySocials Studio (title, core text, per-platform copy overrides, media, cover, targets, YouTube visibility), all connected accounts, and all saved drafts.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "studio_list_posts",
            "description": "Lists recent published posts with views, likes, comments, shares, and text so you can match the creator's voice and see what performs best.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "platform": { "type": "string", "enum": ["youtube", "instagram", "tiktok", "x", "linkedin", "facebook"] },
                    "limit": { "type": "number" }
                },
                "additionalProperties": false
            }
        },
        {
            "name": "studio_list_comments",
            "description": "Lists recent open audience comments across platforms for content ideas or follow-up posts.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "limit": { "type": "number" }
                },
                "additionalProperties": false
            }
        },
        {
            "name": "studio_update_draft",
            "description": "Creates a new draft or updates the open/specified draft in BuddySocials Studio AND saves it to Convex. The live editor and platform previews in the window update immediately. Use platform_text to tailor copy per platform (e.g. <=280 chars for x, longer for linkedin/instagram/youtube).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "draft_id": { "type": "string", "description": "Optional draft ID. Omit to update the currently open Studio draft (or create one if none is saved yet)." },
                    "new_draft": { "type": "boolean", "description": "Set true to always create a brand new draft and open it in Studio." },
                    "title": { "type": ["string", "null"], "description": "Working title and YouTube video title (<=100 chars for YouTube)." },
                    "text": { "type": "string", "description": "Core post text." },
                    "platform_text": {
                        "type": ["object", "null"],
                        "additionalProperties": { "type": "string" },
                        "description": "Optional per-platform overrides keyed by x, linkedin, facebook, instagram, tiktok, youtube."
                    },
                    "youtube_visibility": { "type": ["string", "null"], "enum": ["public", "unlisted", "private", null] },
                    "account_ids": { "type": "array", "items": { "type": "string" }, "description": "Target account IDs from studio_get_context." }
                },
                "required": ["text"],
                "additionalProperties": false
            }
        },
        {
            "name": "studio_open_draft",
            "description": "Switches the Studio editor to show an existing saved draft by draft_id.",
            "inputSchema": {
                "type": "object",
                "properties": { "draft_id": { "type": "string" } },
                "required": ["draft_id"],
                "additionalProperties": false
            }
        },
        {
            "name": "studio_attach_local_file",
            "description": "Uploads an image (PNG/JPEG/WebP/GIF) or MP4/MOV video from the local machine to Convex storage and attaches it to the open Studio draft (or sets it as the video cover when as_cover is true).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute local file path on disk." },
                    "as_cover": { "type": "boolean", "description": "Set true to attach a JPEG image as the video thumbnail/Reel cover instead of media." }
                },
                "required": ["path"],
                "additionalProperties": false
            }
        },
        {
            "name": "studio_schedule_draft",
            "description": "Schedules the active (or named) draft to publish automatically at a future ISO-8601 timestamp (e.g. '2026-11-23T15:00:00Z'), or pass null to cancel its schedule.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "draft_id": { "type": "string", "description": "Omit to use the currently open Studio draft." },
                    "scheduled_for": { "type": ["string", "number", "null"], "description": "ISO-8601 timestamp, Unix ms, or null to cancel." }
                },
                "required": ["scheduled_for"],
                "additionalProperties": false
            }
        },
        {
            "name": "studio_publish_draft",
            "description": "Publishes the active (or named) draft directly to its selected social accounts. Only call when the user explicitly asked to publish now.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "draft_id": { "type": "string", "description": "Omit to use the currently open Studio draft." },
                    "account_ids": { "type": "array", "items": { "type": "string" }, "description": "Optional subset of target account IDs to publish or retry." }
                },
                "additionalProperties": false
            }
        },
        {
            "name": "studio_update_youtube_video",
            "description": "Changes an already-uploaded YouTube video's visibility (public, unlisted, private), title, or description.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "account_id": { "type": "string" },
                    "video_id": { "type": "string" },
                    "visibility": { "type": "string", "enum": ["public", "unlisted", "private"] },
                    "title": { "type": "string" },
                    "description": { "type": "string" }
                },
                "required": ["account_id", "video_id"],
                "additionalProperties": false
            }
        }
    ])
}

async fn answer(msg: &Json, client: &ConvexClient, snapshot: &Arc<Mutex<Snapshot>>, out: &Out) -> Option<Json> {
    let id = msg.get("id")?;
    let method = msg.get("method").and_then(Json::as_str).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));
    match method {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(Json::as_str).unwrap_or("");
            let version = if PROTOCOL_VERSIONS.contains(&asked) { asked } else { PROTOCOL_VERSIONS[0] };
            Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": version,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "buddysocials-studio", "version": "1.0.0" }
                }
            }))
        }
        "ping" => Some(json!({ "jsonrpc": "2.0", "id": id, "result": {} })),
        "tools/list" => Some(json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": tools_schema() } })),
        "tools/call" => {
            let name = params.get("name").and_then(Json::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            match call_tool(name, &args, client, snapshot, out).await {
                Ok(result) => Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": { "content": [{ "type": "text", "text": result.to_string() }], "isError": false }
                })),
                Err(error) => Some(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": { "content": [{ "type": "text", "text": error }], "isError": true }
                })),
            }
        }
        _ => Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "Method not found." } })),
    }
}

async fn call_tool(
    name: &str,
    args: &Json,
    client: &ConvexClient,
    snapshot: &Arc<Mutex<Snapshot>>,
    out: &Out,
) -> Result<Json, String> {
    let mut client = client.clone();
    match name {
        "studio_get_context" => {
            let snap = snapshot.lock().unwrap().clone();
            let active = snap.active_draft.map(|d| {
                json!({
                    "draft_id": d.id,
                    "title": d.title,
                    "text": d.text,
                    "platform_text": d.platform_text,
                    "youtube_visibility": d.youtube_visibility,
                    "account_ids": d.accounts,
                    "media": d.media,
                    "cover_storage_id": d.cover_storage_id,
                })
            });
            Ok(json!({
                "active_draft": active,
                "accounts": snap.accounts,
                "drafts": snap.drafts,
            }))
        }
        "studio_list_posts" => {
            let snap = snapshot.lock().unwrap().clone();
            let platform = args.get("platform").and_then(Json::as_str);
            let limit = args.get("limit").and_then(Json::as_u64).unwrap_or(20).clamp(1, 50) as usize;
            let posts: Vec<Json> = snap
                .posts
                .as_array()
                .into_iter()
                .flatten()
                .filter(|post| platform.is_none_or(|p| post["platform"].as_str() == Some(p)))
                .take(limit)
                .cloned()
                .collect();
            Ok(json!(posts))
        }
        "studio_list_comments" => {
            let snap = snapshot.lock().unwrap().clone();
            let limit = args.get("limit").and_then(Json::as_u64).unwrap_or(25).clamp(1, 50) as usize;
            let comments: Vec<Json> = snap.comments.as_array().into_iter().flatten().take(limit).cloned().collect();
            Ok(json!(comments))
        }
        "studio_open_draft" => {
            let id = args.get("draft_id").and_then(Json::as_str).ok_or("draft_id is required.")?;
            out.push(Event::StudioOpenDraft(id.to_string()));
            Ok(json!({ "opened": id }))
        }
        "studio_update_draft" => {
            let snap = snapshot.lock().unwrap().clone();
            let new_draft = args.get("new_draft").and_then(Json::as_bool).unwrap_or(false);
            let text = args.get("text").and_then(Json::as_str).ok_or("text is required.")?.to_string();
            let existing = if new_draft { None } else { snap.active_draft.clone() };
            let explicit_id = if new_draft {
                None
            } else {
                args.get("draft_id").and_then(Json::as_str).map(str::to_string).or_else(|| existing.as_ref().and_then(|d| d.id.clone()))
            };
            let accounts: Vec<String> = if let Some(arr) = args.get("account_ids").and_then(Json::as_array) {
                arr.iter().filter_map(Json::as_str).map(str::to_string).collect()
            } else if let Some(active) = &existing {
                active.accounts.clone()
            } else {
                Vec::new()
            };
            let title: Option<String> = match args.get("title") {
                Some(Json::Null) => None,
                Some(Json::String(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
                Some(Json::String(_)) => None,
                _ => existing.as_ref().map(|d| d.title.clone()).filter(|t| !t.trim().is_empty()),
            };
            let platform_text: HashMap<String, String> = match args.get("platform_text") {
                Some(Json::Null) => HashMap::new(),
                Some(Json::Object(map)) => map
                    .iter()
                    .filter_map(|(k, v)| v.as_str().filter(|s| !s.trim().is_empty()).map(|s| (k.clone(), s.to_string())))
                    .collect(),
                _ => existing.as_ref().map(|d| d.platform_text.clone()).unwrap_or_default(),
            };
            let youtube_visibility = match args.get("youtube_visibility") {
                Some(Json::String(s)) => s.clone(),
                Some(Json::Null) => "unlisted".to_string(),
                _ => existing.as_ref().map(|d| d.youtube_visibility.clone()).unwrap_or_else(|| "unlisted".to_string()),
            };

            let mut payload = json!({
                "text": text,
                "accountIds": accounts,
                "title": title,
                "platformText": if platform_text.is_empty() { Json::Null } else { json!(platform_text) },
                "youtubeVisibility": youtube_visibility,
            });
            if let Some(id) = &explicit_id {
                payload["draftId"] = json!(id);
            }
            if let Some(active) = &existing {
                if !active.media.is_empty() && explicit_id.is_none() {
                    payload["media"] = json!(active.media);
                }
                if let Some(cover_id) = &active.cover_storage_id {
                    if explicit_id.is_none() {
                        payload["cover"] = json!(cover_id);
                    }
                }
            }
            let saved = client.mutation("drafts:save", backend::args_of(&payload.to_string())).await.map_err(|_| "Could not save draft.".to_string())?;
            let draft_id = match saved {
                FunctionResult::Value(Value::String(id)) => id,
                other => return Err(backend::failure(&other).unwrap_or_else(|| "Could not save draft.".into())),
            };
            out.push(Event::StudioApplyDraft(DraftPatch {
                draft_id: draft_id.clone(),
                title,
                text,
                platform_text,
                youtube_visibility,
                accounts,
                open_if_different: new_draft || explicit_id.is_none(),
            }));
            Ok(json!({ "draft_id": draft_id, "updated": true }))
        }
        "studio_attach_local_file" => {
            let path_str = args.get("path").and_then(Json::as_str).ok_or("path is required.")?;
            let as_cover = args.get("as_cover").and_then(Json::as_bool).unwrap_or(false);
            let path = PathBuf::from(path_str);
            if !path.is_file() {
                return Err(format!("File not found: {path_str}"));
            }
            let (kind, mime) = crate::media::classify(&path).ok_or("Only PNG, JPEG, WebP, GIF images and MP4/MOV videos are supported.")?;
            if as_cover && kind != crate::media::Kind::Image {
                return Err("A cover must be an image.".into());
            }
            let (upload_path, upload_mime, upload_name) = if as_cover {
                let jpeg = crate::media::prepare_cover_jpeg(&path)?;
                (jpeg, "image/jpeg", "cover.jpg".to_string())
            } else {
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("attachment").to_string();
                (path.clone(), mime, name)
            };
            let uploaded = backend::upload(&mut client, &upload_path, upload_mime, &upload_name).await?;
            out.push(Event::StudioAttachUploaded { path: upload_path, record: uploaded.clone(), as_cover });
            Ok(json!({ "attached": true, "as_cover": as_cover, "media": uploaded }))
        }
        "studio_schedule_draft" => {
            let snap = snapshot.lock().unwrap().clone();
            let draft_id = args
                .get("draft_id")
                .and_then(Json::as_str)
                .map(str::to_string)
                .or_else(|| snap.active_draft.as_ref().and_then(|d| d.id.clone()))
                .ok_or("Save the draft first or pass draft_id.")?;
            let sched = args.get("scheduled_for").ok_or("scheduled_for is required.")?;
            if sched.is_null() {
                let res = client
                    .mutation("drafts:cancelSchedule", backend::args_of(&json!({ "draftId": draft_id }).to_string()))
                    .await
                    .map_err(|_| "Could not cancel schedule.".to_string())?;
                if let Some(err) = backend::failure(&res) {
                    return Err(err);
                }
                return Ok(json!({ "draft_id": draft_id, "scheduled_for": null }));
            }
            let at = if let Some(ms) = sched.as_f64() {
                ms
            } else if let Some(s) = sched.as_str() {
                crate::fmt::parse_schedule(s, crate::fmt::now_ms()).ok_or("Invalid timestamp. Use ISO-8601 like 2026-11-23T15:00:00Z.")?
            } else {
                return Err("scheduled_for must be an ISO-8601 string, Unix ms, or null.".into());
            };
            let res = client
                .mutation("drafts:schedule", backend::args_of(&json!({ "draftId": draft_id, "at": at }).to_string()))
                .await
                .map_err(|_| "Could not schedule draft.".to_string())?;
            if let Some(err) = backend::failure(&res) {
                return Err(err);
            }
            Ok(json!({ "draft_id": draft_id, "scheduled_for": at, "formatted": crate::fmt::format_datetime(at) }))
        }
        "studio_publish_draft" => {
            let snap = snapshot.lock().unwrap().clone();
            let draft_id = args
                .get("draft_id")
                .and_then(Json::as_str)
                .map(str::to_string)
                .or_else(|| snap.active_draft.as_ref().and_then(|d| d.id.clone()))
                .ok_or("Save the draft first or pass draft_id.")?;
            let mut payload = json!({ "draftId": draft_id });
            if let Some(ids) = args.get("account_ids").and_then(Json::as_array) {
                payload["accountIds"] = json!(ids);
            }
            let res = client
                .mutation("drafts:publish", backend::args_of(&payload.to_string()))
                .await
                .map_err(|_| "Could not publish draft.".to_string())?;
            if let Some(err) = backend::failure(&res) {
                return Err(err);
            }
            Ok(json!({ "draft_id": draft_id, "publishing": true, "note": "Publishing queued. Check studio_get_context for delivery status." }))
        }
        "studio_update_youtube_video" => {
            let account_id = args.get("account_id").and_then(Json::as_str).ok_or("account_id is required.")?;
            let video_id = args.get("video_id").and_then(Json::as_str).ok_or("video_id is required.")?;
            let mut payload = json!({ "accountId": account_id, "videoId": video_id });
            if let Some(vis) = args.get("visibility").and_then(Json::as_str) {
                payload["visibility"] = json!(vis);
            }
            if let Some(title) = args.get("title").and_then(Json::as_str) {
                payload["title"] = json!(title);
            }
            if let Some(desc) = args.get("description").and_then(Json::as_str) {
                payload["description"] = json!(desc);
            }
            let res = client
                .action("publish:updateYouTubePost", backend::args_of(&payload.to_string()))
                .await
                .map_err(|_| "Could not update YouTube video.".to_string())?;
            if let Some(err) = backend::failure(&res) {
                return Err(err);
            }
            Ok(json!({ "updated": true, "video_id": video_id }))
        }
        _ => Err(format!("Unknown tool: {name}")),
    }
}
