//! BuddySocials Studio: the Idea → Final Post workbench.
//!
//! A modular row of panels the user arranges: the embedded Claude Code conversation (one
//! continuous session, same stream-json + `--resume` + loopback MCP bridge pattern as T3
//! Code), the post editor, and live platform previews. Each panel can be moved left or right,
//! hidden, and resized by dragging the divider; the arrangement is remembered on disk.

use std::path::PathBuf;

use rune::{Cursor, Drag, El, FileDialogOptions, Phase, ScrollSpec, TextEdit, Tx, col, el, row, text, text_input};
use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};

use crate::backend::Cmd;
use crate::claude::{self, ChatItem, ClaudeEvent, Runner, Thread, ToolState};
use crate::studio_bridge::{ActiveDraftSnapshot, BridgeInfo, DraftPatch, Snapshot};
use crate::{App, DraftEdit, Tab, config, fmt, media, preview, theme, ui};

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum Panel {
    Claude,
    Editor,
    Preview,
}

impl Panel {
    fn label(self) -> &'static str {
        match self {
            Panel::Claude => "Claude",
            Panel::Editor => "Post",
            Panel::Preview => "Preview",
        }
    }

    fn key(self) -> &'static str {
        match self {
            Panel::Claude => "claude",
            Panel::Editor => "editor",
            Panel::Preview => "preview",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Slot {
    pub panel: Panel,
    pub visible: bool,
    /// Width in points when this panel isn't the one that fills the leftover space.
    pub width: f32,
}

/// Panels left to right. The editor fills the leftover width when shown; otherwise the last
/// visible panel does.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Layout {
    pub slots: Vec<Slot>,
}

const MIN_PANEL: f32 = 260.0;
const MAX_PANEL: f32 = 1400.0;

impl Default for Layout {
    fn default() -> Self {
        Layout {
            slots: vec![
                Slot { panel: Panel::Claude, visible: true, width: 420.0 },
                Slot { panel: Panel::Editor, visible: true, width: 560.0 },
                Slot { panel: Panel::Preview, visible: true, width: 300.0 },
            ],
        }
    }
}

impl Layout {
    fn path() -> Option<PathBuf> {
        Some(config::data_dir()?.join("studio-layout.json"))
    }

    fn load() -> Self {
        let mut layout: Layout = Self::path()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|raw| serde_json::from_slice(&raw).ok())
            .unwrap_or_default();
        // Keep exactly one slot per panel, whatever was on disk.
        for panel in [Panel::Claude, Panel::Editor, Panel::Preview] {
            if !layout.slots.iter().any(|slot| slot.panel == panel) {
                layout.slots.push(Slot { panel, visible: true, width: 360.0 });
            }
        }
        let mut seen = Vec::new();
        layout.slots.retain(|slot| {
            let fresh = !seen.contains(&slot.panel);
            seen.push(slot.panel);
            fresh
        });
        if !layout.slots.iter().any(|slot| slot.visible) {
            layout = Layout::default();
        }
        layout
    }

    fn save(&self) {
        let Some(path) = Self::path() else { return };
        let Ok(raw) = serde_json::to_vec_pretty(self) else { return };
        std::thread::spawn(move || {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(path, raw);
        });
    }

    fn visible(&self) -> Vec<usize> {
        (0..self.slots.len()).filter(|&i| self.slots[i].visible).collect()
    }

    /// The slot that fills the leftover width.
    fn filler(&self) -> Option<usize> {
        let shown = self.visible();
        shown.iter().copied().find(|&i| self.slots[i].panel == Panel::Editor).or_else(|| shown.last().copied())
    }

    fn index(&self, panel: Panel) -> usize {
        self.slots.iter().position(|slot| slot.panel == panel).unwrap_or(0)
    }

    fn toggle(&mut self, panel: Panel) {
        let i = self.index(panel);
        let shown = self.visible().len();
        if self.slots[i].visible && shown <= 1 {
            return;
        }
        self.slots[i].visible = !self.slots[i].visible;
        self.save();
    }

    /// Moves a panel past its next visible neighbour on that side.
    fn shift(&mut self, panel: Panel, right: bool) {
        let i = self.index(panel);
        let shown = self.visible();
        let pos = shown.iter().position(|&v| v == i);
        let target = match (pos, right) {
            (Some(p), true) => shown.get(p + 1).copied(),
            (Some(p), false) if p > 0 => shown.get(p - 1).copied(),
            _ => None,
        };
        if let Some(j) = target {
            self.slots.swap(i, j);
            self.save();
        }
    }
}

