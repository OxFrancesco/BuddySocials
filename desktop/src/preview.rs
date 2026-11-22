//! Drafts shown the way each platform will show them: a Short on YouTube, a Reel or a post
//! on Instagram, a video on TikTok, a post on LinkedIn and X.
//!
//! Used in two places:
//! 1. Live inside the Studio (`live_strip`), updating on every keystroke and every Claude Code edit.
//! 2. In the Posts → Drafts gallery (`gallery`), where clicking any card opens it in Studio.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use image::RgbaImage;
use rune::{El, Pixels, SurfaceFit, col, el, row, text};
use serde_json::{Value as Json, json};

use crate::{App, DraftEdit, Tab, fmt, theme, ui};

/// Width of one mock-up, and the long side of the pictures made for it.
const CARD: f32 = 224.0;
const THUMB_SIDE: u32 = 540;

pub struct Thumb {
    pub pixels: Pixels,
    /// Width and height once the picture has loaded.
    pub size: Option<(u32, u32)>,
}

/// A small picture of every draft's first attachment, by storage ID.
#[derive(Default)]
pub struct Thumbs {
    map: HashMap<String, Thumb>,
    done: Arc<Mutex<Vec<(String, Option<RgbaImage>)>>>,
    wake: Option<rune::Waker>,
}

impl Thumbs {
    pub fn set_waker(&mut self, wake: rune::Waker) {
        self.wake = Some(wake);
    }
}

fn ffmpeg() -> Option<PathBuf> {
    let listed = std::env::var_os("PATH").map(|path| std::env::split_paths(&path).collect::<Vec<_>>()).unwrap_or_default();
    listed.into_iter().chain(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from)).map(|dir| dir.join("ffmpeg")).find(|path| path.is_file())
}

/// Makes the picture for one attachment, or reads the copy made earlier.
fn load(id: &str, url: &str, video: bool) -> Option<RgbaImage> {
    let dir = crate::config::cache_dir()?.join("thumbs");
    std::fs::create_dir_all(&dir).ok()?;
    let file = dir.join(format!("{id}.jpg"));
    if !file.is_file() {
        let ffmpeg = ffmpeg()?;
        let scale = format!("scale={THUMB_SIDE}:{THUMB_SIDE}:force_original_aspect_ratio=decrease");
        // A second in, past a fade from black; a shorter video is tried again from its first frame.
        for seek in if video { vec![Some("1"), None] } else { vec![None] } {
            let mut command = Command::new(&ffmpeg);
            command.args(["-y", "-loglevel", "error"]);
            if let Some(seek) = seek {
                command.args(["-ss", seek]);
            }
            command.args(["-i", url, "-frames:v", "1", "-vf", &scale, "-q:v", "4"]).arg(&file).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            if command.status().is_ok_and(|status| status.success()) && file.is_file() {
                break;
            }
        }
    }
    image::open(&file).ok().map(|image| image.to_rgba8())
}

fn set(thumb: &mut Thumb, image: &RgbaImage) {
    thumb.pixels.set(image.width(), image.height(), image.as_raw().clone());
    thumb.size = Some((image.width(), image.height()));
}

/// Starts loading the picture of every draft that doesn't have one yet. `wait` loads them
/// before returning, for a window rendered once without a running app.
pub fn sync(s: &mut App, wait: bool) {
    let mut wanted = Vec::new();
    for draft in s.query("drafts:list", json!({})).and_then(Json::as_array).into_iter().flatten() {
        let first = draft["media"].as_array().and_then(|media| media.first());
        for (picture, video) in [(first, first.is_some_and(|first| first["kind"] == "video")), (Some(&draft["cover"]), false)] {
            let Some(picture) = picture else { continue };
            let (Some(id), Some(url)) = (picture["storageId"].as_str(), picture["url"].as_str()) else { continue };
            if !s.thumbs.map.contains_key(id) && !wanted.iter().any(|(known, _, _): &(String, String, bool)| known == id) {
                wanted.push((id.to_string(), url.to_string(), video));
            }
        }
    }
    if wanted.is_empty() {
        return;
    }
    for (id, _, _) in &wanted {
        s.thumbs.map.insert(id.clone(), Thumb { pixels: Pixels::new(), size: None });
    }
    if wait {
        for (id, url, video) in wanted {
            if let (Some(image), Some(thumb)) = (load(&id, &url, video), s.thumbs.map.get_mut(&id)) {
                set(thumb, &image);
            }
        }
        return;
    }
    let (done, wake) = (s.thumbs.done.clone(), s.thumbs.wake.clone());
    std::thread::spawn(move || {
        for (id, url, video) in wanted {
            let image = load(&id, &url, video);
            done.lock().unwrap().push((id, image));
            if let Some(wake) = &wake {
                wake();
            }
        }
    });
}

