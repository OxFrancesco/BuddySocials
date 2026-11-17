//! Drafts shown the way each platform will show them: a Short on YouTube, a Reel or a post
//! on Instagram, a video on TikTok, a post on LinkedIn and X. One mock-up per account the
//! draft goes to, with what happened there in plain words underneath.
//!
//! The pictures are small copies of each draft's first attachment, made with ffmpeg (which
//! reads only the part of a video it needs) and kept on disk between runs.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use image::RgbaImage;
use rune::{El, Pixels, SurfaceFit, col, el, row, text};
use serde_json::{Value as Json, json};

use crate::{App, DraftEdit, fmt, media, theme, ui};

/// Width of one mock-up, and the long side of the pictures made for it.
const CARD: f32 = 232.0;
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
        // The first attachment, and the cover that stands in for it where a platform shows one.
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
    // One after another on one thread, so twenty drafts don't start twenty downloads at once.
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
    /// The first line, which is the title where a platform has one.
    title: &'a str,
    thumb: Option<&'a Thumb>,
    video: bool,
    /// How many attachments the draft has.
    count: usize,
}

impl Post<'_> {
    /// Height over width of the attachment. A video is taken as upright until its picture says otherwise.
    fn shape(&self) -> f32 {
        match self.thumb.and_then(|thumb| thumb.size) {
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
    match post.thumb.filter(|thumb| thumb.size.is_some()) {
        Some(thumb) => frame.pixels_fit(&thumb.pixels, SurfaceFit::Fill),
        None => frame.child(
            col().size(CARD, height).center().child(text(if post.count == 0 { "NO PICTURE OR VIDEO" } else if post.video { "VIDEO" } else { "IMAGE" }).font(theme::label(10.0)).color(theme::FAINT)),
        ),
    }
}

/// A small label over a corner of the picture.
fn tag(label: &str, left: f32, top: f32) -> El {
    row().absolute(left, top).px(6.0).py(3.0).fill(theme::BG.alpha(0.72)).child(text(label.to_uppercase()).font(theme::label(9.0)).color(theme::FG))
}

/// An upright video that fills the screen, with the name and caption over its lower edge:
/// a YouTube Short, an Instagram Reel, a TikTok.
fn full_screen(post: &Post, kind: &str, caption: Option<&str>, note: Option<&str>) -> El {
    let height = (CARD * 16.0 / 9.0).round();
    let mut words = col().absolute(0.0, height - 86.0).size(CARD, 86.0).px(10.0).py(8.0).gap(3.0).fill(theme::BG.alpha(0.6));
    words = words.child(text(format!("@{}", post.handle)).font(theme::label(11.0)).color(theme::FG).truncate());
    if let Some(caption) = caption.filter(|caption| !caption.is_empty()) {
        words = words.child(text(caption.to_string()).font(theme::mono(11.0)).color(theme::FG).max_lines(2));
    }
    if let Some(note) = note {
        words = words.child(text(note.to_string()).font(theme::mono(10.0)).color(theme::DIM).max_lines(2));
    }
    el().size(CARD, height).child(picture(post, height).absolute(0.0, 0.0)).child(tag(kind, 8.0, 8.0)).child(words)
}

/// Who posted, as feeds show it: a round picture, the name, and a line under it.
fn byline(post: &Post, under: &str) -> El {
    row().gap(8.0).center_y().child(el().size(28.0, 28.0).radius(14.0).fill(theme::FG.alpha(0.16))).child(
        col()
            .grow(1.0)
            .min_w(0.0)
            .child(text(post.handle.to_string()).font(theme::label(11.0)).color(theme::FG).truncate())
            .child(text(under.to_string()).font(theme::mono(10.0)).color(theme::FAINT).truncate()),
    )
}

/// The attachment at its own shape, kept between a wide strip and a tall card.
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
    match platform {
        "youtube" if post.video && post.upright() => full_screen(post, "Short", Some(post.title), None),
        "youtube" => {
            let height = (CARD * 9.0 / 16.0).round();
            col()
                .gap(8.0)
                .child(el().size(CARD, height).child(picture(post, height).absolute(0.0, 0.0)))
                .child(text(post.title.to_string()).font(theme::mono(13.0)).color(theme::FG).max_lines(2))
                .child(text(format!("{} · Unlisted", post.handle)).font(theme::mono(10.0)).color(theme::FAINT).truncate())
        }
        // The inbox upload carries no caption; it is written in the TikTok app before posting.
        "tiktok" => full_screen(post, "TikTok", None, Some("Caption and privacy are set in the TikTok app.")),
        "instagram" if post.video => full_screen(post, "Reel", Some(post.text), None),
        "instagram" => {
            let mut card = col().gap(8.0).child(byline(post, "Instagram")).child(inline_picture(post, 1.25));
            if !post.text.is_empty() {
                card = card.child(text(format!("{} {}", post.handle, post.text)).font(theme::mono(11.0)).color(theme::FG).max_lines(3));
            }
            card
        }
        _ => {
            let mut card = col().gap(8.0).child(byline(post, if platform == "x" { "now" } else { "Now · Anyone" }));
            if !post.text.is_empty() {
                card = card.child(text(post.text.to_string()).font(theme::mono(11.0)).color(theme::FG).max_lines(if post.count > 0 { 4 } else { 10 }));
            }
            if post.count > 0 {
                card = card.child(inline_picture(post, 1.25));
            }
            card
        }
    }
}