pub struct StudioState {
    pub layout: Layout,
    /// The one continuous Claude Code conversation; Claude Code compacts it on its own.
    pub thread: Thread,
    pub prompt: TextEdit,
    pub runner: Runner,
    pub bridge: Option<BridgeInfo>,
    pub has_claude: bool,
}

impl StudioState {
    pub fn new() -> Self {
        StudioState {
            layout: Layout::load(),
            thread: claude::load_chat(),
            prompt: TextEdit::new(""),
            runner: Runner::default(),
            bridge: None,
            has_claude: claude::find_binary().is_some(),
        }
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
    s.studio.thread.draft_id = s.draft.as_ref().and_then(|d| d.id.clone());
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

/// Folds streaming Claude Code events into the Studio conversation. Returns true if anything visible changed.
pub fn absorb_claude(s: &mut App) -> bool {
    let events = s.studio.runner.drain();
    if events.is_empty() {
        return false;
    }
    let mut persist = false;
    let t = &mut s.studio.thread;
    for event in events {
        match event {
            ClaudeEvent::Session { session_id, .. } => {
                t.session_id = Some(session_id);
                persist = true;
            }
            ClaudeEvent::TextDelta { delta, .. } => match t.items.last_mut() {
                Some(ChatItem::Assistant { text, streaming }) if *streaming => text.push_str(&delta),
                _ => t.items.push(ChatItem::Assistant { text: delta, streaming: true }),
            },
            ClaudeEvent::AssistantText { text, .. } => t.items.push(ChatItem::Assistant { text, streaming: false }),
            ClaudeEvent::ToolStart { id, name, .. } => {
                if let Some(ChatItem::Assistant { streaming, .. }) = t.items.last_mut() {
                    *streaming = false;
                }
                if !t.items.iter().any(|item| matches!(item, ChatItem::Tool { id: existing, .. } if existing == &id)) {
                    t.items.push(ChatItem::Tool { id, name, summary: String::new(), output: None, state: ToolState::Running });
                }
            }
            ClaudeEvent::ToolInput { id, name, summary, .. } => {
                if let Some(ChatItem::Tool { name: n, summary: s_out, .. }) =
                    t.items.iter_mut().find(|item| matches!(item, ChatItem::Tool { id: existing, .. } if existing == &id))
                {
                    *n = name;
                    *s_out = summary;
                } else {
                    t.items.push(ChatItem::Tool { id, name, summary, output: None, state: ToolState::Running });
                }
            }
            ClaudeEvent::ToolResult { id, output, is_error, .. } => {
                if let Some(ChatItem::Tool { output: out_slot, state, .. }) =
                    t.items.iter_mut().find(|item| matches!(item, ChatItem::Tool { id: existing, .. } if existing == &id))
                {
                    *out_slot = (!output.is_empty()).then_some(output);
                    *state = if is_error { ToolState::Error } else { ToolState::Done };
                }
            }
            ClaudeEvent::Done { session_id, cost_usd, error, .. } => {
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
    if persist {
        claude::save_chat(&s.studio.thread);
    }
    true
}

fn send_prompt(s: &mut App, text_to_send: String) {
    let prompt = text_to_send.trim().to_string();
    if prompt.is_empty() || s.studio.thread.running {
        return;
    }
    ensure_draft(s);
    sync_snapshot(s);
    let bridge = s.studio.bridge.clone();
    let runner = s.studio.runner.clone();
    let thread = &mut s.studio.thread;
    thread.items.push(ChatItem::User { text: prompt.clone() });
    thread.running = true;
    let (id, session, cwd, model, effort, mode) =
        (thread.id.clone(), thread.session_id.clone(), thread.cwd.clone(), thread.model, thread.effort, thread.mode);
    claude::save_chat(thread);
    runner.send(id, prompt, session, cwd, model, effort, mode, bridge);
}

fn submit_prompt(s: &mut App) {
    if s.studio.thread.running {
        return;
    }
    let prompt = std::mem::take(&mut s.studio.prompt.text);
    s.studio.prompt.clear();
    send_prompt(s, prompt);
}

fn pick_folder(s: &mut App, tx: &mut Tx) {
    let current = PathBuf::from(&s.studio.thread.cwd);
    let options = FileDialogOptions {
        title: "Choose workspace folder for Claude Code".into(),
        directory: current.is_dir().then_some(current),
        ..Default::default()
    };
    tx.open_folder(options, |s: &mut App, result, _| match result {
        Ok(Some(path)) => {
            s.studio.thread.cwd = path.to_string_lossy().into_owned();
            claude::save_chat(&s.studio.thread);
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

// ---------------------------------------------------------------- small controls

/// A quiet text control: no border, dim until active.
fn link(key: impl Into<String>, label: &str, active: bool) -> El {
    row()
        .key(key)
        .role("button")
        .label(label)
        .h(24.0)
        .px(6.0)
        .center()
        .cursor(Cursor::Pointer)
        .hover(theme::FG.alpha(0.08))
        .child(text(label.to_uppercase()).font(theme::label(10.0)).color(if active { theme::FG } else { theme::FAINT }))
}

// ---------------------------------------------------------------- UI: top bar

fn top_bar(s: &App) -> El {
    let drafts = s.query("drafts:list", json!({})).and_then(Json::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let open_id = s.draft.as_ref().and_then(|d| d.id.as_deref());
    let mut switcher = row().gap(2.0).center_y().grow(1.0).min_w(0.0);
    switcher = switcher.child(link("studio-new-draft", "+ New", false).on_press(new_draft));
    let open: Vec<&Json> = drafts.iter().filter(|d| d["status"] != "published").collect();
    for draft in open.iter().take(3) {
        let id = draft["_id"].as_str().unwrap_or("").to_string();
        let heading = draft["title"]
            .as_str()
            .filter(|t| !t.trim().is_empty())
            .or_else(|| draft["text"].as_str().and_then(|t| t.trim().lines().next()))
            .unwrap_or("Untitled");
        let draft_clone = (*draft).clone();
        switcher = switcher.child(
            link(format!("studio-pick-{id}"), &short_label(heading, 18), open_id == Some(id.as_str()))
                .on_press(move |s: &mut App| open_saved_draft(s, &draft_clone)),
        );
    }
    if open.len() > 3 {
        switcher = switcher.child(link("studio-all-drafts", &format!("+{}", open.len() - 3), false).on_press(|s: &mut App| {
            s.tab = Tab::Posts;
            s.show_drafts = true;
        }));
    }

    let mut panels = row().gap(2.0).center_y().pl(12.0).border_sides([0.0, 0.0, 0.0, 1.0], theme::line());
    for slot in &s.studio.layout.slots {
        let panel = slot.panel;
        panels = panels.child(
            link(format!("studio-panel-toggle-{}", panel.key()), panel.label(), slot.visible)
                .on_press(move |s: &mut App| s.studio.layout.toggle(panel)),
        );
    }
    row()
        .key("studio-topbar")
        .px(16.0)
        .h(44.0)
        .gap(16.0)
        .center_y()
        .border_sides([0.0, 0.0, 1.0, 0.0], theme::line())
        .child(switcher)
        .child(panels)
}

// ---------------------------------------------------------------- UI: Claude Code panel

fn claude_pane(s: &App) -> El {
    let thread = &s.studio.thread;
    let mut feed = col().px(16.0).py(16.0).gap(14.0);
    if !s.studio.has_claude {
        feed = feed.child(
            text("Claude Code (`claude`) isn't installed. Install it and sign in once in a terminal; BuddySocials runs your local Claude Code, no API key needed.")
                .font(theme::mono(12.0))
                .color(theme::coral())
                .wrap(),
        );
    } else if thread.items.is_empty() {
        feed = feed.child(
            text("Tell Claude what you made. It writes the post straight into the editor.")
                .font(theme::mono(12.0))
                .color(theme::FAINT)
                .wrap(),
        );
        let starters = [
            ("Turn an idea into a post", "Help me turn a rough idea into a multi-platform post. Check my connected accounts and recent top posts so you match my voice, then ask me what I want to share."),
            ("Tailor the open draft per platform", "Inspect my open draft with studio_get_context and tailor it for every selected platform. Update the draft directly."),
            ("Pitch 3 ideas from my top posts", "Check my recent posts and open comments, see what resonated, and pitch 3 sharp post ideas I could publish today."),
        ];
        let mut list = col().gap(2.0);
        for (i, (label, prompt)) in starters.into_iter().enumerate() {
            let prompt = prompt.to_string();
            list = list.child(
                row()
                    .key(format!("claude-starter-{i}"))
                    .py(6.0)
                    .gap(8.0)
                    .center_y()
                    .cursor(Cursor::Pointer)
                    .hover(theme::FG.alpha(0.06))
                    .on_press(move |s: &mut App| send_prompt(s, prompt.clone()))
                    .child(text("→").font(theme::label(11.0)).color(theme::coral()))
                    .child(text(label).font(theme::mono(12.0)).color(theme::DIM).wrap().grow(1.0)),
            );
        }
        feed = feed.child(list);
    } else {
        // Render only the tail: the conversation is continuous and can grow long.
        let skip = thread.items.len().saturating_sub(160);
        for (idx, item) in thread.items.iter().enumerate().skip(skip) {
            feed = feed.child(match item {
                ChatItem::User { text: body } => row()
                    .key(format!("msg-user-{idx}"))
                    .pl(10.0)
                    .border_sides([0.0, 0.0, 0.0, 2.0], theme::coral())
                    .child(text(body.clone()).font(theme::mono(13.0)).color(theme::FG).wrap().grow(1.0)),
                ChatItem::Assistant { text: body, .. } => {
                    text(body.clone()).key(format!("msg-asst-{idx}")).font(theme::mono(13.0)).color(theme::DIM).wrap()
                }
                ChatItem::Tool { name, summary, output, state, .. } => {
                    let color = match state {
                        ToolState::Running => theme::coral(),
                        ToolState::Done => theme::FAINT,
                        ToolState::Error => theme::coral(),
                    };
                    let mut line = name.clone();
                    if !summary.is_empty() {
                        line = format!("{line} · {summary}");
                    }
                    if *state == ToolState::Error {
                        if let Some(out) = output {
                            line = format!("{line} — {out}");
                        }
                    }
                    row()
                        .key(format!("msg-tool-{idx}"))
                        .gap(8.0)
                        .center_y()
                        .child(text(if *state == ToolState::Running { "◦" } else { "·" }).font(theme::label(11.0)).color(color))
                        .child(text(line).font(theme::mono(11.0)).color(color).truncate().grow(1.0))
                }
                ChatItem::Notice { text: msg, error } => text(msg.clone())
                    .key(format!("msg-notice-{idx}"))
                    .font(theme::mono(11.0))
                    .color(if *error { theme::coral() } else { theme::FAINT })
                    .wrap(),
            });
        }
        if thread.running {
            feed = feed.child(text("WORKING…").font(theme::label(9.0)).color(theme::coral()));
        }
    }

    // Composer: input, then a quiet settings line (model · effort · access · folder).
    let running = thread.running;
    let settings = row()
        .gap(2.0)
        .center_y()
        .flex_wrap()
        .child(link("claude-model", thread.model.label(), true).on_press(|s: &mut App| {
            s.studio.thread.model = s.studio.thread.model.next();
            claude::save_chat(&s.studio.thread);
        }))
        .child(link("claude-effort", thread.effort.cli_name(), false).on_press(|s: &mut App| {
            s.studio.thread.effort = s.studio.thread.effort.next();
            claude::save_chat(&s.studio.thread);
        }))
        .child(link("claude-mode", thread.mode.label(), false).on_press(|s: &mut App| {
            s.studio.thread.mode = s.studio.thread.mode.next();
            claude::save_chat(&s.studio.thread);
        }))
        .child(link("claude-cwd", &folder_label(&thread.cwd), false).on_press_tx(pick_folder))
        .child(col().grow(1.0))
        .child(if running {
            link("claude-stop", "Stop", true).on_press(|s: &mut App| {
                let id = s.studio.thread.id.clone();
                s.studio.runner.stop(&id);
            })
        } else {
            link("claude-send", "Send ↵", true).on_press(submit_prompt)
        });

    let composer = col()
        .px(12.0)
        .pt(10.0)
        .pb(8.0)
        .gap(6.0)
        .border_sides([1.0, 0.0, 0.0, 0.0], theme::line())
        .child(
            col().min_h(44.0).max_h(180.0).px(4.0).py(4.0).child(
                text_input(&s.studio.prompt, theme::mono(13.0))
                    .key("claude-prompt")
                    .w_full()
                    .color(theme::FG)
                    .caret(theme::coral(), theme::coral().alpha(0.4))
                    .placeholder("Ask Claude…  (Shift+Return for a new line)", theme::FAINT)
                    .on_edit(|s: &mut App| &mut s.studio.prompt)
                    .on_submit(|s: &mut App, _| submit_prompt(s)),
            ),
        )
        .child(settings);

    col()
        .key("studio-claude")
        .grow(1.0)
        .min_h(0.0)
        .h_full()
        .child(col().key("studio-claude-scroll").grow(1.0).min_h(0.0).scroll(ScrollSpec { stick_bottom: true }).child(feed))
        .child(composer)
}

// ---------------------------------------------------------------- UI: preview panel

fn preview_pane(s: &App) -> El {
    let body = match &s.draft {
        Some(edit) => preview::live_strip(s, edit),
        None => text("Open a draft to see it on each platform.").font(theme::mono(12.0)).color(theme::FAINT),
    };
    col()
        .key("studio-preview")
        .grow(1.0)
        .min_h(0.0)
        .h_full()
        .scroll(ScrollSpec { stick_bottom: false })
        .child(col().padding(16.0).child(body))
}

// ---------------------------------------------------------------- UI: post editor panel

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
            .gap(8.0)
            .child(text("No post open.").font(theme::mono(12.0)).color(theme::FAINT))
            .child(link("studio-start-empty", "+ New post", true).on_press(new_draft));
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
        .py(16.0)
        .gap(14.0)
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
                .h(26.0)
                .px(8.0)
                .gap(6.0)
                .center_y()
                .opacity(if chosen { 1.0 } else { 0.45 })
                .border(1.0, if chosen { theme::FG.alpha(0.5) } else { theme::line() })
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
                .child(el().size(7.0, 7.0).fill(theme::platform_color(platform)))
                .child(text(handle.to_string()).font(theme::mono(11.0)).color(theme::FG)),
        );
    }
    if s.accounts().is_empty() {
        account_chips = account_chips.child(
            ui::button("studio-connect-first", "Connect an account", ui::Kind::Outline).on_press(|s: &mut App| {
                s.tab = Tab::Accounts;
            }),
        );
    } else {
        account_chips = account_chips.child(link("studio-select-all", "All", false).on_press(|s: &mut App| {
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
    content = content.child(account_chips);

    // 2. YouTube controls (title + visibility) whenever YouTube is targeted
    if selected_platforms.iter().any(|p| p == "youtube") {
        let title_len = edit.title.text.trim().chars().count();
        let mut vis_row = row().gap(2.0).center_y();
        for vis in ["public", "unlisted", "private"] {
            let v_str = vis.to_string();
            vis_row = vis_row.child(link(format!("yt-vis-{vis}"), vis, edit.youtube_visibility == vis).on_press(move |s: &mut App| {
                if let Some(edit) = &mut s.draft {
                    edit.youtube_visibility = v_str.clone();
                    edit.confirming = false;
                }
            }));
        }
        content = content.child(
            col()
                .key("studio-youtube")
                .gap(4.0)
                .child(
                    row().h(34.0).gap(8.0).center_y().border_sides([0.0, 0.0, 1.0, 0.0], theme::line()).child(
                        text_input(&edit.title, theme::mono(13.0))
                            .key("studio-title")
                            .single_line()
                            .grow(1.0)
                            .color(theme::FG)
                            .caret(theme::coral(), theme::coral().alpha(0.4))
                            .placeholder("YouTube title (defaults to the first line)", theme::FAINT)
                            .on_edit(|s: &mut App| &mut s.draft.as_mut().expect("draft open").title),
                    )
                    .child(text(format!("{title_len}/100")).font(theme::label(9.0)).color(if title_len > 100 { theme::coral() } else { theme::FAINT })),
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

    let mut tab_bar = row().gap(2.0).flex_wrap().center_y();
    tab_bar = tab_bar.child(link("copy-tab-core", "All", active_tab == "core").on_press(|s: &mut App| {
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
        tab_bar = tab_bar.child(link(format!("copy-tab-{platform}"), &label, active_tab == *platform).on_press(move |s: &mut App| {
            if let Some(edit) = &mut s.draft {
                edit.active_copy_tab = p_key.clone();
                edit.platform_text.entry(p_key.clone()).or_insert_with(|| TextEdit::new(""));
            }
        }));
    }
    if active_tab != "core" && edit.has_override(&active_tab) {
        let clear_key = active_tab.clone();
        tab_bar = tab_bar.child(col().grow(1.0)).child(link("copy-reset-core", "Use shared text", false).on_press(move |s: &mut App| {
            if let Some(edit) = &mut s.draft {
                edit.platform_text.remove(&clear_key);
            }
        }));
    }

    let active_edit = edit.text_edit_for_tab(&active_tab);
    let placeholder = if active_tab == "core" {
        "Write the post, or ask Claude…"
    } else {
        "Text for this platform only (blank uses the shared text)"
    };

    let mut counts = row().gap(14.0).flex_wrap();
    if active_tab == "core" {
        for platform in &selected_platforms {
            if let Some(limit) = text_limit(platform) {
                let len = edit.text_for(platform).trim().chars().count();
                counts = counts.child(
                    text(format!("{} {len} / {limit}", theme::platform_label(platform)).to_uppercase())
                            .font(theme::label(9.0))
                        .color(if len > limit { theme::coral() } else { theme::FAINT }),
                );
            }
        }
    } else if let Some(limit) = text_limit(&active_tab) {
        let len = edit.text_for(&active_tab).trim().chars().count();
        counts = counts.child(
            text(format!("{} {len} / {limit}", theme::platform_label(&active_tab)).to_uppercase())
                .font(theme::label(9.0))
                .color(if len > limit { theme::coral() } else { theme::FAINT }),
        );
    }

    let active_tab_for_edit = active_tab.clone();
    let mut editor_box = col()
        .gap(10.0)
        .padding(if edit.drop_over { 10.0 } else { 0.0 })
        .border(if edit.drop_over { 1.0 } else { 0.0 }, theme::coral());
    if !selected_platforms.is_empty() {
        editor_box = editor_box.child(tab_bar);
    }
    let editor_box = editor_box
        .child(
            col().min_h(160.0).child(
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
        actions = actions.child(ui::button("studio-save", "Save", ui::Kind::Outline).on_press(|s: &mut App| {
            if let Some(edit) = &s.draft {
                let payload = edit.to_save_json();
                s.send(Cmd::SaveDraft { draft: payload, quiet: false });
            }
        }));
    } else {
        actions = actions.child(text("UPLOADING…").font(theme::label(10.0)).color(theme::FAINT));
    }
    if can_send {
        actions = actions.child(
            ui::button("studio-schedule-toggle", "Schedule", ui::Kind::Outline).on_press(|s: &mut App| {
                if let Some(edit) = &mut s.draft {
                    edit.show_schedule = !edit.show_schedule;
                }
            }),
        );
        actions = actions.child(
            ui::button("studio-publish", if edit.confirming { "Confirm — post now" } else { "Publish" }, ui::Kind::Primary).on_press(|s: &mut App| {
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
        actions = actions.child(col().grow(1.0)).child(link("studio-delete", "Delete", false).on_press(move |s: &mut App| {
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

    col()
        .key("studio-editor")
        .grow(1.0)
        .min_h(0.0)
        .h_full()
        .scroll(ScrollSpec { stick_bottom: false })
        .child(content)
}

/// A panel's slim header: its name, and controls to move it left or right or hide it.
fn panel_header(s: &App, panel: Panel) -> El {
    let shown = s.studio.layout.visible();
    let i = s.studio.layout.index(panel);
    let pos = shown.iter().position(|&v| v == i).unwrap_or(0);
    let mut bar = row()
        .key(format!("studio-panel-head-{}", panel.key()))
        .h(30.0)
        .px(10.0)
        .gap(2.0)
        .center_y()
        .border_sides([0.0, 0.0, 1.0, 0.0], theme::line())
        .child(text(panel.label().to_uppercase()).font(theme::label(9.0)).color(theme::FAINT).grow(1.0));
    if pos > 0 {
        bar = bar.child(link(format!("studio-panel-left-{}", panel.key()), "←", false).on_press(move |s: &mut App| s.studio.layout.shift(panel, false)));
    }
    if pos + 1 < shown.len() {
        bar = bar.child(link(format!("studio-panel-right-{}", panel.key()), "→", false).on_press(move |s: &mut App| s.studio.layout.shift(panel, true)));
    }
    if shown.len() > 1 {
        bar = bar.child(link(format!("studio-panel-hide-{}", panel.key()), "×", false).on_press(move |s: &mut App| s.studio.layout.toggle(panel)));
    }
    bar
}

/// The draggable line between two neighbouring panels. Dragging resizes whichever of the two
/// has a fixed width (the filler panel takes up the rest).
fn divider(left: usize, right: usize, filler: Option<usize>) -> El {
    let (target, sign) = if Some(left) == filler { (right, -1.0) } else { (left, 1.0) };
    row()
        .key(format!("studio-divider-{left}-{right}"))
        .w(7.0)
        .h_full()
        .center()
        .cursor(Cursor::ResizeColumn)
        .hover(theme::FG.alpha(0.06))
        .on_drag(move |s: &mut App, d: &mut Drag, _tx: &mut Tx| {
            let slot = &mut s.studio.layout.slots[target];
            match d.phase {
                Phase::Down => d.data = slot.width,
                Phase::Move => slot.width = (d.data + sign * d.dx).clamp(MIN_PANEL, MAX_PANEL),
                Phase::Up => {
                    if d.cancelled() {
                        slot.width = d.data;
                    }
                    s.studio.layout.save();
                }
            }
        })
        .child(el().w(1.0).h_full().fill(theme::line()))
}

pub fn view(s: &App) -> El {
    let layout = &s.studio.layout;
    let shown = layout.visible();
    let filler = layout.filler();
    let mut body = row().key("studio-panels").grow(1.0).min_h(0.0);
    for (n, &i) in shown.iter().enumerate() {
        if n > 0 {
            body = body.child(divider(shown[n - 1], i, filler));
        }
        let slot = &layout.slots[i];
        let content = match slot.panel {
            Panel::Claude => claude_pane(s),
            Panel::Editor => editor_pane(s),
            Panel::Preview => preview_pane(s),
        };
        let mut frame = col()
            .key(format!("studio-panel-{}", slot.panel.key()))
            .h_full()
            .min_h(0.0)
            .child(panel_header(s, slot.panel))
            .child(col().grow(1.0).min_h(0.0).child(content));
        frame = if Some(i) == filler { frame.grow(1.0).min_w(MIN_PANEL) } else { frame.w(slot.width).min_w(MIN_PANEL) };
        body = body.child(frame);
    }
    col().key("studio").grow(1.0).min_h(0.0).h_full().child(top_bar(s)).child(body)
}

/// Populates a realistic Studio scene for headless screenshots (`--snap --scene studio`).
pub fn sample_scene(s: &mut App) {
    s.tab = Tab::Studio;
    s.studio.layout = Layout::default();
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

    let mut t = Thread::new("studio".into(), claude::default_cwd());
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
    s.studio.thread = t;
}