/// Folds loaded pictures into state. Returns whether anything changed.
pub fn absorb(s: &mut App) -> bool {
    let done = std::mem::take(&mut *s.thumbs.done.lock().unwrap());
    let changed = !done.is_empty();
    for (id, image) in done {
        if let (Some(image), Some(thumb)) = (image, s.thumbs.map.get_mut(&id)) {
            set(thumb, &image);
        }
    }
    changed
}

/// What a mock-up draws from.
struct Post<'a> {
    handle: &'a str,
    text: &'a str,
    /// The title shown on YouTube.
    title: &'a str,
    visibility: &'a str,
    pixels: Option<&'a Pixels>,
    size: Option<(u32, u32)>,
    video: bool,
    count: usize,
}

impl Post<'_> {
    fn shape(&self) -> f32 {
        match self.size {
            Some((width, height)) if width > 0 => height as f32 / width as f32,
            _ if self.video => 16.0 / 9.0,
            _ => 1.0,
        }
    }

    fn upright(&self) -> bool {
        self.shape() > 1.1
    }
}

fn picture(post: &Post, height: f32) -> El {
    let frame = el().size(CARD, height).fill(theme::FG.alpha(0.08));
    match (post.pixels, post.size) {
        (Some(pixels), Some(_)) => frame.pixels_fit(pixels, SurfaceFit::Fill),
        _ => frame.child(
            col().size(CARD, height).center().child(
                text(if post.count == 0 {
                    "NO MEDIA"
                } else if post.video {
                    "VIDEO"
                } else {
                    "IMAGE"
                })
                .font(theme::label(10.0))
                .color(theme::FAINT),
            ),
        ),
    }
}

fn tag(label: &str, left: f32, top: f32) -> El {
    row().absolute(left, top).px(6.0).py(3.0).fill(theme::BG.alpha(0.76)).child(text(label.to_uppercase()).font(theme::label(9.0)).color(theme::FG))
}

fn full_screen(post: &Post, kind: &str, caption: Option<&str>, note: Option<&str>) -> El {
    let height = (CARD * 13.0 / 9.0).round();
    let mut words = col().absolute(0.0, height - 86.0).size(CARD, 86.0).px(10.0).py(8.0).gap(3.0).fill(theme::BG.alpha(0.65));
    words = words.child(text(format!("@{}", post.handle)).font(theme::label(11.0)).color(theme::FG).truncate());
    if let Some(caption) = caption.filter(|caption| !caption.is_empty()) {
        words = words.child(text(caption.to_string()).font(theme::mono(11.0)).color(theme::FG).max_lines(2));
    }
    if let Some(note) = note {
        words = words.child(text(note.to_string()).font(theme::mono(10.0)).color(theme::DIM).max_lines(2));
    }
    el().size(CARD, height).child(picture(post, height).absolute(0.0, 0.0)).child(tag(kind, 8.0, 8.0)).child(words)
}

fn byline(post: &Post, under: &str) -> El {
    row().gap(8.0).center_y().child(el().size(28.0, 28.0).radius(14.0).fill(theme::FG.alpha(0.16))).child(
        col()
            .grow(1.0)
            .min_w(0.0)
            .child(text(post.handle.to_string()).font(theme::label(11.0)).color(theme::FG).truncate())
            .child(text(under.to_string()).font(theme::mono(10.0)).color(theme::FAINT).truncate()),
    )
}

