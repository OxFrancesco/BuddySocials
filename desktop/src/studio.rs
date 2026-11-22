//! BuddySocials Studio: the dedicated Idea → Final Post workbench.
//!
//! Left pane: embedded local Claude Code collaborator (same stream-json + session resume
//! + loopback MCP bridge pattern as T3 Code), with model/mode/folder controls, starter ideas,
//! streaming responses, and live tool-activity cards.
//! Right pane: live multi-platform post composer with per-platform copy tabs, YouTube title &
//! visibility controls, drag-and-drop media/cover editor, live platform mock-ups, scheduling,
//! and direct publishing / per-account retry / YouTube Go-Public controls.

use std::path::PathBuf;

use rune::{Cursor, El, FileDialogOptions, ScrollSpec, TextEdit, Tx, col, el, row, text, text_input};
use serde_json::{Value as Json, json};

use crate::backend::Cmd;
use crate::claude::{self, ChatItem, ClaudeEvent, Runner, Thread, ToolState};
use crate::studio_bridge::{ActiveDraftSnapshot, BridgeInfo, DraftPatch, Snapshot};
use crate::{App, DraftEdit, Tab, fmt, media, preview, theme, ui};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Layout {
    Split,
    Editor,
    Claude,
}

impl Layout {
    fn label(self) -> &'static str {
        match self {
            Layout::Split => "Split",
            Layout::Editor => "Editor",
            Layout::Claude => "Claude",
        }
    }
}

pub struct StudioState {
    pub layout: Layout,
    pub threads: Vec<Thread>,
    pub active_thread: usize,
    pub prompt: TextEdit,
    pub runner: Runner,
    pub bridge: Option<BridgeInfo>,
    pub has_claude: bool,
    next_thread_id: u64,
}

impl StudioState {
    pub fn new() -> Self {
        let mut threads = claude::load_threads();
        if threads.is_empty() {
            threads.push(Thread::new("t-1".into(), claude::default_cwd()));
        }
        let next = (threads.len() as u64) + 1;
        StudioState {
            layout: Layout::Split,
            threads,
            active_thread: 0,
            prompt: TextEdit::new(""),
            runner: Runner::default(),
            bridge: None,
            has_claude: claude::find_binary().is_some(),
            next_thread_id: next,
        }
    }

    pub fn thread(&self) -> &Thread {
        &self.threads[self.active_thread.min(self.threads.len().saturating_sub(1))]
    }

    pub fn thread_mut(&mut self) -> &mut Thread {
        let idx = self.active_thread.min(self.threads.len().saturating_sub(1));
        &mut self.threads[idx]
    }

    pub fn new_thread(&mut self) {
        self.next_thread_id += 1;
        let cwd = self.thread().cwd.clone();
        let id = format!("t-{}-{}", fmt::now_ms() as u64, self.next_thread_id);
        let mut next = Thread::new(id, cwd);
        next.model = self.thread().model;
        next.mode = self.thread().mode;
        self.threads.insert(0, next);
        self.active_thread = 0;
        claude::save_threads(&self.threads);
    }
}

/// Ensures there is always an open draft inside Studio so typing or asking Claude works immediately.
pub fn ensure_draft(s: &mut App) {
    if s.draft.is_some() {
        return;
    }
    let default_accounts: Vec<String> = s
        .accounts()
        .iter()
        .filter(|a| a["source"] == "direct" && a["status"] != "reconnect")
        .filter_map(|a| a["_id"].as_str().map(str::to_string))
        .collect();
    s.draft = Some(DraftEdit::new(None, "", default_accounts));
}

pub fn new_draft(s: &mut App) {
    let default_accounts: Vec<String> = s
        .accounts()
        .iter()
        .filter(|a| a["source"] == "direct" && a["status"] != "reconnect")
        .filter_map(|a| a["_id"].as_str().map(str::to_string))
        .collect();
    s.draft = Some(DraftEdit::new(None, "", default_accounts));
}

/// Opens a saved Convex draft record inside the Studio editor.
pub fn open_saved_draft(s: &mut App, draft: &Json) {
    let id = draft["_id"].as_str().map(str::to_string);
    let body = draft["text"].as_str().unwrap_or("");
    let title = draft["title"].as_str().unwrap_or("");
    let vis = draft["youtubeVisibility"].as_str().unwrap_or("unlisted");
    let accounts: Vec<String> = draft["targets"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|target| target["accountId"].as_str().map(str::to_string))
        .collect();
    let mut opened = DraftEdit::new(id, body, accounts);
    opened.title = TextEdit::new(title);
    opened.youtube_visibility = vis.to_string();
    if let Some(overrides) = draft["platformText"].as_object() {
        for (platform, value) in overrides {
            if let Some(text) = value.as_str() {
                if !text.trim().is_empty() {
                    opened.platform_text.insert(platform.clone(), TextEdit::new(text));
                }
            }
        }
    }
    opened.media = media::open_saved(s, &draft["media"]);
    opened.cover = media::open_saved_cover(s, &draft["cover"]);
    s.draft = Some(opened);
}

pub fn open_draft_by_id(s: &mut App, draft_id: &str) {
    let found = s
        .query("drafts:list", json!({}))
        .and_then(Json::as_array)
        .and_then(|drafts| drafts.iter().find(|d| d["_id"].as_str() == Some(draft_id)))
        .cloned();
    if let Some(draft) = found {
        open_saved_draft(s, &draft);
    }
}

