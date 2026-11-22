//! Embedded Claude Code runtime, mirroring how T3 Code integrates Claude Code:
//! spawns the local `claude` CLI with `--output-format stream-json --input-format stream-json
//! --verbose --include-partial-messages`, resumes conversations with `--resume <session_id>`,
//! injects BuddySocials's loopback MCP bridge (`--mcp-config`), streams text deltas and tool
//! activity live into the Rune UI, and persists threads on disk.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::oneshot;

use crate::config;
use crate::studio_bridge::BridgeInfo;

const SYSTEM_PROMPT: &str = "\
You are embedded inside BuddySocials Studio, helping the creator go effortlessly from raw idea to ready-to-publish multi-platform posts.
You have direct BuddySocials Studio MCP tools (`studio_get_context`, `studio_update_draft`, `studio_open_draft`, `studio_attach_local_file`, `studio_list_posts`, `studio_list_comments`, `studio_schedule_draft`, `studio_publish_draft`, `studio_update_youtube_video`) plus your local Claude Code tools.

Workflow:
1. Call `studio_get_context` first to see the open draft, connected accounts, and existing drafts. Optionally check `studio_list_posts` to match the creator's voice.
2. When writing or refining a post, immediately call `studio_update_draft` so the live editor and platform previews update side-by-side in front of the user.
3. Tailor copy per platform using `platform_text` whenever multiple platforms are selected (keep X <= 280 chars, LinkedIn crisp & scannable, Instagram engaging with media, YouTube title <= 100 chars + clear description).
4. If the user references a local image, screenshot, or video (or asks you to find/generate one), attach it directly with `studio_attach_local_file` (or `as_cover: true` for a video thumbnail/Reel cover).
5. Keep replies tight and actionable. Never call `studio_publish_draft` unless the user explicitly tells you to publish right now — otherwise save the draft so they can inspect the live previews and click Publish or Schedule.";

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum Model {
    Opus,
    Sonnet,
    Haiku,
}

impl Default for Model {
    fn default() -> Self {
        Model::Opus
    }
}

impl Model {
    pub fn next(self) -> Self {
        match self {
            Model::Opus => Model::Sonnet,
            Model::Sonnet => Model::Haiku,
            Model::Haiku => Model::Opus,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Model::Opus => "Opus 5.5",
            Model::Sonnet => "Sonnet 5.5",
            Model::Haiku => "Haiku 5.5",
        }
    }

    pub fn cli_name(self) -> &'static str {
        match self {
            Model::Opus => "claude-opus-5-5",
            Model::Sonnet => "claude-sonnet-5-5",
            Model::Haiku => "claude-haiku-5-5",
        }
    }
}

/// Claude Code's `--effort` level for the session.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum Effort {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl Default for Effort {
    fn default() -> Self {
        Effort::Medium
    }
}

impl Effort {
    pub fn next(self) -> Self {
        match self {
            Effort::Low => Effort::Medium,
            Effort::Medium => Effort::High,
            Effort::High => Effort::Xhigh,
            Effort::Xhigh => Effort::Max,
            Effort::Max => Effort::Low,
        }
    }