fn inline_picture(post: &Post, tallest: f32) -> El {
    let height = (CARD * post.shape()).clamp(CARD * 9.0 / 16.0, CARD * tallest).round();
    let mut frame = el().size(CARD, height).child(picture(post, height).absolute(0.0, 0.0));
    if post.video {
        frame = frame.child(tag("Video", 8.0, 8.0));
    }
    if post.count > 1 {
        frame = frame.child(tag(&format!("1 / {}", post.count), CARD - 54.0, 8.0));
    }
    frame
}

fn mock(platform: &str, post: &Post) -> El {
    let vis_label = match post.visibility {
        "public" => "Public",
        "private" => "Private",
        _ => "Unlisted",
    };
    match platform {
        "youtube" if post.video && post.upright() => full_screen(post, &format!("Short · {vis_label}"), Some(post.title), None),
        "youtube" => {
            let height = (CARD * 9.0 / 16.0).round();
            col()
                .gap(8.0)
                .child(el().size(CARD, height).child(picture(post, height).absolute(0.0, 0.0)))
                .child(text(post.title.to_string()).font(theme::mono(13.0)).color(theme::FG).max_lines(2))
                .child(text(format!("{} · {vis_label}", post.handle)).font(theme::mono(10.0)).color(theme::FAINT).truncate())
        }
        "tiktok" => full_screen(post, "TikTok", None, Some("Caption and privacy are set in the TikTok app.")),
        "instagram" if post.video => full_screen(post, "Reel", Some(post.text), None),
        "instagram" => {
            let mut card = col().gap(8.0).child(byline(post, "Instagram")).child(inline_picture(post, 1.15));
            if !post.text.is_empty() {
                card = card.child(text(format!("{} {}", post.handle, post.text)).font(theme::mono(11.0)).color(theme::FG).max_lines(3));
            }
            card
        }
        _ => {
            let mut card = col().gap(8.0).child(byline(post, if platform == "x" { "now" } else { "Now · Anyone" }));
            if !post.text.is_empty() {
                card = card.child(text(post.text.to_string()).font(theme::mono(11.0)).color(theme::FG).max_lines(if post.count > 0 { 4 } else { 8 }));
            }
            if post.count > 0 {
                card = card.child(inline_picture(post, 1.15));
            }
            card
        }
    }
}

fn standing(target: &Json, visibility: &str) -> (String, bool) {
    let platform = target["platform"].as_str().unwrap_or("");
    match target["state"].as_str() {
        Some("published") => (
            match platform {
                "youtube" => format!("On YouTube ({visibility})"),
                "tiktok" => "In your TikTok inbox".to_string(),
                _ => "Posted".to_string(),
            },
            false,
        ),
        Some("queued") | Some("sending") => ("Sending…".to_string(), false),
        Some("failed") => (target["error"].as_str().unwrap_or("Not sent").to_string(), true),
        _ => match target["issues"].as_array().and_then(|issues| issues.first()).and_then(Json::as_str) {
            Some(issue) => (issue.to_string(), true),
            None => ("Ready to post".to_string(), false),
        },
    }
}

fn card(target: &Json, post: &Post, visibility: &str) -> El {
    let platform = target["platform"].as_str().unwrap_or("");
    let (note, alert) = standing(target, visibility);
    let sent = target["state"] == "published";
    let mut foot = row().gap(8.0).center_y().child(
        text(note)
            .font(theme::mono(11.0))
            .color(if alert {
                theme::coral()
            } else if sent {
                theme::FG
            } else {
                theme::DIM
            })
            .max_lines(3)
            .grow(1.0)
            .min_w(0.0),
    );
    if let Some(url) = target["permalink"].as_str() {
        foot = foot.child(ui::button(format!("open-{}", target["accountId"].as_str().unwrap_or("")), "Open", ui::Kind::Ghost).on_press_tx(crate::pages::open(url.to_string())));
    }
    col()
        .w(CARD)
        .gap(10.0)
        .child(
            row()
                .gap(8.0)
                .center_y()
                .child(el().size(10.0, 10.0).fill(theme::platform_color(platform)))
                .child(text(theme::platform_label(platform).to_uppercase()).font(theme::label(10.0)).color(theme::FG)),
        )
        .child(mock(platform, post))
        .child(foot)
}