/// Applies a live draft edit coming back from Claude Code via the loopback MCP bridge.
pub fn apply_patch(s: &mut App, patch: DraftPatch) {
    let replace = patch.open_if_different
        || s.draft.is_none()
        || s.draft.as_ref().and_then(|d| d.id.as_deref()) == Some(patch.draft_id.as_str());
    if !replace {
        return;
    }
    if s.draft.is_none() || (patch.open_if_different && s.draft.as_ref().and_then(|d| d.id.as_deref()) != Some(patch.draft_id.as_str())) {
        let mut next = DraftEdit::new(Some(patch.draft_id.clone()), &patch.text, patch.accounts.clone());
        next.title = TextEdit::new(patch.title.as_deref().unwrap_or(""));
        next.youtube_visibility = patch.youtube_visibility.clone();
        for (platform, text) in patch.platform_text {
            next.platform_text.insert(platform, TextEdit::new(&text));
        }
        s.draft = Some(next);
    } else if let Some(edit) = &mut s.draft {
        edit.id = Some(patch.draft_id);
        edit.text = TextEdit::new(&patch.text);
        edit.title = TextEdit::new(patch.title.as_deref().unwrap_or(""));
        edit.youtube_visibility = patch.youtube_visibility;
        edit.accounts = patch.accounts;
        edit.platform_text.clear();
        for (platform, text) in patch.platform_text {
            edit.platform_text.insert(platform, TextEdit::new(&text));
        }
        edit.confirming = false;
    }
    s.studio.thread_mut().draft_id = s.draft.as_ref().and_then(|d| d.id.clone());
}

/// Pushes current accounts, drafts, posts, comments, and the open Studio draft to the MCP bridge.
pub fn sync_snapshot(s: &App) {
    let Some(backend) = &s.backend else { return };
    let accounts = s.query("accounts:list", json!({})).cloned().unwrap_or_else(|| json!([]));
    let drafts = s.query("drafts:list", json!({})).cloned().unwrap_or_else(|| json!([]));
    let posts = s
        .query("dashboard:posts", s.posts_args())
        .and_then(|page| page.get("page"))
        .cloned()
        .unwrap_or_else(|| json!([]));
    let comments = s
        .query("comments:list", s.inbox_args())
        .and_then(|page| page.get("page"))
        .cloned()
        .unwrap_or_else(|| json!([]));
    let active_draft = s.draft.as_ref().map(|d| ActiveDraftSnapshot {
        id: d.id.clone(),
        title: d.title.text.clone(),
        text: d.text.text.clone(),
        platform_text: d
            .platform_text
            .iter()
            .filter_map(|(k, v)| (!v.text.trim().is_empty()).then(|| (k.clone(), v.text.clone())))
            .collect(),
        youtube_visibility: d.youtube_visibility.clone(),
        accounts: d.accounts.clone(),
        media: d.media.iter().filter_map(|m| m.saved.clone()).collect(),
        cover_storage_id: d.cover.as_ref().and_then(|c| c.storage_id.clone()),
    });
    backend.set_snapshot(Snapshot { accounts, drafts, posts, comments, active_draft });
}

/// Folds streaming Claude Code events into Studio threads. Returns true if anything visible changed.
pub fn absorb_claude(s: &mut App) -> bool {
    let events = s.studio.runner.drain();
    if events.is_empty() {
        return false;
    }
    let mut persist = false;
    for event in events {
        match event {
            ClaudeEvent::Session { thread_id, session_id } => {
                if let Some(t) = s.studio.threads.iter_mut().find(|t| t.id == thread_id) {
                    t.session_id = Some(session_id);
                    persist = true;
                }
            }
            ClaudeEvent::TextDelta { thread_id, delta } => {
                if let Some(t) = s.studio.threads.iter_mut().find(|t| t.id == thread_id) {
                    match t.items.last_mut() {
                        Some(ChatItem::Assistant { text, streaming }) if *streaming => {
                            text.push_str(&delta);
                        }
                        _ => t.items.push(ChatItem::Assistant { text: delta, streaming: true }),
                    }
                }
            }
            ClaudeEvent::AssistantText { thread_id, text } => {
                if let Some(t) = s.studio.threads.iter_mut().find(|t| t.id == thread_id) {
                    t.items.push(ChatItem::Assistant { text, streaming: false });
                }
            }
            ClaudeEvent::ToolStart { thread_id, id, name } => {
                if let Some(t) = s.studio.threads.iter_mut().find(|t| t.id == thread_id) {
                    if let Some(ChatItem::Assistant { streaming, .. }) = t.items.last_mut() {
                        *streaming = false;
                    }
                    if !t.items.iter().any(|item| matches!(item, ChatItem::Tool { id: existing, .. } if existing == &id)) {
                        t.items.push(ChatItem::Tool { id, name, summary: String::new(), output: None, state: ToolState::Running });
                    }
                }
            }
            ClaudeEvent::ToolInput { thread_id, id, name, summary } => {
                if let Some(t) = s.studio.threads.iter_mut().find(|t| t.id == thread_id) {
                    if let Some(ChatItem::Tool { name: n, summary: s_out, .. }) = t
                        .items
                        .iter_mut()
                        .find(|item| matches!(item, ChatItem::Tool { id: existing, .. } if existing == &id))
                    {
                        *n = name;
                        *s_out = summary;
                    } else {
                        t.items.push(ChatItem::Tool { id, name, summary, output: None, state: ToolState::Running });
                    }
                }
            }
            ClaudeEvent::ToolResult { thread_id, id, output, is_error } => {
                if let Some(t) = s.studio.threads.iter_mut().find(|t| t.id == thread_id) {
                    if let Some(ChatItem::Tool { output: out_slot, state, .. }) = t
                        .items
                        .iter_mut()
                        .find(|item| matches!(item, ChatItem::Tool { id: existing, .. } if existing == &id))
                    {
                        *out_slot = (!output.is_empty()).then_some(output);
                        *state = if is_error { ToolState::Error } else { ToolState::Done };
                    }
                }
            }
            ClaudeEvent::Done { thread_id, session_id, cost_usd, error } => {
                if let Some(t) = s.studio.threads.iter_mut().find(|t| t.id == thread_id) {
                    t.running = false;
                    if let Some(sid) = session_id {
                        t.session_id = Some(sid);
                    }
                    if let Some(cost) = cost_usd {
                        t.cost_usd += cost;
                    }
                    for item in &mut t.items {
                        if let ChatItem::Assistant { streaming, .. } = item {
                            *streaming = false;
                        }
                        if let ChatItem::Tool { state, .. } = item {
                            if *state == ToolState::Running {
                                *state = ToolState::Done;
                            }
                        }
                    }
                    if let Some(err) = error {
                        t.items.push(ChatItem::Notice { text: err, error: true });
                    }
                    persist = true;
                }
            }
        }
    }
    if persist {
        claude::save_threads(&s.studio.threads);
    }
    true
}