/// What happened on one account, said the way the person would say it.
fn standing(target: &Json) -> (String, bool) {
    let platform = target["platform"].as_str().unwrap_or("");
    match target["state"].as_str() {
        Some("published") => (
            match platform {
                "youtube" => "On YouTube, unlisted",
                "tiktok" => "In your TikTok inbox",
                _ => "Posted",
            }
            .to_string(),
            false,
        ),
        Some("queued") | Some("sending") => ("Sending…".to_string(), false),
        Some("failed") => (target["error"].as_str().unwrap_or("Not sent").to_string(), true),
        _ => match target["issues"].as_array().and_then(|issues| issues.first()).and_then(Json::as_str) {
            Some(issue) => (issue.to_string(), true),
            None => ("Not sent yet".to_string(), false),
        },
    }
}

fn card(target: &Json, post: &Post) -> El {
    let platform = target["platform"].as_str().unwrap_or("");
    let (note, alert) = standing(target);
    let sent = target["state"] == "published";
    let mut foot = row().gap(8.0).center_y().child(text(note).font(theme::mono(11.0)).color(if alert { theme::coral() } else if sent { theme::FG } else { theme::DIM }).max_lines(3).grow(1.0).min_w(0.0));
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

/// One draft: a mock-up per account it goes to. Pressing it opens the draft.
fn group(s: &App, draft: &Json) -> El {
    let id = draft["_id"].as_str().unwrap_or("").to_string();
    let body = draft["text"].as_str().unwrap_or("").trim();
    let attachments = draft["media"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let first = attachments.first();
    let title = body.lines().find(|line| !line.trim().is_empty()).unwrap_or("").trim();
    let targets = draft["targets"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let mut cards = row().gap(20.0).items_start();
    for target in targets {
        let post = Post {
            handle: target["handle"].as_str().unwrap_or(""),
            text: body,
            title: if title.is_empty() { "No title" } else { title },
            // TikTok's cover is chosen in the TikTok app, so its mock-up keeps the video's own frame.
            thumb: Some(&draft["cover"])
                .filter(|_| target["platform"] != "tiktok")
                .and_then(|cover| cover["storageId"].as_str())
                .or_else(|| first.and_then(|first| first["storageId"].as_str()))
                .and_then(|id| s.thumbs.map.get(id)),
            video: first.is_some_and(|first| first["kind"] == "video"),
            count: attachments.len(),
        };
        cards = cards.child(card(target, &post));
    }
    if targets.is_empty() {
        let shown = if body.is_empty() { "Empty draft" } else { body };
        cards = cards.child(
            col().w(CARD).gap(10.0).child(text("NO ACCOUNT CHOSEN").font(theme::label(10.0)).color(theme::coral())).child(text(shown.to_string()).font(theme::mono(11.0)).color(theme::FG).max_lines(8)),
        );
    }
    let accounts: Vec<String> = targets.iter().filter_map(|target| target["accountId"].as_str().map(str::to_string)).collect();
    let (open_id, open_text, open_media) = (id.clone(), draft["text"].as_str().unwrap_or("").to_string(), draft["media"].clone());
    col()
        .key(format!("draft-{id}"))
        .label(if title.is_empty() { "Draft" } else { title })
        .padding(14.0)
        .gap(12.0)
        .border(1.0, theme::line())
        .cursor(rune::Cursor::Pointer)
        .hover(theme::FG.alpha(0.05))
        .on_press(move |s: &mut App| {
            let mut opened = DraftEdit::new(Some(open_id.clone()), &open_text, accounts.clone());
            opened.media = media::open_saved(s, &open_media);
            s.draft = Some(opened);
        })
        .child(cards)
        .child(text(format!("Edited {}", fmt::relative_time(draft["updatedAt"].as_f64().unwrap_or(0.0), s.now)).to_uppercase()).font(theme::label(9.0)).color(theme::FAINT))
}

fn section(title: &str, count: usize, groups: El) -> El {
    col().gap(14.0).child(text(format!("{title} · {count}").to_uppercase()).font(theme::label(11.0)).color(theme::DIM)).child(groups)
}

/// Every saved draft except the one open in the editor: what still has somewhere to go first, then what is done.
pub fn gallery(s: &App, drafts: &[Json]) -> El {
    let open = s.draft.as_ref().and_then(|edit| edit.id.as_deref());
    let shown: Vec<&Json> = drafts.iter().filter(|draft| draft["_id"].as_str() != open).collect();
    let (done, waiting): (Vec<&Json>, Vec<&Json>) = shown.into_iter().partition(|draft| draft["status"] == "published");
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