/// Live platform mock-ups inside the Studio editor, reflecting every unsaved edit in real time.
pub fn live_strip(s: &App, edit: &DraftEdit) -> El {
    let saved = edit.id.as_ref().and_then(|id| {
        s.query("drafts:list", json!({})).and_then(Json::as_array).and_then(|drafts| drafts.iter().find(|draft| draft["_id"] == id.as_str()))
    });
    let accounts = s.accounts();
    let selected: Vec<&Json> = edit
        .accounts
        .iter()
        .filter_map(|id| accounts.iter().find(|account| account["_id"].as_str() == Some(id.as_str())))
        .collect();
    if selected.is_empty() {
        return col()
            .padding(14.0)
            .border(1.0, theme::line())
            .child(text("Select one or more accounts above to see live platform previews.").font(theme::mono(12.0)).color(theme::FAINT));
    }
    let first_media = edit.media.first();
    let is_video = first_media.is_some_and(|item| item.kind == crate::media::Kind::Video);
    let mut cards = row().gap(16.0).flex_wrap().items_start();
    for account in selected {
        let id = account["_id"].as_str().unwrap_or("");
        let platform = account["platform"].as_str().unwrap_or("");
        let handle = account["handle"].as_str().unwrap_or("");
        let resolved = edit.text_for(platform);
        let body = resolved.trim();
        let explicit_title = edit.title.text.trim();
        let first_line = body.lines().find(|line| !line.trim().is_empty()).unwrap_or("").trim();
        let title = if !explicit_title.is_empty() {
            explicit_title
        } else if !first_line.is_empty() {
            first_line
        } else {
            "No title"
        };
        let cover_thumb = edit.cover.as_ref().filter(|_| platform != "tiktok");
        let (pixels, size) = if let Some(cov) = cover_thumb.filter(|c| c.size.is_some()) {
            (Some(&cov.thumb), cov.size)
        } else if let Some(cov_id) = cover_thumb.and_then(|c| c.storage_id.as_deref()).and_then(|cid| s.thumbs.map.get(cid)) {
            (Some(&cov_id.pixels), cov_id.size)
        } else if let Some(item) = first_media {
            if let Some(base) = &item.base {
                (Some(&item.thumb), Some((base.width(), base.height())))
            } else if let Some(stored) = item.saved.as_ref().and_then(|s| s["storageId"].as_str()).and_then(|sid| s.thumbs.map.get(sid)) {
                (Some(&stored.pixels), stored.size)
            } else {
                (None, None)
            }
        } else {
            (None, None)
        };
        let post = Post {
            handle,
            text: body,
            title,
            visibility: &edit.youtube_visibility,
            pixels,
            size,
            video: is_video,
            count: edit.media.len(),
        };
        let saved_target = saved
            .and_then(|draft| draft["targets"].as_array())
            .and_then(|targets| targets.iter().find(|t| t["accountId"].as_str() == Some(id)));
        let (note, alert) = if let Some(target) = saved_target.filter(|t| t["state"].is_string()) {
            standing(target, &edit.youtube_visibility)
        } else {
            let live_issue = edit.live_issue(account);
            match live_issue {
                Some(issue) => (issue, true),
                None => ("Ready to post".to_string(), false),
            }
        };
        let tailored = edit.has_override(platform);
        let mut head = row()
            .gap(8.0)
            .center_y()
            .child(el().size(10.0, 10.0).fill(theme::platform_color(platform)))
            .child(text(theme::platform_label(platform).to_uppercase()).font(theme::label(10.0)).color(theme::FG).grow(1.0));
        if tailored {
            head = head.child(text("TAILORED").font(theme::label(9.0)).color(theme::coral()));
        }
        cards = cards.child(
            col()
                .key(format!("live-preview-{id}"))
                .w(CARD + 20.0)
                .padding(10.0)
                .gap(10.0)
                .border(1.0, if alert { theme::coral() } else { theme::line() })
                .child(head)
                .child(mock(platform, &post))
                .child(text(note).font(theme::mono(11.0)).color(if alert { theme::coral() } else { theme::DIM }).max_lines(2)),
        );
    }
    cards
}