    pub fn cli_name(self) -> &'static str {
        match self {
            Effort::Low => "low",
            Effort::Medium => "medium",
            Effort::High => "high",
            Effort::Xhigh => "xhigh",
            Effort::Max => "max",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum PermissionMode {
    Auto,
    AcceptEdits,
    Plan,
    Bypass,
}

impl Default for PermissionMode {
    fn default() -> Self {
        PermissionMode::Bypass
    }
}

impl PermissionMode {
    pub fn next(self) -> Self {
        match self {
            PermissionMode::Auto => PermissionMode::AcceptEdits,
            PermissionMode::AcceptEdits => PermissionMode::Plan,
            PermissionMode::Plan => PermissionMode::Bypass,
            PermissionMode::Bypass => PermissionMode::Auto,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            PermissionMode::Auto => "Auto",
            PermissionMode::AcceptEdits => "Accept edits",
            PermissionMode::Plan => "Plan",
            PermissionMode::Bypass => "Full access",
        }
    }

    pub fn cli_name(self) -> &'static str {
        match self {
            PermissionMode::Auto => "auto",
            PermissionMode::AcceptEdits => "acceptEdits",
            PermissionMode::Plan => "plan",
            PermissionMode::Bypass => "bypassPermissions",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum ToolState {
    Running,
    Done,
    Error,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum ChatItem {
    User { text: String },
    Assistant { text: String, #[serde(skip)] streaming: bool },
    Tool { id: String, name: String, summary: String, output: Option<String>, state: ToolState },
    Notice { text: String, error: bool },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Thread {
    pub id: String,
    pub title: String,
    pub session_id: Option<String>,
    pub cwd: String,
    #[serde(default)]
    pub model: Model,
    #[serde(default)]
    pub effort: Effort,
    #[serde(default)]
    pub mode: PermissionMode,
    pub draft_id: Option<String>,
    pub items: Vec<ChatItem>,
    pub cost_usd: f64,
    #[serde(skip)]
    pub running: bool,
}

impl Thread {
    pub fn new(id: String, cwd: String) -> Self {
        Thread {
            id,
            title: "Studio".into(),
            session_id: None,
            cwd,
            model: Model::default(),
            effort: Effort::default(),
            mode: PermissionMode::default(),
            draft_id: None,
            items: Vec::new(),
            cost_usd: 0.0,
            running: false,
        }
    }
}

pub enum ClaudeEvent {
    Session { thread_id: String, session_id: String },
    TextDelta { thread_id: String, delta: String },
    AssistantText { thread_id: String, text: String },
    ToolStart { thread_id: String, id: String, name: String },
    ToolInput { thread_id: String, id: String, name: String, summary: String },
    ToolResult { thread_id: String, id: String, output: String, is_error: bool },
    Done { thread_id: String, session_id: Option<String>, cost_usd: Option<f64>, error: Option<String> },
}

#[derive(Clone)]
pub struct Runner {
    events: Arc<Mutex<Vec<ClaudeEvent>>>,
    cancels: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
    wake: Arc<Mutex<Option<rune::Waker>>>,
    runtime: Arc<tokio::runtime::Runtime>,
}

impl Default for Runner {
    fn default() -> Self {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("claude tokio runtime");
        Runner {
            events: Arc::new(Mutex::new(Vec::new())),
            cancels: Arc::new(Mutex::new(HashMap::new())),
            wake: Arc::new(Mutex::new(None)),
            runtime: Arc::new(runtime),
        }
    }
}

impl Runner {
    pub fn set_waker(&self, wake: rune::Waker) {
        *self.wake.lock().unwrap() = Some(wake);
    }

    fn push(&self, event: ClaudeEvent) {
        self.events.lock().unwrap().push(event);
        if let Some(wake) = self.wake.lock().unwrap().as_ref() {
            wake();
        }
    }

    pub fn drain(&self) -> Vec<ClaudeEvent> {
        std::mem::take(&mut *self.events.lock().unwrap())
    }

    pub fn stop(&self, thread_id: &str) {
        if let Some(tx) = self.cancels.lock().unwrap().remove(thread_id) {
            let _ = tx.send(());
        }
    }

    pub fn send(
        &self,
        thread_id: String,
        prompt: String,
        session_id: Option<String>,
        cwd: String,
        model: Model,
        effort: Effort,
        mode: PermissionMode,
        bridge: Option<BridgeInfo>,
    ) {
        self.stop(&thread_id);
        let (cancel_tx, cancel_rx) = oneshot::channel();
        self.cancels.lock().unwrap().insert(thread_id.clone(), cancel_tx);
        let runner = self.clone();
        self.runtime.spawn(async move {
            let outcome = run_turn(&runner, &thread_id, &prompt, session_id.as_deref(), &cwd, model, effort, mode, bridge.as_ref(), cancel_rx).await;
            runner.cancels.lock().unwrap().remove(&thread_id);
            if let Err(error) = outcome {
                runner.push(ClaudeEvent::Done { thread_id, session_id: None, cost_usd: None, error: Some(error) });
            }
        });
    }
}

/// Locates the user's local `claude` CLI binary across PATH and common install locations.
pub fn find_binary() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            candidates.push(dir.join("claude"));
        }
    }
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        candidates.push(home.join(".local/bin/claude"));
        candidates.push(home.join(".local/share/mise/command-wrappers/bin/claude"));
        candidates.push(home.join(".local/share/mise/shims/claude"));
        candidates.push(home.join(".claude/local/claude"));
        candidates.push(home.join(".npm-global/bin/claude"));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/claude"));
    candidates.push(PathBuf::from("/usr/local/bin/claude"));
    candidates.push(PathBuf::from("/usr/bin/claude"));
    candidates.into_iter().find(|p| p.is_file())
}

pub fn default_cwd() -> String {
    std::env::var("HOME").unwrap_or_else(|_| ".".into())
}

fn chat_path() -> Option<PathBuf> {
    Some(config::data_dir()?.join("studio-chat.json"))
}

/// Older builds kept several threads; the most recent one becomes the single conversation.
fn legacy_threads_path() -> Option<PathBuf> {
    Some(config::data_dir()?.join("studio-threads.json"))
}

/// How many chat items the conversation keeps on disk. Claude Code compacts its own context;
/// this only bounds the transcript the app re-renders.
const KEEP_ITEMS: usize = 400;

/// Loads the one continuous Studio conversation, starting a fresh one when none exists.
pub fn load_chat() -> Thread {
    let read = |path: Option<PathBuf>| path.and_then(|p| std::fs::read(p).ok());
    if let Some(thread) = read(chat_path()).and_then(|raw| serde_json::from_slice::<Thread>(&raw).ok()) {
        return thread;
    }
    if let Some(mut thread) = read(legacy_threads_path())
        .and_then(|raw| serde_json::from_slice::<Vec<Thread>>(&raw).ok())
        .and_then(|threads| threads.into_iter().next())
    {
        // New defaults: Opus 5.5 at medium effort, full access.
        thread.model = Model::default();
        thread.effort = Effort::default();
        thread.mode = PermissionMode::default();
        return thread;
    }
    Thread::new("studio".into(), default_cwd())
}

pub fn save_chat(thread: &Thread) {
    let Some(path) = chat_path() else { return };
    let mut copy = thread.clone();
    if copy.items.len() > KEEP_ITEMS {
        copy.items.drain(..copy.items.len() - KEEP_ITEMS);
    }
    let Ok(raw) = serde_json::to_vec_pretty(&copy) else { return };
    std::thread::spawn(move || {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(path, raw);
    });
}

fn friendly_tool_name(raw: &str) -> String {
    if let Some(rest) = raw.strip_prefix("mcp__buddysocials__studio_") {
        return format!("studio: {}", rest.replace('_', " "));
    }
    if let Some(rest) = raw.strip_prefix("mcp__buddysocials__") {
        return format!("studio: {}", rest.replace('_', " "));
    }
    if let Some(rest) = raw.strip_prefix("mcp__") {
        return rest.replace("__", ": ");
    }
    raw.to_string()
}

fn summarize_input(name: &str, input: &Json) -> String {
    if let Some(path) = input.get("path").or_else(|| input.get("file_path")).and_then(Json::as_str) {
        return path.rsplit('/').next().unwrap_or(path).to_string();
    }
    if let Some(cmd) = input.get("command").and_then(Json::as_str) {
        return truncate_line(cmd, 64);
    }
    if let Some(text) = input.get("text").and_then(Json::as_str) {
        return truncate_line(text.lines().next().unwrap_or(text), 64);
    }
    if let Some(query) = input.get("pattern").or_else(|| input.get("query")).and_then(Json::as_str) {
        return truncate_line(query, 64);
    }
    if name.contains("publish") {
        return "Publishing draft".into();
    }
    if name.contains("schedule") {
        if let Some(when) = input.get("scheduled_for").and_then(Json::as_str) {
            return when.to_string();
        }
        return "Updating schedule".into();
    }
    String::new()
}

fn truncate_line(s: &str, max: usize) -> String {
    let clean = s.trim().replace('\n', " ");
    let mut chars = clean.chars();
    let head: String = chars.by_ref().take(max).collect();
    if chars.next().is_some() { format!("{head}…") } else { head }
}

fn extract_tool_result_text(content: &Json) -> String {
    if let Some(s) = content.as_str() {
        return truncate_line(s, 140);
    }
    if let Some(arr) = content.as_array() {
        for part in arr {
            if let Some(s) = part.get("text").and_then(Json::as_str) {
                return truncate_line(s, 140);
            }
        }
    }
    String::new()
}

async fn run_turn(
    runner: &Runner,
    thread_id: &str,
    prompt: &str,
    session_id: Option<&str>,
    cwd: &str,
    model: Model,
    effort: Effort,
    mode: PermissionMode,
    bridge: Option<&BridgeInfo>,
    mut cancel_rx: oneshot::Receiver<()>,
) -> Result<(), String> {
    let bin = find_binary().ok_or_else(|| {
        "Claude Code CLI (`claude`) was not found. Install Claude Code and sign in with `claude`, then try again.".to_string()
    })?;
    let mut cmd = Command::new(&bin);
    cmd.args([
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--model",
        model.cli_name(),
        "--effort",
        effort.cli_name(),
        "--permission-mode",
        mode.cli_name(),
        "--append-system-prompt",
        SYSTEM_PROMPT,
    ]);
    if mode == PermissionMode::Bypass {
        cmd.arg("--allow-dangerously-skip-permissions");
    }
    if let Some(sid) = session_id {
        cmd.args(["--resume", sid]);
    }
    if let Some(bridge) = bridge {
        cmd.args(["--mcp-config", &bridge.mcp_config_json()]);
    }
    let dir = PathBuf::from(cwd);
    if dir.is_dir() {
        cmd.current_dir(dir);
    }
    // Avoid nested-session guards if BuddySocials was launched from a Claude Code shell.
    cmd.env_remove("CLAUDECODE");
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("Could not start Claude Code: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        let line = json!({
            "type": "user",
            "message": { "role": "user", "content": prompt }
        })
        .to_string();
        let _ = stdin.write_all(line.as_bytes()).await;
        let _ = stdin.write_all(b"\n").await;
        let _ = stdin.flush().await;
        drop(stdin);
    }

    let stdout = child.stdout.take().ok_or("Claude Code opened without stdout.")?;
    let stderr = child.stderr.take();
    let stderr_task = tokio::spawn(async move {
        let mut out = String::new();
        if let Some(stderr) = stderr {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            while reader.read_line(&mut line).await.unwrap_or(0) > 0 {
                if out.len() < 2000 {
                    out.push_str(&line);
                }
                line.clear();
            }
        }
        out
    });

    let mut lines = BufReader::new(stdout).lines();
    let mut finished = false;
    let mut saw_stream_delta = false;

    loop {
        tokio::select! {
            _ = &mut cancel_rx => {
                let _ = child.kill().await;
                runner.push(ClaudeEvent::Done {
                    thread_id: thread_id.to_string(),
                    session_id: None,
                    cost_usd: None,
                    error: Some("Stopped.".into()),
                });
                return Ok(());
            }
            next = lines.next_line() => {
                match next {
                    Ok(Some(line)) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() { continue; }
                        let Ok(event) = serde_json::from_str::<Json>(trimmed) else { continue };
                        let kind = event.get("type").and_then(Json::as_str).unwrap_or("");
                        match kind {
                            "system" => {
                                if let Some(sid) = event.get("session_id").and_then(Json::as_str) {
                                    runner.push(ClaudeEvent::Session { thread_id: thread_id.to_string(), session_id: sid.to_string() });
                                }
                            }
                            "stream_event" => {
                                let Some(inner) = event.get("event") else { continue };
                                let ev_type = inner.get("type").and_then(Json::as_str).unwrap_or("");
                                match ev_type {
                                    "content_block_delta" => {
                                        if let Some(delta) = inner.get("delta") {
                                            if delta.get("type").and_then(Json::as_str) == Some("text_delta") {
                                                if let Some(text) = delta.get("text").and_then(Json::as_str) {
                                                    saw_stream_delta = true;
                                                    runner.push(ClaudeEvent::TextDelta { thread_id: thread_id.to_string(), delta: text.to_string() });
                                                }
                                            }
                                        }
                                    }
                                    "content_block_start" => {
                                        if let Some(block) = inner.get("content_block") {
                                            if block.get("type").and_then(Json::as_str) == Some("tool_use") {
                                                let id = block.get("id").and_then(Json::as_str).unwrap_or("").to_string();
                                                let name = block.get("name").and_then(Json::as_str).unwrap_or("tool");
                                                runner.push(ClaudeEvent::ToolStart {
                                                    thread_id: thread_id.to_string(),
                                                    id,
                                                    name: friendly_tool_name(name),
                                                });
                                            }
                                        }
                                    }
                                    _ => {}
                                }
                            }
                            "assistant" => {
                                if let Some(content) = event.pointer("/message/content").and_then(Json::as_array) {
                                    for block in content {
                                        match block.get("type").and_then(Json::as_str) {
                                            Some("text") => {
                                                if !saw_stream_delta {
                                                    if let Some(text) = block.get("text").and_then(Json::as_str) {
                                                        if !text.trim().is_empty() {
                                                            runner.push(ClaudeEvent::AssistantText {
                                                                thread_id: thread_id.to_string(),
                                                                text: text.to_string(),
                                                            });
                                                        }
                                                    }
                                                }
                                            }
                                            Some("tool_use") => {
                                                let id = block.get("id").and_then(Json::as_str).unwrap_or("").to_string();
                                                let raw_name = block.get("name").and_then(Json::as_str).unwrap_or("tool");
                                                let input = block.get("input").cloned().unwrap_or(Json::Null);
                                                runner.push(ClaudeEvent::ToolInput {
                                                    thread_id: thread_id.to_string(),
                                                    id,
                                                    name: friendly_tool_name(raw_name),
                                                    summary: summarize_input(raw_name, &input),
                                                });
                                                saw_stream_delta = false;
                                            }
                                            _ => {}
                                        }
                                    }
                                }
                            }
                            "user" => {
                                if let Some(content) = event.pointer("/message/content").and_then(Json::as_array) {
                                    for block in content {
                                        if block.get("type").and_then(Json::as_str) == Some("tool_result") {
                                            let id = block.get("tool_use_id").and_then(Json::as_str).unwrap_or("").to_string();
                                            let is_error = block.get("is_error").and_then(Json::as_bool).unwrap_or(false);
                                            let output = extract_tool_result_text(block.get("content").unwrap_or(&Json::Null));
                                            runner.push(ClaudeEvent::ToolResult {
                                                thread_id: thread_id.to_string(),
                                                id,
                                                output,
                                                is_error,
                                            });
                                        }
                                    }
                                }
                            }
                            "result" => {
                                finished = true;
                                let sid = event.get("session_id").and_then(Json::as_str).map(str::to_string);
                                let cost = event.get("total_cost_usd").and_then(Json::as_f64);
                                let is_error = event.get("is_error").and_then(Json::as_bool).unwrap_or(false);
                                let error = if is_error {
                                    event.get("result").and_then(Json::as_str).map(str::to_string).or_else(|| Some("Claude Code reported an error.".into()))
                                } else {
                                    None
                                };
                                runner.push(ClaudeEvent::Done {
                                    thread_id: thread_id.to_string(),
                                    session_id: sid,
                                    cost_usd: cost,
                                    error,
                                });
                            }
                            _ => {}
                        }
                    }
                    Ok(None) => break,
                    Err(_) => break,
                }
            }
        }
    }

    let status = child.wait().await.ok();
    let err_out = stderr_task.await.unwrap_or_default();
    if !finished {
        let error = if !status.is_some_and(|s| s.success()) {
            let trimmed = err_out.trim();
            Some(if trimmed.is_empty() { "Claude Code exited unexpectedly.".into() } else { truncate_line(trimmed, 240) })
        } else {
            None
        };
        runner.push(ClaudeEvent::Done { thread_id: thread_id.to_string(), session_id: None, cost_usd: None, error });
    }
    Ok(())
}