fn send_prompt(s: &mut App, text_to_send: String) {
    let prompt = text_to_send.trim().to_string();
    if prompt.is_empty() {
        return;
    }
    ensure_draft(s);
    sync_snapshot(s);
    let bridge = s.studio.bridge.clone();
    let runner = s.studio.runner.clone();
    let thread = s.studio.thread_mut();
    if thread.running {
        return;
    }
    if thread.items.is_empty() {
        let short: String = prompt.lines().next().unwrap_or(&prompt).chars().take(28).collect();
        thread.title = if short.is_empty() { "Idea".into() } else { short };
    }
    thread.items.push(ChatItem::User { text: prompt.clone() });
    thread.running = true;
    let thread_id = thread.id.clone();
    let session_id = thread.session_id.clone();
    let cwd = thread.cwd.clone();
    let model = thread.model;
    let mode = thread.mode;
    claude::save_threads(&s.studio.threads);
    runner.send(thread_id, prompt, session_id, cwd, model, mode, bridge);
}

fn pick_folder(s: &mut App, tx: &mut Tx) {
    let current = PathBuf::from(&s.studio.thread().cwd);
    let options = FileDialogOptions {
        title: "Choose workspace folder for Claude Code".into(),
        directory: current.is_dir().then_some(current),
        ..Default::default()
    };
    tx.open_folder(options, |s: &mut App, result, _| match result {
        Ok(Some(path)) => {
            s.studio.thread_mut().cwd = path.to_string_lossy().into_owned();
            claude::save_threads(&s.studio.threads);
        }
        Ok(None) => {}
        Err(_) => s.notice = Some("Could not open the folder picker.".into()),
    });
}

fn folder_label(path: &str) -> String {
    let name = path.trim_end_matches('/').rsplit('/').next().unwrap_or(path);
    if name.is_empty() { "/".into() } else { name.to_string() }
}

fn short_label(input: &str, max: usize) -> String {
    let mut chars = input.trim().chars();
    let head: String = chars.by_ref().take(max).collect();
    if chars.next().is_some() { format!("{}…", head.trim_end()) } else { head }
}

// ---------------------------------------------------------------- UI: top bar