/// One draft in the Drafts gallery: a mock-up per account it goes to. Pressing opens it in Studio.
fn group(s: &App, draft: &Json) -> El {
    let id = draft["_id"].as_str().unwrap_or("").to_string();
    let core_body = draft["text"].as_str().unwrap_or("").trim();
    let explicit_title = draft["title"].as_str().unwrap_or("").trim();
    let visibility = draft["youtubeVisibility"].as_str().unwrap_or("unlisted");
    let attachments = draft["media"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let first = attachments.first();
    let fallback_title = if !explicit_title.is_empty() {
        explicit_title
    } else {
        core_body.lines().find(|line| !line.trim().is_empty()).unwrap_or("").trim()
    };
    let targets = draft["targets"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let mut cards = row().gap(18.0).flex_wrap().items_start();
    for target in targets {
        let target_body = target["text"].as_str().unwrap_or(core_body).trim();
        let target_title = if !explicit_title.is_empty() {
            explicit_title
        } else {
            target_body.lines().find(|line| !line.trim().is_empty()).unwrap_or(fallback_title).trim()
        };
        let thumb = Some(&draft["cover"])
            .filter(|_| target["platform"] != "tiktok")
            .and_then(|cover| cover["storageId"].as_str())
            .or_else(|| first.and_then(|first| first["storageId"].as_str()))
            .and_then(|sid| s.thumbs.map.get(sid));
        let post = Post {
            handle: target["handle"].as_str().unwrap_or(""),
            text: target_body,
            title: if target_title.is_empty() { "No title" } else { target_title },
            visibility,
            pixels: thumb.map(|t| &t.pixels),
            size: thumb.and_then(|t| t.size),
            video: first.is_some_and(|first| first["kind"] == "video"),
            count: attachments.len(),
        };
        cards = cards.child(card(target, &post, visibility));
    }
    if targets.is_empty() {
        let shown = if core_body.is_empty() { "Empty draft" } else { core_body };
        cards = cards.child(
            col()
                .w(CARD)
                .gap(10.0)
                .child(text("NO ACCOUNT CHOSEN").font(theme::label(10.0)).color(theme::coral()))
                .child(text(shown.to_string()).font(theme::mono(11.0)).color(theme::FG).max_lines(8)),
        );
    }
    let open_draft = draft.clone();
    let mut meta = row()
        .gap(12.0)
        .center_y()
        .child(text(format!("Edited {}", fmt::relative_time(draft["updatedAt"].as_f64().unwrap_or(0.0), s.now)).to_uppercase()).font(theme::label(9.0)).color(theme::FAINT));
    if let Some(sched) = draft["scheduledFor"].as_f64() {
        meta = meta.child(text(format!("SCHEDULED · {}", fmt::format_datetime(sched)).to_uppercase()).font(theme::label(9.0)).color(theme::coral()));
    }
    meta = meta.child(col().grow(1.0)).child(text("OPEN IN STUDIO →").font(theme::label(9.0)).color(theme::DIM));
    col()
        .key(format!("draft-{id}"))
        .label(if fallback_title.is_empty() { "Draft" } else { fallback_title })
        .padding(14.0)
        .gap(12.0)
        .border(1.0, theme::line())
        .cursor(rune::Cursor::Pointer)
        .hover(theme::FG.alpha(0.05))
        .on_press(move |s: &mut App| {
            crate::studio::open_saved_draft(s, &open_draft);
            s.tab = Tab::Studio;
        })
        .child(cards)
        .child(meta)
}

fn section(title: &str, count: usize, groups: El) -> El {
    col().gap(14.0).child(text(format!("{title} · {count}").to_uppercase()).font(theme::label(11.0)).color(theme::DIM)).child(groups)
}

/// Every saved draft: scheduled & to-send first, then what has been sent everywhere.
pub fn gallery(s: &App, drafts: &[Json]) -> El {
    let (done, waiting): (Vec<&Json>, Vec<&Json>) = drafts.iter().partition(|draft| draft["status"] == "published");
    let mut page = col().px(24.0).gap(32.0);
    for (title, list) in [("To send", waiting), ("Sent everywhere", done)] {
        if list.is_empty() {
            continue;
        }
        let mut groups = row().gap(16.0).flex_wrap().items_start();
        for draft in &list {
            groups = groups.child(group(s, draft));
        }
        page = page.child(section(title, list.len(), groups));
    }
    page
}