fn top_bar(s: &App) -> El {
    let drafts = s.query("drafts:list", json!({})).and_then(Json::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let open_id = s.draft.as_ref().and_then(|d| d.id.as_deref());
    let mut switcher = row().gap(8.0).center_y().flex_wrap().grow(1.0).min_w(0.0);
    switcher = switcher.child(ui::button("studio-new-draft", "+ New post", ui::Kind::Primary).on_press(new_draft));
    for draft in drafts.iter().filter(|d| d["status"] != "published").take(4) {
        let id = draft["_id"].as_str().unwrap_or("").to_string();
        let active = open_id == Some(id.as_str());
        let heading = draft["title"]
            .as_str()
            .filter(|t| !t.trim().is_empty())
            .or_else(|| draft["text"].as_str().and_then(|t| t.trim().lines().next()))
            .unwrap_or("Untitled");
        let label = short_label(heading, 18);
        let draft_clone = draft.clone();
        switcher = switcher.child(ui::chip(format!("studio-pick-{id}"), &label, active).on_press(move |s: &mut App| {
            open_saved_draft(s, &draft_clone);
        }));
    }
    if drafts.len() > 4 {
        switcher = switcher.child(ui::button("studio-all-drafts", "All drafts", ui::Kind::Ghost).on_press(|s: &mut App| {
            s.tab = Tab::Posts;
            s.show_drafts = true;
        }));
    }

    let mut layout_bar = row().gap(6.0).center_y();
    for mode in [Layout::Split, Layout::Editor, Layout::Claude] {
        layout_bar = layout_bar.child(ui::chip(format!("studio-layout-{}", mode.label().to_lowercase()), mode.label(), s.studio.layout == mode).on_press(move |s: &mut App| {
            s.studio.layout = mode;
        }));
    }
    row()
        .key("studio-topbar")
        .px(20.0)
        .py(12.0)
        .gap(16.0)
        .center_y()
        .border_sides([0.0, 0.0, 1.0, 0.0], theme::line())
        .child(switcher)
        .child(layout_bar)
}

// ---------------------------------------------------------------- UI: Claude Code pane

fn claude_pane(s: &App) -> El {
    let thread = s.studio.thread();
    let mut header_threads = row().gap(6.0).center_y().flex_wrap().grow(1.0).min_w(0.0);
    header_threads = header_threads.child(text("CLAUDE CODE").font(theme::display(16.0)).color(theme::FG));
    header_threads = header_threads.child(ui::button("claude-new-thread", "+ Thread", ui::Kind::Outline).on_press(|s: &mut App| {
        s.studio.new_thread();
    }));
    for (idx, t) in s.studio.threads.iter().take(3).enumerate() {
        let active = idx == s.studio.active_thread;
        let short = short_label(&t.title, 14);
        header_threads = header_threads.child(ui::chip(format!("claude-thread-{idx}"), &short, active).on_press(move |s: &mut App| {
            s.studio.active_thread = idx;
        }));
    }

    let controls = row()
        .gap(6.0)
        .center_y()
        .flex_wrap()
        .child(
            ui::chip("claude-model", thread.model.label(), false).on_press(|s: &mut App| {
                let next = s.studio.thread().model.next();
                s.studio.thread_mut().model = next;
                claude::save_threads(&s.studio.threads);
            }),
        )
        .child(
            ui::chip("claude-mode", thread.mode.label(), false).on_press(|s: &mut App| {
                let next = s.studio.thread().mode.next();
                s.studio.thread_mut().mode = next;
                claude::save_threads(&s.studio.threads);
            }),
        )
        .child(ui::chip("claude-cwd", &folder_label(&thread.cwd), false).on_press_tx(pick_folder));

    let header = col()
        .px(16.0)
        .py(12.0)
        .gap(8.0)
        .border_sides([0.0, 0.0, 1.0, 0.0], theme::line())
        .child(header_threads)
        .child(controls);

    // Conversation stream
    let mut feed = col().px(16.0).py(14.0).gap(12.0);
    if !s.studio.has_claude {
        feed = feed.child(
            col()
                .padding(14.0)
                .gap(8.0)
                .border(2.0, theme::coral())
                .child(text("CLAUDE CODE CLI NOT FOUND").font(theme::label(11.0)).color(theme::coral()))
                .child(
                    text("Install Claude Code (`claude`) and sign in once in your terminal. BuddySocials spawns your local Claude Code directly, just like T3 Code — no API key needed.")
                        .font(theme::mono(12.0))
                        .color(theme::DIM)
                        .wrap(),
                ),
        );
    } else if thread.items.is_empty() {
        feed = feed
            .child(text("IDEA TO POST, TOGETHER").font(theme::display(20.0)).color(theme::FG))
            .child(
                text("Tell Claude what you built, paste rough notes, or drop a file path. Claude reads your accounts & past posts, writes platform-tailored copy live into the editor, attaches local media, and prepares your post to publish.")
                    .font(theme::mono(12.0))
                    .color(theme::DIM)
                    .wrap(),
            );
        let starters = [
            ("Turn a rough idea into posts", "Help me turn a rough idea into a multi-platform post. First check my connected accounts and recent top posts so you match my voice, then ask me what I want to share."),
            ("Tailor this draft per platform", "Inspect my currently open draft with studio_get_context and tailor it for every selected platform (punchy <=280 char X version, structured LinkedIn post, clean Instagram caption, YouTube title+description). Update the draft directly."),
            ("Pitch 3 ideas from my top posts", "Check my recent posts and open comments, see what resonated most, and pitch 3 sharp post ideas I could publish today."),
            ("Review & fix my open draft", "Inspect my open draft, sharpen the hook, fix any platform issues or character limits, and update the draft directly."),
        ];
        let mut starter_col = col().gap(8.0).pt(6.0);
        for (i, (label, prompt)) in starters.into_iter().enumerate() {
            let prompt_str = prompt.to_string();
            starter_col = starter_col.child(
                row()
                    .key(format!("claude-starter-{i}"))
                    .px(12.0)
                    .py(10.0)
                    .border(1.0, theme::line())
                    .cursor(Cursor::Pointer)
                    .hover(theme::FG.alpha(0.08))
                    .on_press(move |s: &mut App| send_prompt(s, prompt_str.clone()))
                    .child(text(label).font(theme::mono(12.0)).color(theme::FG).wrap().grow(1.0))
                    .child(text("→").font(theme::label(12.0)).color(theme::coral())),
            );
        }
        feed = feed.child(starter_col);
    } else {
        for (idx, item) in thread.items.iter().enumerate() {
            match item {
                ChatItem::User { text: body } => {
                    feed = feed.child(
                        col()
                            .key(format!("msg-user-{idx}"))
                            .padding(12.0)
                            .gap(4.0)
                            .border(1.0, theme::FG)
                            .child(text("YOU").font(theme::label(9.0)).color(theme::DIM))
                            .child(text(body.clone()).font(theme::mono(13.0)).color(theme::FG).wrap()),
                    );
                }
                ChatItem::Assistant { text: body, streaming } => {
                    let mut block = col().key(format!("msg-asst-{idx}")).gap(4.0);
                    block = block.child(
                        text(if *streaming { "CLAUDE · STREAMING…" } else { "CLAUDE" })
                            .font(theme::label(9.0))
                            .color(if *streaming { theme::coral() } else { theme::DIM }),
                    );
                    block = block.child(text(body.clone()).font(theme::mono(13.0)).color(theme::FG).wrap());
                    feed = feed.child(block);
                }
                ChatItem::Tool { name, summary, output, state, .. } => {
                    let (badge, badge_color) = match state {
                        ToolState::Running => ("RUNNING", theme::coral()),
                        ToolState::Done => ("DONE", theme::DIM),
                        ToolState::Error => ("ERROR", theme::coral()),
                    };
                    let mut card = col()
                        .key(format!("msg-tool-{idx}"))
                        .px(10.0)
                        .py(8.0)
                        .gap(4.0)
                        .border_sides([0.0, 0.0, 0.0, 2.0], if *state == ToolState::Done { theme::line() } else { theme::coral() })
                        .fill(theme::FG.alpha(0.04))
                        .child(
                            row()
                                .gap(8.0)
                                .center_y()
                                .child(text(badge).font(theme::label(9.0)).color(badge_color))
                                .child(text(name.to_uppercase()).font(theme::label(10.0)).color(theme::FG).truncate().grow(1.0)),
                        );
                    if !summary.is_empty() {
                        card = card.child(text(summary.clone()).font(theme::mono(11.0)).color(theme::DIM).max_lines(2));
                    }
                    if let Some(out) = output.as_ref().filter(|o| *state == ToolState::Error || o.len() < 120) {
                        card = card.child(
                            text(out.clone())
                                .font(theme::mono(11.0))
                                .color(if *state == ToolState::Error { theme::coral() } else { theme::FAINT })
                                .max_lines(2),
                        );
                    }
                    feed = feed.child(card);
                }
                ChatItem::Notice { text: msg, error } => {
                    feed = feed.child(
                        text(msg.clone())
                            .key(format!("msg-notice-{idx}"))
                            .font(theme::mono(12.0))
                            .color(if *error { theme::coral() } else { theme::DIM })
                            .wrap(),
                    );
                }
            }
        }
        if thread.running {
            feed = feed.child(text("CLAUDE IS WORKING…").font(theme::label(10.0)).color(theme::coral()));
        }
    }

    // Bottom prompt composer
    let running = thread.running;
    let thread_id_stop = thread.id.clone();
    let mut composer_actions = row().gap(8.0).center_y();
    if thread.cost_usd > 0.0 {
        composer_actions = composer_actions.child(text(format!("${:.3}", thread.cost_usd)).font(theme::label(9.0)).color(theme::FAINT));
    }
    if thread.session_id.is_some() {
        composer_actions = composer_actions.child(text("SESSION LINKED").font(theme::label(9.0)).color(theme::FAINT));
    }
    composer_actions = composer_actions.child(col().grow(1.0));
    if running {
        composer_actions = composer_actions.child(ui::button("claude-stop", "Stop", ui::Kind::Outline).on_press(move |s: &mut App| {
            s.studio.runner.stop(&thread_id_stop);
        }));
    } else {
        composer_actions = composer_actions.child(ui::button("claude-send", "Send", ui::Kind::Primary).on_press(|s: &mut App| {
            let prompt = std::mem::take(&mut s.studio.prompt.text);
            s.studio.prompt.clear();
            send_prompt(s, prompt);
        }));
    }

    let composer = col()
        .px(16.0)
        .py(12.0)
        .gap(10.0)
        .border_sides([1.0, 0.0, 0.0, 0.0], theme::line())
        .child(
            col().min_h(64.0).max_h(160.0).padding(10.0).border(2.0, theme::line()).child(
                text_input(&s.studio.prompt, theme::mono(13.0))
                    .key("claude-prompt")
                    .w_full()
                    .color(theme::FG)
                    .caret(theme::coral(), theme::coral().alpha(0.4))
                    .placeholder("Describe an idea, ask Claude to tailor this post, or pass a file path…", theme::FAINT)
                    .on_edit(|s: &mut App| &mut s.studio.prompt),
            ),
        )
        .child(composer_actions);

    col()
        .key("studio-claude")
        .grow(1.0)
        .min_w(300.0)
        .min_h(0.0)
        .h_full()
        .child(header)
        .child(
            col()
                .key("studio-claude-scroll")
                .grow(1.0)
                .min_h(0.0)
                .scroll(ScrollSpec { stick_bottom: true })
                .child(feed),
        )
        .child(composer)
}

// ---------------------------------------------------------------- UI: Post Composer & Previews pane

fn text_limit(platform: &str) -> Option<usize> {
    match platform {
        "x" => Some(280),
        "linkedin" => Some(3000),
        "instagram" => Some(2200),
        _ => None,
    }
}

fn editor_pane(s: &App) -> El {
    let Some(edit) = &s.draft else {
        return col()
            .grow(1.0)
            .center()
            .gap(12.0)
            .child(text("Start a new post or open a draft.").font(theme::mono(13.0)).color(theme::DIM))
            .child(ui::button("studio-start-empty", "New post", ui::Kind::Primary).on_press(new_draft));
    };

    // Cropping or trimming takes over the right pane so the picture gets full room.
    if let Some(editing) = &edit.editing {
        return col()
            .key("studio-media-editor")
            .grow(1.0)
            .min_w(0.0)
            .min_h(0.0)
            .padding(20.0)
            .scroll(ScrollSpec { stick_bottom: false })
            .child(media::editor(editing));
    }

    let saved = edit.id.as_ref().and_then(|id| {
        s.query("drafts:list", json!({})).and_then(Json::as_array).and_then(|drafts| drafts.iter().find(|draft| draft["_id"] == id.as_str()))
    });
    let scheduled_for = saved.and_then(|d| d["scheduledFor"].as_f64());

    let mut content = col()
        .px(20.0)
        .py(18.0)
        .gap(18.0)
        .on_drop_files(|s: &mut App, files, _| {
            media::add(s, files);
            if let Some(draft) = &mut s.draft {
                draft.drop_over = false;
            }
        })
        .accepts_extensions(&media::EXTENSIONS)
        .on_drop_hover(|s: &mut App, over, _| {
            if let Some(draft) = &mut s.draft {
                draft.drop_over = over;
            }
        });

    // Scheduled banner if set
    if let Some(at) = scheduled_for {
        let cancel_id = edit.id.clone().unwrap_or_default();
        content = content.child(
            row()
                .key("studio-scheduled-banner")
                .px(12.0)
                .py(10.0)
                .gap(12.0)
                .center_y()
                .border(2.0, theme::coral())
                .child(text(format!("SCHEDULED · {}", fmt::format_datetime(at)).to_uppercase()).font(theme::label(11.0)).color(theme::coral()).grow(1.0))
                .child(ui::button("studio-cancel-schedule", "Cancel schedule", ui::Kind::Outline).on_press(move |s: &mut App| {
                    if !cancel_id.is_empty() {
                        s.mutate("drafts:cancelSchedule", json!({ "draftId": cancel_id }));
                    }
                })),
        );
    }

    // 1. Target accounts selector
    let mut account_chips = row().gap(8.0).flex_wrap().center_y();
    let mut selected_platforms: Vec<String> = Vec::new();
    for account in s.accounts() {
        let id = account["_id"].as_str().unwrap_or("").to_string();
        let platform = account["platform"].as_str().unwrap_or("");
        let handle = account["handle"].as_str().unwrap_or("");
        let chosen = edit.accounts.contains(&id);
        if chosen && !selected_platforms.iter().any(|p| p == platform) {
            selected_platforms.push(platform.to_string());
        }
        let toggle = id.clone();
        account_chips = account_chips.child(
            row()
                .key(format!("studio-acct-{id}"))
                .role("button")
                .h(32.0)
                .px(10.0)
                .gap(7.0)
                .center_y()
                .fill(if chosen { theme::FG } else { theme::BG })
                .border(2.0, if chosen { theme::FG } else { theme::line() })
                .cursor(Cursor::Pointer)
                .on_press(move |s: &mut App| {
                    let Some(edit) = &mut s.draft else { return };
                    if let Some(pos) = edit.accounts.iter().position(|e| e == &toggle) {
                        edit.accounts.remove(pos);
                    } else {
                        edit.accounts.push(toggle.clone());
                    }
                    edit.confirming = false;
                })
                .child(
                    el().size(8.0, 8.0)
                        .fill(if chosen && platform == "x" { theme::BG } else { theme::platform_color(platform) }),
                )
                .child(text(format!("{} · {handle}", theme::platform_label(platform)).to_uppercase()).font(theme::label(10.0)).color(if chosen { theme::BG } else { theme::FG })),
        );
    }
    if s.accounts().is_empty() {
        account_chips = account_chips.child(
            ui::button("studio-connect-first", "Connect an account", ui::Kind::Outline).on_press(|s: &mut App| {
                s.tab = Tab::Accounts;
            }),
        );
    } else {
        account_chips = account_chips.child(ui::button("studio-select-all", "All direct", ui::Kind::Ghost).on_press(|s: &mut App| {
            let direct: Vec<String> = s
                .accounts()
                .iter()
                .filter(|a| a["source"] == "direct" && a["status"] != "reconnect")
                .filter_map(|a| a["_id"].as_str().map(str::to_string))
                .collect();
            if let Some(edit) = &mut s.draft {
                edit.accounts = direct;
                edit.confirming = false;
            }
        }));
    }
    content = content.child(
        col()
            .gap(8.0)
            .child(text("DESTINATIONS").font(theme::label(10.0)).color(theme::DIM))
            .child(account_chips),
    );

    // 2. YouTube controls (title + visibility) whenever YouTube is targeted
    if selected_platforms.iter().any(|p| p == "youtube") {
        let title_len = edit.title.text.trim().chars().count();
        let mut vis_row = row().gap(6.0).center_y();
        for vis in ["public", "unlisted", "private"] {
            let v_str = vis.to_string();
            vis_row = vis_row.child(ui::chip(format!("yt-vis-{vis}"), vis, edit.youtube_visibility == vis).on_press(move |s: &mut App| {
                if let Some(edit) = &mut s.draft {
                    edit.youtube_visibility = v_str.clone();
                    edit.confirming = false;
                }
            }));
        }
        content = content.child(
            col()
                .key("studio-youtube")
                .padding(12.0)
                .gap(10.0)
                .border(1.0, theme::line())
                .child(
                    row()
                        .center_y()
                        .child(text("YOUTUBE TITLE & VISIBILITY").font(theme::label(10.0)).color(theme::DIM).grow(1.0))
                        .child(text(format!("{title_len} / 100")).font(theme::label(10.0)).color(if title_len > 100 { theme::coral() } else { theme::FAINT })),
                )
                .child(
                    row().h(34.0).px(10.0).center_y().border(1.0, theme::line()).child(
                        text_input(&edit.title, theme::mono(13.0))
                            .key("studio-title")
                            .single_line()
                            .grow(1.0)
                            .color(theme::FG)
                            .caret(theme::coral(), theme::coral().alpha(0.4))
                            .placeholder("Video title (defaults to first line of post)", theme::FAINT)
                            .on_edit(|s: &mut App| &mut s.draft.as_mut().expect("draft open").title),
                    ),
                )
                .child(vis_row),
        );
    }

    // 3. Per-platform copy tabs + main text box
    let active_tab = if edit.active_copy_tab != "core" && !selected_platforms.iter().any(|p| p == &edit.active_copy_tab) {
        "core".to_string()
    } else {
        edit.active_copy_tab.clone()
    };

    let mut tab_bar = row().gap(6.0).flex_wrap().center_y();
    tab_bar = tab_bar.child(ui::chip("copy-tab-core", "Core", active_tab == "core").on_press(|s: &mut App| {
        if let Some(edit) = &mut s.draft {
            edit.active_copy_tab = "core".into();
        }
    }));
    for platform in &selected_platforms {
        let p_key = platform.clone();
        let customized = edit.has_override(platform);
        let label = if customized {
            format!("{} •", theme::platform_label(platform))
        } else {
            theme::platform_label(platform).to_string()
        };
        tab_bar = tab_bar.child(ui::chip(format!("copy-tab-{platform}"), &label, active_tab == *platform).on_press(move |s: &mut App| {
            if let Some(edit) = &mut s.draft {
                edit.active_copy_tab = p_key.clone();
                edit.platform_text.entry(p_key.clone()).or_insert_with(|| TextEdit::new(""));
            }
        }));
    }
    if active_tab != "core" && edit.has_override(&active_tab) {
        let clear_key = active_tab.clone();
        tab_bar = tab_bar.child(ui::button("copy-reset-core", "Reset to core", ui::Kind::Ghost).on_press(move |s: &mut App| {
            if let Some(edit) = &mut s.draft {
                edit.platform_text.remove(&clear_key);
            }
        }));
    }

    let active_edit = edit.text_edit_for_tab(&active_tab);
    let placeholder = if active_tab == "core" {
        "Write your core post — or ask Claude Code on the left to draft & tailor it…"
    } else {
        "Platform-specific override (leave blank to inherit Core)"
    };

    let mut counts = row().gap(14.0).flex_wrap();
    if active_tab == "core" {
        for platform in &selected_platforms {
            if let Some(limit) = text_limit(platform) {
                let len = edit.text_for(platform).trim().chars().count();
                counts = counts.child(
                    text(format!("{} {len} / {limit}", theme::platform_label(platform)).to_uppercase())
                        .font(theme::label(10.0))
                        .color(if len > limit { theme::coral() } else { theme::DIM }),
                );
            }
        }
    } else if let Some(limit) = text_limit(&active_tab) {
        let len = edit.text_for(&active_tab).trim().chars().count();
        counts = counts.child(
            text(format!("{} {len} / {limit}", theme::platform_label(&active_tab)).to_uppercase())
                .font(theme::label(10.0))
                .color(if len > limit { theme::coral() } else { theme::DIM }),
        );
    }

    let active_tab_for_edit = active_tab.clone();
    let editor_box = col()
        .gap(10.0)
        .padding(14.0)
        .border(2.0, if edit.drop_over { theme::coral() } else { theme::FG })
        .child(tab_bar)
        .child(
            col().min_h(120.0).child(
                text_input(active_edit, theme::mono(14.0))
                    .key(format!("studio-text-{active_tab}"))
                    .w_full()
                    .color(theme::FG)
                    .caret(theme::coral(), theme::coral().alpha(0.4))
                    .placeholder(placeholder, theme::FAINT)
                    .on_input_paste(|s: &mut App, content, _| media::paste(s, content))
                    .on_edit(move |s: &mut App| s.draft.as_mut().expect("draft open").text_edit_mut_for_tab(&active_tab_for_edit)),
            ),
        )
        .child(counts)
        .child(media::strip(edit));
    content = content.child(editor_box);

    // 4. Save / Schedule / Publish action bar
    let settled = !media::working(edit);
    let has_content = !edit.text.text.trim().is_empty()
        || !edit.media.is_empty()
        || edit.platform_text.values().any(|v| !v.text.trim().is_empty());
    let can_send = settled && !edit.accounts.is_empty() && has_content;
    let mut actions = row().gap(8.0).center_y().flex_wrap();
    if settled {
        actions = actions.child(ui::button("studio-save", "Save draft", ui::Kind::Outline).on_press(|s: &mut App| {
            if let Some(edit) = &s.draft {
                let payload = edit.to_save_json();
                s.send(Cmd::SaveDraft { draft: payload, quiet: false });
            }
        }));
    } else {
        actions = actions.child(text("FINISHING UPLOADS…").font(theme::label(10.0)).color(theme::DIM));
    }
    if can_send {
        actions = actions.child(
            ui::button("studio-schedule-toggle", if edit.show_schedule { "Hide schedule" } else { "Schedule" }, ui::Kind::Outline).on_press(|s: &mut App| {
                if let Some(edit) = &mut s.draft {
                    edit.show_schedule = !edit.show_schedule;
                }
            }),
        );
        actions = actions.child(
            ui::button("studio-publish", if edit.confirming { "Confirm & post now" } else { "Publish now" }, ui::Kind::Primary).on_press(|s: &mut App| {
                let Some(edit) = &mut s.draft else { return };
                if !edit.confirming {
                    edit.confirming = true;
                    return;
                }
                edit.confirming = false;
                let draft = edit.to_save_json();
                s.send(Cmd::PublishDraft { draft, account_ids: None });
            }),
        );
    }
    if let Some(id) = edit.id.clone() {
        actions = actions.child(col().grow(1.0)).child(ui::button("studio-delete", "Delete", ui::Kind::Ghost).on_press(move |s: &mut App| {
            s.mutate("drafts:remove", json!({ "draftId": id }));
            new_draft(s);
        }));
    }
    content = content.child(actions);

    // Schedule bar (when open)
    if edit.show_schedule && can_send {
        let now = s.now;
        let presets: [(&str, f64); 4] = [
            ("+1h", now + 3_600_000.0),
            ("+3h", now + 3.0 * 3_600_000.0),
            ("Tomorrow 09:00 UTC", fmt::tomorrow_utc_at(now, 9)),
            ("Tomorrow 18:00 UTC", fmt::tomorrow_utc_at(now, 18)),
        ];
        let mut preset_row = row().gap(8.0).flex_wrap();
        for (idx, (label, at)) in presets.into_iter().enumerate() {
            preset_row = preset_row.child(ui::button(format!("sched-preset-{idx}"), label, ui::Kind::Outline).on_press(move |s: &mut App| {
                if let Some(edit) = &mut s.draft {
                    edit.show_schedule = false;
                    let draft = edit.to_save_json();
                    s.send(Cmd::ScheduleDraft { draft, at });
                }
            }));
        }
        let custom_row = row()
            .gap(8.0)
            .center_y()
            .child(
                row().grow(1.0).h(32.0).px(10.0).center_y().border(1.0, theme::line()).child(
                    text_input(&edit.schedule_input, theme::mono(12.0))
                        .key("studio-schedule-input")
                        .single_line()
                        .grow(1.0)
                        .color(theme::FG)
                        .caret(theme::coral(), theme::coral().alpha(0.4))
                        .placeholder("YYYY-MM-DD HH:MM (UTC) or +2h", theme::FAINT)
                        .on_edit(|s: &mut App| &mut s.draft.as_mut().expect("draft open").schedule_input),
                ),
            )
            .child(ui::button("sched-custom-set", "Set time", ui::Kind::Primary).on_press(|s: &mut App| {
                let now = s.now;
                let Some(edit) = &mut s.draft else { return };
                match fmt::parse_schedule(&edit.schedule_input.text, now) {
                    Some(at) if at > now + 10_000.0 => {
                        edit.show_schedule = false;
                        edit.schedule_input.clear();
                        let draft = edit.to_save_json();
                        s.send(Cmd::ScheduleDraft { draft, at });
                    }
                    _ => s.notice = Some("Use a future UTC time like 2026-11-23 15:00 or +2h.".into()),
                }
            }));
        content = content.child(
            col()
                .key("studio-schedule-panel")
                .padding(12.0)
                .gap(10.0)
                .border(1.0, theme::line())
                .child(text("SCHEDULE AUTO-PUBLISH").font(theme::label(10.0)).color(theme::DIM))
                .child(preset_row)
                .child(custom_row),
        );
    }

    // 5. Per-account delivery status + Retry / Make Public / Open links
    if let Some(targets) = saved.and_then(|d| d["targets"].as_array()).filter(|t| t.iter().any(|x| x["state"].is_string())) {
        let mut status_list = col().gap(8.0).padding(12.0).border(1.0, theme::line()).child(text("DELIVERY STATUS").font(theme::label(10.0)).color(theme::DIM));
        for target in targets {
            let acct_id = target["accountId"].as_str().unwrap_or("").to_string();
            let platform = target["platform"].as_str().unwrap_or("");
            let handle = target["handle"].as_str().unwrap_or("");
            let state = target["state"].as_str();
            let (note, alert) = match state {
                Some("published") => (
                    match platform {
                        "youtube" => format!("Uploaded to YouTube ({})", edit.youtube_visibility),
                        "tiktok" => "Sent to your TikTok inbox".into(),
                        _ => "Published".into(),
                    },
                    false,
                ),
                Some("queued") | Some("sending") => ("Publishing…".into(), false),
                Some("failed") => (target["error"].as_str().unwrap_or("Failed to post").to_string(), true),
                _ => ("Not sent yet".into(), false),
            };
            let mut line = row()
                .key(format!("delivery-{acct_id}"))
                .gap(10.0)
                .center_y()
                .child(el().size(8.0, 8.0).fill(theme::platform_color(platform)))
                .child(text(format!("{} · {handle}: {note}", theme::platform_label(platform))).font(theme::mono(12.0)).color(if alert { theme::coral() } else { theme::FG }).wrap().grow(1.0));
            if state == Some("failed") || state.is_none() {
                let retry_acct = acct_id.clone();
                line = line.child(ui::button(format!("retry-{acct_id}"), if state == Some("failed") { "Retry" } else { "Send" }, ui::Kind::Outline).on_press(move |s: &mut App| {
                    if let Some(edit) = &s.draft {
                        let draft = edit.to_save_json();
                        s.send(Cmd::PublishDraft { draft, account_ids: Some(vec![retry_acct.clone()]) });
                    }
                }));
            }
            if state == Some("published") && platform == "youtube" && edit.youtube_visibility != "public" {
                if let Some(video_id) = target["platformPostId"].as_str().map(str::to_string) {
                    let yt_acct = acct_id.clone();
                    line = line.child(ui::button(format!("yt-public-{acct_id}"), "Make public", ui::Kind::Outline).on_press(move |s: &mut App| {
                        s.send(Cmd::Action {
                            name: "publish:updateYouTubePost",
                            args: json!({ "accountId": yt_acct, "videoId": video_id, "visibility": "public" }),
                            success: Some("YouTube video is now public.".into()),
                        });
                    }));
                }
            }
            if let Some(url) = target["permalink"].as_str() {
                line = line.child(ui::button(format!("open-del-{acct_id}"), "Open", ui::Kind::Ghost).on_press_tx(crate::pages::open(url.to_string())));
            }
            status_list = status_list.child(line);
        }
        content = content.child(status_list);
    }

    // 6. Live per-platform previews (updates on every keystroke & Claude edit!)
    content = content.child(
        col()
            .gap(10.0)
            .child(text("LIVE PLATFORM PREVIEWS").font(theme::label(10.0)).color(theme::DIM))
            .child(preview::live_strip(s, edit)),
    );

    col()
        .key("studio-editor")
        .grow(1.0)
        .min_w(0.0)
        .min_h(0.0)
        .h_full()
        .scroll(ScrollSpec { stick_bottom: false })
        .child(content)
}

pub fn view(s: &App) -> El {
    let body = match s.studio.layout {
        Layout::Split => row()
            .grow(1.0)
            .min_h(0.0)
            .child(col().w(420.0).min_w(320.0).h_full().child(claude_pane(s)))
            .child(el().w(2.0).h_full().fill(theme::line()))
            .child(col().grow(1.0).min_w(0.0).h_full().child(editor_pane(s))),
        Layout::Claude => col().grow(1.0).min_h(0.0).child(claude_pane(s)),
        Layout::Editor => col().grow(1.0).min_h(0.0).child(editor_pane(s)),
    };
    col().key("studio").grow(1.0).min_h(0.0).h_full().child(top_bar(s)).child(body)
}

/// Populates a realistic Studio scene for headless screenshots (`--snap --scene studio`).
pub fn sample_scene(s: &mut App) {
    s.tab = Tab::Studio;
    s.studio.layout = Layout::Split;
    s.studio.has_claude = true;
    let accounts: Vec<String> = s
        .accounts()
        .iter()
        .filter(|a| matches!(a["platform"].as_str(), Some("x" | "linkedin" | "instagram")))
        .take(3)
        .filter_map(|a| a["_id"].as_str().map(str::to_string))
        .collect();
    let mut edit = DraftEdit::new(
        None,
        "Just embedded Claude Code straight into BuddySocials Studio.\n\nIdea on the left, live platform previews on the right, direct publishing to every social account.",
        accounts,
    );
    edit.platform_text.insert(
        "x".into(),
        TextEdit::new("Embedded Claude Code right inside BuddySocials Studio — idea on the left, live previews on the right, one click to publish everywhere."),
    );
    s.draft = Some(edit);

    let mut t = Thread::new("sample-1".into(), claude::default_cwd());
    t.title = "Launch post".into();
    t.session_id = Some("sess-demo".into());
    t.items = vec![
        ChatItem::User { text: "Turn our new Claude Code Studio integration into a crisp launch post tailored for X and LinkedIn.".into() },
        ChatItem::Tool {
            id: "t1".into(),
            name: "studio: get context".into(),
            summary: String::new(),
            output: None,
            state: ToolState::Done,
        },
        ChatItem::Tool {
            id: "t2".into(),
            name: "studio: update draft".into(),
            summary: "Just embedded Claude Code straight into BuddySocials Studio.".into(),
            output: None,
            state: ToolState::Done,
        },
        ChatItem::Assistant {
            text: "Updated your live draft with a punchy core post plus a tighter X version (141 / 280 chars). Check the previews on the right — ready to schedule or publish whenever you are.".into(),
            streaming: false,
        },
    ];
    s.studio.threads = vec![t];
    s.studio.active_thread = 0;
}
