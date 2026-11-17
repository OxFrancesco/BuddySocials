//! A draft's images and videos: adding them (file picker, drop, paste), showing
//! them, and editing them before they are posted. Images are cropped, turned and
//! flipped here; videos are trimmed with ffmpeg. Every result is a new file that
//! replaces the old one on the draft; the server deletes what is left unused.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use image::{DynamicImage, ImageDecoder, RgbaImage};
use rune::{Cursor, Drag, El, FileDialogOptions, Phase, Pixels, Player, SurfaceFit, Tx, col, el, row, text};
use serde_json::{Value as Json, json};

use crate::backend::Cmd;
use crate::{App, DraftEdit, theme, ui};

pub const MAX_ITEMS: usize = 4;
const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES: u64 = 200 * 1024 * 1024;
/// X takes images up to 5 MB, the strictest of the platforms, so larger ones are re-encoded on the way in.
const IMAGE_TARGET_BYTES: u64 = 5 * 1024 * 1024;
const IMAGE_MAX_SIDE: u32 = 4096;
/// Long side of the copy kept in memory for thumbnails and the crop preview.
const PREVIEW_SIDE: u32 = 1280;
const THUMB: f32 = 104.0;
const STAGE_W: f32 = 560.0;
const STAGE_H: f32 = 340.0;
const HANDLE: f32 = 14.0;
/// The smallest crop, as a share of the image, so a handle can always be grabbed again.
const MIN_CROP: f32 = 0.06;
const MIN_CLIP_SECONDS: f64 = 0.5;

pub const EXTENSIONS: [&str; 10] = ["png", "jpg", "jpeg", "webp", "gif", "heic", "heif", "mp4", "mov", "m4v"];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Image,
    Video,
}

pub struct Item {
    pub key: u64,
    pub kind: Kind,
    pub name: String,
    pub mime: String,
    /// The file on this Mac, when there is one. A saved draft's video plays from `url` instead.
    pub path: Option<PathBuf>,
    pub url: Option<String>,
    /// The server's record of the upload. None until the upload finishes.
    pub saved: Option<Json>,
    pub thumb: Pixels,
    pub base: Option<Arc<RgbaImage>>,
    pub player: Option<Player>,
    /// What is happening to it, in a word.
    pub busy: Option<&'static str>,
    pub error: Option<String>,
}

impl Item {
    fn source(&self) -> Option<String> {
        self.path.as_ref().map(|path| path.to_string_lossy().into_owned()).or_else(|| self.url.clone())
    }
}

/// The attachment open for editing.
pub struct Edit {
    pub key: u64,
    pub kind: Kind,
    pub preview: Pixels,
    base: Option<Arc<RgbaImage>>,
    /// Size of the turned preview, in pixels.
    size: (u32, u32),
    /// Quarter turns clockwise.
    turns: u8,
    flip: bool,
    /// Left, top, right, bottom, each 0 to 1 of the turned image.
    crop: [f32; 4],
    grab: [f32; 4],
    /// Width over height the crop is held to, or None for any shape.
    aspect: Option<f32>,
    pub player: Option<Player>,
    start: f64,
    end: f64,
    /// Which end of the clip the pointer holds: 0 the start, 1 the end.
    knob: u8,
}

pub enum Done {
    /// An image is ready: decoded, and re-encoded when it had to be.
    Ready { key: u64, path: PathBuf, mime: &'static str, base: RgbaImage, upload: bool },
    /// A trimmed video was written.
    Clip { key: u64, path: PathBuf },
    Failed { key: u64, message: String },
}

/// Results from the worker threads, drained by `absorb`.
#[derive(Clone, Default)]
pub struct Jobs {
    done: Arc<Mutex<Vec<Done>>>,
    wake: Arc<Mutex<Option<rune::Waker>>>,
}

impl Jobs {
    pub fn set_waker(&self, wake: rune::Waker) {
        *self.wake.lock().unwrap() = Some(wake);
    }

    fn push(&self, done: Done) {
        self.done.lock().unwrap().push(done);
        if let Some(wake) = self.wake.lock().unwrap().as_ref() {
            wake();
        }
    }

    fn drain(&self) -> Vec<Done> {
        std::mem::take(&mut *self.done.lock().unwrap())
    }
}

fn work_dir() -> PathBuf {
    let dir = crate::config::cache_dir().unwrap_or_else(|| std::env::temp_dir().join("BuddySocials")).join("media");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn extension(path: &Path) -> String {
    path.extension().and_then(|ext| ext.to_str()).unwrap_or("").to_ascii_lowercase()
}

/// What a file is, by its name. None for anything a post can't carry.
pub fn classify(path: &Path) -> Option<(Kind, &'static str)> {
    Some(match extension(path).as_str() {
        "png" => (Kind::Image, "image/png"),
        "jpg" | "jpeg" => (Kind::Image, "image/jpeg"),
        "webp" => (Kind::Image, "image/webp"),
        "gif" => (Kind::Image, "image/gif"),
        "heic" | "heif" => (Kind::Image, "image/heic"),
        "mp4" | "m4v" => (Kind::Video, "video/mp4"),
        "mov" => (Kind::Video, "video/quicktime"),
        _ => return None,
    })
}

fn decode(path: &Path) -> Result<DynamicImage, String> {
    let unreadable = |_| "That image could not be read.".to_string();
    let mut decoder = image::ImageReader::open(path).map_err(unreadable)?.with_guessed_format().map_err(unreadable)?.into_decoder().map_err(|_| "That image could not be read.".to_string())?;
    // A phone photo is stored on its side with a note saying which way is up.
    let orientation = decoder.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut image = DynamicImage::from_decoder(decoder).map_err(|_| "That image could not be read.".to_string())?;
    image.apply_orientation(orientation);
    Ok(image)
}

fn write_jpeg(image: &DynamicImage, path: &Path) -> Result<(), String> {
    let file = std::fs::File::create(path).map_err(|_| "The edited image could not be written.".to_string())?;
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(std::io::BufWriter::new(file), 90);
    image.to_rgb8().write_with_encoder(encoder).map_err(|_| "The edited image could not be written.".to_string())
}

fn preview_of(image: &DynamicImage) -> RgbaImage {
    if image.width().max(image.height()) <= PREVIEW_SIDE { image.to_rgba8() } else { image.thumbnail(PREVIEW_SIDE, PREVIEW_SIDE).to_rgba8() }
}

/// Reads an image and, when a platform would refuse it as it is, writes a copy they all take.
fn ingest(key: u64, path: &Path, mime: &'static str, upload: bool) -> Result<Done, String> {
    let mut source = path.to_path_buf();
    if mime == "image/heic" {
        // macOS reads its own photo format; the image library here does not.
        source = work_dir().join(format!("{key}-heic.jpg"));
        let converted = Command::new("/usr/bin/sips").args(["-s", "format", "jpeg"]).arg(path).arg("--out").arg(&source).output();
        if !converted.is_ok_and(|output| output.status.success()) {
            return Err("That photo could not be converted. Export it as a JPEG and add it again.".into());
        }
    }
    let image = decode(&source)?;
    let bytes = std::fs::metadata(&source).map(|meta| meta.len()).unwrap_or(0);
    let mime = if mime == "image/heic" { "image/jpeg" } else { mime };
    let oversized = image.width().max(image.height()) > IMAGE_MAX_SIDE;
    let accepted = (mime == "image/jpeg" || mime == "image/png") && bytes <= IMAGE_TARGET_BYTES && !oversized;
    // A GIF stays a GIF so it keeps moving; LinkedIn takes it and X says so if it is chosen.
    if upload && !accepted && mime != "image/gif" {
        let fitted = if oversized { image.thumbnail(IMAGE_MAX_SIDE, IMAGE_MAX_SIDE) } else { image };
        source = work_dir().join(format!("{key}-fit.jpg"));
        write_jpeg(&fitted, &source)?;
        return Ok(Done::Ready { key, path: source, mime: "image/jpeg", base: preview_of(&fitted), upload });
    }
    Ok(Done::Ready { key, path: source, mime, base: preview_of(&image), upload })
}

fn spawn(jobs: &Jobs, key: u64, work: impl FnOnce() -> Result<Done, String> + Send + 'static) {
    let jobs = jobs.clone();
    let _ = rune::task::spawn("media", move || {
        let done = work().unwrap_or_else(|message| Done::Failed { key, message });
        jobs.push(done);
    });
}

fn blank(key: u64, kind: Kind, name: String, mime: &str) -> Item {
    Item { key, kind, name, mime: mime.to_string(), path: None, url: None, saved: None, thumb: Pixels::new(), base: None, player: None, busy: None, error: None }
}

fn show(pixels: &Pixels, image: &RgbaImage) {
    pixels.set(image.width(), image.height(), image.as_raw().clone());
}

/// Adds files to the open draft, opening a new one when none is open.
pub fn add(s: &mut App, paths: &[PathBuf]) {
    if s.draft.is_none() {
        s.draft = Some(DraftEdit::new(None, "", Vec::new()));
    }
    for path in paths {
        let Some((kind, mime)) = classify(path) else {
            s.notice = Some("Only images and videos can be attached.".into());
            continue;
        };
        let bytes = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
        let draft = s.draft.as_mut().expect("opened above");
        if draft.media.len() >= MAX_ITEMS {
            s.notice = Some(format!("A draft holds up to {MAX_ITEMS} attachments."));
            break;
        }
        if kind == Kind::Video && bytes > MAX_VIDEO_BYTES {
            s.notice = Some("Videos can be up to 200 MB. Trim it or export it smaller.".into());
            continue;
        }
        s.next_key += 1;
        let key = s.next_key;
        let name = path.file_name().and_then(|name| name.to_str()).unwrap_or("attachment").to_string();
        let mut item = blank(key, kind, name.clone(), mime);
        draft.confirming = false;
        match kind {
            Kind::Image => {
                item.busy = Some("Reading");
                let path = path.clone();
                spawn(&s.jobs, key, move || ingest(key, &path, mime, true));
            }
            Kind::Video => {
                item.busy = Some("Uploading");
                item.path = Some(path.clone());
                let player = Player::file(path.clone());
                player.preload();
                item.player = Some(player);
                s.send(Cmd::Upload { key, path: path.clone(), mime: mime.to_string(), name });
            }
        }
        s.draft.as_mut().expect("opened above").media.push(item);
    }
}

/// A paste into the draft's text: an image or files on the clipboard become attachments. False lets text paste as usual.
pub fn paste(s: &mut App, content: &rune::ClipboardContent) -> bool {
    let files: Vec<PathBuf> = content.files().iter().filter(|path| classify(path).is_some()).cloned().collect();
    if !files.is_empty() {
        add(s, &files);
        return true;
    }
    let Some(image) = content.image() else { return false };
    s.next_key += 1;
    let path = work_dir().join(format!("pasted-{}-{}.png", std::process::id(), s.next_key));
    if std::fs::write(&path, image.png()).is_err() {
        s.notice = Some("The pasted image could not be read.".into());
        return true;
    }
    add(s, &[path]);
    true
}

/// The attachments of a saved draft. Images are fetched so they can be shown and edited.
pub fn open_saved(s: &mut App, media: &Json) -> Vec<Item> {
    let mut items = Vec::new();
    for entry in media.as_array().into_iter().flatten() {
        s.next_key += 1;
        let key = s.next_key;
        let kind = if entry["kind"] == "video" { Kind::Video } else { Kind::Image };
        let mime = entry["mimeType"].as_str().unwrap_or("");
        let name = entry["filename"].as_str().unwrap_or(if kind == Kind::Video { "Video" } else { "Image" }).to_string();
        let mut item = blank(key, kind, name, mime);
        item.saved = Some(record(entry));
        item.url = entry["url"].as_str().map(str::to_string);
        if let Some(url) = item.url.clone() {
            match kind {
                Kind::Image => {
                    item.busy = Some("Loading");
                    let ext = mime.rsplit('/').next().unwrap_or("img");
                    s.send(Cmd::Download { key, url, to: work_dir().join(format!("{}.{ext}", entry["storageId"].as_str().unwrap_or("file"))) });
                }
                Kind::Video => {
                    let player = Player::url(url);
                    player.preload();
                    item.player = Some(player);
                }
            }
        }
        items.push(item);
    }
    items
}

/// The fields a draft stores about an attachment, from what the server returned.
fn record(entry: &Json) -> Json {
    let mut record = json!({ "storageId": entry["storageId"], "kind": entry["kind"], "mimeType": entry["mimeType"], "byteSize": entry["byteSize"] });
    if let Some(name) = entry["filename"].as_str() {
        record["filename"] = json!(name);
    }
    record
}

fn item_mut(s: &mut App, key: u64) -> Option<&mut Item> {
    s.draft.as_mut()?.media.iter_mut().find(|item| item.key == key)
}

/// Folds finished work into the draft. Returns whether anything changed.
pub fn absorb(s: &mut App) -> bool {
    let done = s.jobs.drain();
    let changed = !done.is_empty();
    for done in done {
        match done {
            Done::Ready { key, path, mime, base, upload } => {
                let Some(item) = item_mut(s, key) else { continue };
                show(&item.thumb, &base);
                item.base = Some(Arc::new(base));
                item.path = Some(path.clone());
                item.mime = mime.to_string();
                item.error = None;
                item.busy = None;
                if upload {
                    if std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0) > MAX_IMAGE_BYTES {
                        item.error = Some("Images can be up to 20 MB.".into());
                        continue;
                    }
                    item.saved = None;
                    item.busy = Some("Uploading");
                    let name = item.name.clone();
                    s.send(Cmd::Upload { key, path, mime: mime.to_string(), name });
                }
            }
            Done::Clip { key, path } => {
                let Some(item) = item_mut(s, key) else { continue };
                item.path = Some(path.clone());
                item.url = None;
                item.mime = "video/mp4".into();
                let player = Player::file(path.clone());
                player.preload();
                item.player = Some(player);
                item.saved = None;
                item.error = None;
                item.busy = Some("Uploading");
                let name = item.name.clone();
                s.send(Cmd::Upload { key, path, mime: "video/mp4".into(), name });
            }
            Done::Failed { key, message } => {
                let Some(item) = item_mut(s, key) else { continue };
                item.busy = None;
                item.error = Some(message);
            }
        }
    }
    changed
}

pub fn uploaded(s: &mut App, key: u64, result: Result<Json, String>) {
    let Some(item) = item_mut(s, key) else { return };
    item.busy = None;
    match result {
        Ok(entry) => {
            item.saved = Some(record(&entry));
            item.error = None;
        }
        Err(message) => item.error = Some(message),
    }
}

pub fn downloaded(s: &mut App, key: u64, result: Result<PathBuf, String>) {
    let jobs = s.jobs.clone();
    let Some(item) = item_mut(s, key) else { return };
    match result {
        Ok(path) => {
            let mime: &'static str = match item.mime.as_str() {
                "image/png" => "image/png",
                "image/gif" => "image/gif",
                "image/webp" => "image/webp",
                _ => "image/jpeg",
            };
            spawn(&jobs, key, move || ingest(key, &path, mime, false));
        }
        Err(message) => {
            item.busy = None;
            item.error = Some(message);
        }
    }
}

/// The draft's attachments as the server stores them, or None while one is still on its way up.
pub fn records(draft: &DraftEdit) -> Option<Vec<Json>> {
    draft.media.iter().map(|item| item.saved.clone()).collect()
}

/// True while an attachment is uploading, loading or being edited.
pub fn working(draft: &DraftEdit) -> bool {
    draft.media.iter().any(|item| item.busy.is_some() || item.saved.is_none())
}

// ---------------------------------------------------------------- editing

fn turned(base: &RgbaImage, turns: u8, flip: bool) -> RgbaImage {
    let image = match turns % 4 {
        1 => image::imageops::rotate90(base),
        2 => image::imageops::rotate180(base),
        3 => image::imageops::rotate270(base),
        _ => base.clone(),
    };
    if flip { image::imageops::flip_horizontal(&image) } else { image }
}

/// The largest centred crop of the given shape. `ratio` is width over height in image pixels.
fn centred(size: (u32, u32), ratio: Option<f32>) -> [f32; 4] {
    let Some(ratio) = ratio else { return [0.0, 0.0, 1.0, 1.0] };
    // The crop is kept as shares of each side, so the shape is converted to that space.
    let shares = ratio * size.1 as f32 / size.0 as f32;
    let (w, h) = if shares >= 1.0 { (1.0, 1.0 / shares) } else { (shares, 1.0) };
    [(1.0 - w) / 2.0, (1.0 - h) / 2.0, (1.0 + w) / 2.0, (1.0 + h) / 2.0]
}

impl Edit {
    fn redraw(&mut self) {
        let Some(base) = &self.base else { return };
        let image = turned(base, self.turns, self.flip);
        self.size = (image.width(), image.height());
        show(&self.preview, &image);
    }

    fn turn(&mut self, by: u8) {
        self.turns = (self.turns + by) % 4;
        self.redraw();
        self.crop = centred(self.size, self.aspect);
    }

    fn untouched(&self) -> bool {
        match self.kind {
            Kind::Image => self.turns == 0 && !self.flip && self.crop == [0.0, 0.0, 1.0, 1.0],
            Kind::Video => self.start <= 0.01 && self.duration().is_some_and(|duration| self.end >= duration - 0.01),
        }
    }

    fn duration(&self) -> Option<f64> {
        self.player.as_ref().and_then(Player::duration).filter(|duration| *duration > 0.0)
    }
}

pub fn open(s: &mut App, key: u64) {
    let Some(draft) = &mut s.draft else { return };
    let Some(item) = draft.media.iter().find(|item| item.key == key) else { return };
    if item.busy.is_some() {
        return;
    }
    let mut edit = Edit {
        key,
        kind: item.kind,
        preview: Pixels::new(),
        base: item.base.clone(),
        size: (1, 1),
        turns: 0,
        flip: false,
        crop: [0.0, 0.0, 1.0, 1.0],
        grab: [0.0; 4],
        aspect: None,
        player: None,
        start: 0.0,
        end: f64::MAX,
        knob: 0,
    };
    match item.kind {
        Kind::Image => {
            if edit.base.is_none() {
                return;
            }
            edit.redraw();
        }
        Kind::Video => {
            // Its own player, so scrubbing here never moves the thumbnail.
            let player = match (&item.path, &item.url) {
                (Some(path), _) => Player::file(path.clone()),
                (None, Some(url)) => Player::url(url.clone()),
                (None, None) => return,
            };
            player.preload();
            if let Some(wake) = s.jobs.wake.lock().unwrap().clone() {
                player.set_waker(wake);
            }
            edit.player = Some(player);
        }
    }
    draft.editing = Some(edit);
}

fn editing(s: &mut App) -> Option<&mut Edit> {
    s.draft.as_mut()?.editing.as_mut()
}

fn ffmpeg() -> Option<PathBuf> {
    let listed = std::env::var_os("PATH").map(|path| std::env::split_paths(&path).collect::<Vec<_>>()).unwrap_or_default();
    listed.into_iter().chain(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from)).map(|dir| dir.join("ffmpeg")).find(|path| path.is_file())
}

/// Writes the edit to a new file and swaps it in. The upload starts when the file is ready.
fn apply(s: &mut App) {
    let Some(draft) = &mut s.draft else { return };
    let Some(edit) = draft.editing.take() else { return };
    if edit.untouched() {
        return;
    }
    if let Some(player) = &edit.player {
        player.pause();
    }
    let Some(item) = draft.media.iter_mut().find(|item| item.key == edit.key) else { return };
    let Some(source) = item.source() else { return };
    s.next_key += 1;
    let (key, stamp) = (edit.key, s.next_key);
    draft.confirming = false;
    match edit.kind {
        Kind::Image => {
            item.busy = Some("Saving edit");
            let (turns, flip, crop) = (edit.turns, edit.flip, edit.crop);
            let png = item.mime == "image/png";
            spawn(&s.jobs, key, move || {
                let image = decode(Path::new(&source))?;
                let image = DynamicImage::ImageRgba8(turned(&image.to_rgba8(), turns, flip));
                let (w, h) = (image.width() as f32, image.height() as f32);
                let x = (crop[0] * w).round().clamp(0.0, w - 1.0);
                let y = (crop[1] * h).round().clamp(0.0, h - 1.0);
                let cw = ((crop[2] - crop[0]) * w).round().clamp(1.0, w - x);
                let ch = ((crop[3] - crop[1]) * h).round().clamp(1.0, h - y);
                let mut cut = image.crop_imm(x as u32, y as u32, cw as u32, ch as u32);
                if cut.width().max(cut.height()) > IMAGE_MAX_SIDE {
                    cut = cut.thumbnail(IMAGE_MAX_SIDE, IMAGE_MAX_SIDE);
                }
                let path = work_dir().join(format!("{key}-{stamp}.{}", if png { "png" } else { "jpg" }));
                if png {
                    cut.save(&path).map_err(|_| "The edited image could not be written.".to_string())?;
                } else {
                    write_jpeg(&cut, &path)?;
                }
                Ok(Done::Ready { key, path, mime: if png { "image/png" } else { "image/jpeg" }, base: preview_of(&cut), upload: true })
            });
        }
        Kind::Video => {
            let Some(tool) = ffmpeg() else {
                item.error = Some("Trimming needs ffmpeg. Install it with `brew install ffmpeg`, then try again.".into());
                return;
            };
            item.busy = Some("Trimming");
            let (start, length) = (edit.start, edit.end - edit.start);
            spawn(&s.jobs, key, move || {
                let path = work_dir().join(format!("{key}-{stamp}.mp4"));
                // Re-encoded, so the cut lands on the chosen frame and the result is an MP4 every platform takes.
                let output = Command::new(tool)
                    .args(["-y", "-v", "error", "-ss", &format!("{start:.3}"), "-i", &source, "-t", &format!("{length:.3}")])
                    .args(["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart"])
                    .arg(&path)
                    .output();
                match output {
                    Ok(output) if output.status.success() => {
                        if std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0) > MAX_VIDEO_BYTES {
                            return Err("The trimmed video is still over 200 MB. Make it shorter.".into());
                        }
                        Ok(Done::Clip { key, path })
                    }
                    _ => Err("The video could not be trimmed.".into()),
                }
            });
        }
    }
}

/// While a clip plays in the editor: stop it at the chosen end and keep the playhead moving.
pub fn tick(s: &mut App, tx: &mut Tx) -> bool {
    let Some(edit) = editing(s) else { return false };
    let Some(player) = edit.player.clone() else { return false };
    if let Some(duration) = edit.duration() {
        if edit.end > duration {
            edit.end = duration;
        }
    }
    if !player.is_playing() {
        return false;
    }
    if player.time() >= edit.end || player.state() == rune::PlayerState::Ended {
        player.pause();
        player.seek(edit.start);
    }
    tx.wake_after(std::time::Duration::from_millis(33));
    true
}

// ---------------------------------------------------------------- views

fn clock(seconds: f64) -> String {
    let seconds = seconds.max(0.0);
    format!("{}:{:04.1}", (seconds / 60.0).floor() as u32, seconds % 60.0)
}

fn pick(s: &mut App, tx: &mut Tx) {
    let _ = s;
    let options = FileDialogOptions { title: "Add an image or video".into(), ..Default::default() }.filter("Images and videos", &EXTENSIONS);
    tx.open_file(options, |s: &mut App, result, _| match result {
        Ok(Some(path)) => add(s, &[path]),
        Ok(None) => {}
        Err(_) => s.notice = Some("The file picker could not open. Drop the file on the draft instead.".into()),
    });
}

/// The row of attachments under the text, with the button that adds one.
pub fn strip(draft: &DraftEdit) -> El {
    let mut tiles = row().key("draft-media").gap(12.0).flex_wrap();
    for (index, item) in draft.media.iter().enumerate() {
        let key = item.key;
        let mut picture = el().key(format!("media-{index}-picture")).size(THUMB, THUMB).fill(theme::FG.alpha(0.08));
        picture = match (&item.player, &item.base) {
            (Some(player), _) => picture.video(player, SurfaceFit::Fill),
            (None, Some(_)) => picture.pixels_fit(&item.thumb, SurfaceFit::Fill),
            (None, None) => picture,
        };
        let note = match (&item.error, item.busy) {
            (Some(_), _) => Some(("Failed".to_string(), true)),
            (None, Some(busy)) => Some((busy.to_string(), false)),
            (None, None) if item.kind == Kind::Video => Some(("Video".to_string(), false)),
            _ => None,
        };
        let mut frame = el().size(THUMB, THUMB).child(picture.absolute(0.0, 0.0));
        if let Some((note, alert)) = note {
            frame = frame.child(
                row().absolute(0.0, THUMB - 20.0).size(THUMB, 20.0).center().fill(theme::BG.alpha(0.78)).child(text(note.to_uppercase()).font(theme::label(9.0)).color(if alert { theme::coral() } else { theme::FG })),
            );
        }
        let mut controls = row().gap(4.0);
        if item.busy.is_none() && (item.base.is_some() || item.kind == Kind::Video) {
            controls = controls.child(small(format!("media-edit-{index}"), if item.kind == Kind::Video { "Trim" } else { "Edit" }).on_press(move |s: &mut App| open(s, key)));
        }
        controls = controls.child(small(format!("media-remove-{index}"), "Remove").on_press(move |s: &mut App| {
            let Some(draft) = &mut s.draft else { return };
            draft.media.retain(|item| item.key != key);
            if draft.editing.as_ref().is_some_and(|edit| edit.key == key) {
                draft.editing = None;
            }
            draft.confirming = false;
        }));
        tiles = tiles.child(col().key(format!("media-{index}")).label(&item.name).gap(6.0).w(THUMB).child(frame.border(2.0, if item.error.is_some() { theme::coral() } else { theme::line() })).child(controls));
    }
    let mut block = col().gap(10.0).child(tiles);
    for item in &draft.media {
        if let Some(error) = &item.error {
            block = block.child(text(format!("{}: {error}", item.name)).font(theme::mono(13.0)).color(theme::coral()).wrap());
        }
    }
    let mut adder = row().gap(12.0).center_y();
    if draft.media.len() < MAX_ITEMS {
        adder = adder
            .child(ui::button("media-add", "Add image or video", ui::Kind::Outline).on_press_tx(pick))
            .child(text(if draft.drop_over { "Drop to attach" } else { "or drop files here, or paste an image" }).font(theme::mono(12.0)).color(if draft.drop_over { theme::coral() } else { theme::FAINT }));
    }
    block.child(adder)
}

fn small(key: String, label: &str) -> El {
    row()
        .key(key)
        .role("button")
        .label(label)
        .focusable(true)
        .h(22.0)
        .px(6.0)
        .center()
        .border(1.0, theme::line())
        .hover(theme::FG.alpha(0.12))
        .cursor(Cursor::Pointer)
        .child(text(label.to_uppercase()).font(theme::label(9.0)).color(theme::FG))
}

/// Moves one corner of the crop, keeping the opposite corner where it is.
fn drag_corner(edit: &mut Edit, corner: usize, dx: f32, dy: f32) {
    let grab = edit.grab;
    let (left, top) = (corner % 2 == 0, corner < 2);
    let (fixed_x, fixed_y) = (if left { grab[2] } else { grab[0] }, if top { grab[3] } else { grab[1] });
    let moving_x = (if left { grab[0] } else { grab[2] } + dx).clamp(0.0, 1.0);
    let moving_y = (if top { grab[1] } else { grab[3] } + dy).clamp(0.0, 1.0);
    let mut w = (moving_x - fixed_x).abs().max(MIN_CROP);
    let mut h = (moving_y - fixed_y).abs().max(MIN_CROP);
    if let Some(ratio) = edit.aspect {
        let shares = ratio * edit.size.1 as f32 / edit.size.0 as f32;
        // Room left on the fixed corner's side, so a held shape never leaves the image.
        let room_w = if left { fixed_x } else { 1.0 - fixed_x };
        let room_h = if top { fixed_y } else { 1.0 - fixed_y };
        w = w.min(h * shares).min(room_w).min(room_h * shares);
        h = w / shares;
    }
    let x = if left { fixed_x - w } else { fixed_x };
    let y = if top { fixed_y - h } else { fixed_y };
    edit.crop = [x, y, x + w, y + h];
}

fn image_stage(edit: &Edit) -> El {
    let (pw, ph) = (edit.size.0 as f32, edit.size.1 as f32);
    let scale = (STAGE_W / pw).min(STAGE_H / ph);
    let (w, h) = ((pw * scale).round(), (ph * scale).round());
    let [x0, y0, x1, y1] = edit.crop;
    let shade = theme::BG.alpha(0.62);
    let mut stage = el()
        .key("crop-stage")
        .size(w, h)
        .child(el().key("crop-image").absolute(0.0, 0.0).size(w, h).pixels(&edit.preview))
        .child(el().absolute(0.0, 0.0).size(w, y0 * h).fill(shade))
        .child(el().absolute(0.0, y1 * h).size(w, (1.0 - y1) * h).fill(shade))
        .child(el().absolute(0.0, y0 * h).size(x0 * w, (y1 - y0) * h).fill(shade))
        .child(el().absolute(x1 * w, y0 * h).size((1.0 - x1) * w, (y1 - y0) * h).fill(shade))
        .child(
            el().key("crop-frame")
                .label("Crop area")
                .absolute(x0 * w, y0 * h)
                .size((x1 - x0) * w, (y1 - y0) * h)
                .border(2.0, theme::coral())
                .cursor(Cursor::Pointer)
                .on_drag(move |s: &mut App, d: &mut Drag, tx: &mut Tx| {
                    let Some(edit) = editing(s) else { return };
                    match d.phase {
                        Phase::Down => edit.grab = edit.crop,
                        Phase::Move => {
                            let g = edit.grab;
                            let (cw, ch) = (g[2] - g[0], g[3] - g[1]);
                            let x = (g[0] + d.dx / w).clamp(0.0, 1.0 - cw);
                            let y = (g[1] + d.dy / h).clamp(0.0, 1.0 - ch);
                            edit.crop = [x, y, x + cw, y + ch];
                            tx.instant();
                        }
                        Phase::Up => {
                            if d.cancelled() {
                                edit.crop = edit.grab;
                            }
                        }
                    }
                }),
        );
    for corner in 0..4 {
        let (cx, cy) = (if corner % 2 == 0 { x0 } else { x1 }, if corner < 2 { y0 } else { y1 });
        stage = stage.child(
            el().key(format!("crop-handle-{corner}"))
                .label("Crop corner")
                .absolute((cx * w - HANDLE / 2.0).clamp(0.0, w - HANDLE), (cy * h - HANDLE / 2.0).clamp(0.0, h - HANDLE))
                .size(HANDLE, HANDLE)
                .fill(theme::FG)
                .border(2.0, theme::coral())
                .cursor(Cursor::Pointer)
                .on_drag(move |s: &mut App, d: &mut Drag, tx: &mut Tx| {
                    let Some(edit) = editing(s) else { return };
                    match d.phase {
                        Phase::Down => edit.grab = edit.crop,
                        Phase::Move => {
                            drag_corner(edit, corner, d.dx / w, d.dy / h);
                            tx.instant();
                        }
                        Phase::Up => {
                            if d.cancelled() {
                                edit.crop = edit.grab;
                            }
                        }
                    }
                }),
        );
    }
    stage
}

const SHAPES: [(&str, Option<f32>); 5] = [("Free", None), ("1:1", Some(1.0)), ("4:5", Some(0.8)), ("16:9", Some(16.0 / 9.0)), ("9:16", Some(9.0 / 16.0))];

fn image_tools(edit: &Edit) -> El {
    let mut shapes = row().gap(8.0).flex_wrap();
    for (label, ratio) in SHAPES {
        shapes = shapes.child(ui::chip(format!("crop-shape-{label}"), label, edit.aspect == ratio).on_press(move |s: &mut App| {
            let Some(edit) = editing(s) else { return };
            edit.aspect = ratio;
            edit.crop = centred(edit.size, ratio);
        }));
    }
    let turn = |key: &str, label: &str, by: u8| {
        ui::button(key, label, ui::Kind::Outline).on_press(move |s: &mut App| {
            if let Some(edit) = editing(s) {
                edit.turn(by);
            }
        })
    };
    let pixels = edit.base.as_ref().map(|_| {
        let [x0, y0, x1, y1] = edit.crop;
        format!("{:.0}% × {:.0}% of the image", (x1 - x0) * 100.0, (y1 - y0) * 100.0)
    });
    col()
        .gap(12.0)
        .child(shapes)
        .child(
            row()
                .gap(8.0)
                .center_y()
                .child(turn("turn-left", "Turn left", 3))
                .child(turn("turn-right", "Turn right", 1))
                .child(ui::button("flip", "Flip", ui::Kind::Outline).on_press(|s: &mut App| {
                    if let Some(edit) = editing(s) {
                        edit.flip = !edit.flip;
                        // The kept area mirrors with the picture, so the same part of it stays chosen.
                        let [x0, y0, x1, y1] = edit.crop;
                        edit.crop = [1.0 - x1, y0, 1.0 - x0, y1];
                        edit.redraw();
                    }
                }))
                .child(text(pixels.unwrap_or_default().to_uppercase()).font(theme::label(10.0)).color(theme::DIM)),
        )
}

fn video_stage(edit: &Edit) -> El {
    let Some(player) = &edit.player else { return el() };
    let (vw, vh) = player.natural_size().map(|(w, h)| (w as f32, h as f32)).unwrap_or((16.0, 9.0));
    let scale = (STAGE_W / vw).min(STAGE_H / vh);
    el().key("trim-stage").size((vw * scale).round(), (vh * scale).round()).fill(theme::FG.alpha(0.08)).video(player, SurfaceFit::Fit)
}

fn video_tools(edit: &Edit) -> El {
    let Some(player) = &edit.player else { return el() };
    let Some(duration) = edit.duration() else {
        let failed = matches!(player.state(), rune::PlayerState::Failed(_));
        return text(if failed { "This video can't be played here, so it can't be trimmed." } else { "Loading the video" }).font(theme::mono(13.0)).color(if failed { theme::coral() } else { theme::DIM });
    };
    let (w, h, knob) = (STAGE_W, 28.0, 12.0);
    let end = edit.end.min(duration);
    let at = |seconds: f64| (seconds / duration) as f32 * (w - knob);
    let (a, b) = (at(edit.start), at(end));
    let head = at(player.time().clamp(edit.start, end));
    let track = el()
        .key("trim-track")
        .role("slider")
        .label("Clip start and end")
        .size(w, h)
        .cursor(Cursor::Pointer)
        .on_drag(move |s: &mut App, d: &mut Drag, tx: &mut Tx| {
            let Some(edit) = editing(s) else { return };
            let Some(duration) = edit.duration() else { return };
            let seconds = (((d.x - knob / 2.0) / (w - knob)).clamp(0.0, 1.0) as f64) * duration;
            let end = edit.end.min(duration);
            if d.phase == Phase::Down {
                // Whichever end is nearer is the one being moved.
                edit.knob = if (seconds - edit.start).abs() <= (seconds - end).abs() { 0 } else { 1 };
            }
            if d.phase == Phase::Up && d.cancelled() {
                return;
            }
            if edit.knob == 0 {
                edit.start = seconds.min(end - MIN_CLIP_SECONDS).max(0.0);
            } else {
                edit.end = seconds.max(edit.start + MIN_CLIP_SECONDS).min(duration);
            }
            // The picture follows the handle, so the cut is chosen by looking at it.
            if let Some(player) = &edit.player {
                player.pause();
                player.seek(if edit.knob == 0 { edit.start } else { edit.end });
            }
            tx.instant();
        })
        .child(el().absolute(0.0, (h - 6.0) / 2.0).size(w, 6.0).fill(theme::line()))
        .child(el().key("trim-kept").absolute(a + knob / 2.0, (h - 6.0) / 2.0).size((b - a).max(0.0), 6.0).fill(theme::coral()))
        .child(el().key("trim-head").absolute(head + knob / 2.0 - 1.0, 4.0).size(2.0, h - 8.0).fill(theme::FG))
        .child(el().key("trim-start").absolute(a, 0.0).size(knob, h).fill(theme::FG).border(2.0, theme::coral()))
        .child(el().key("trim-end").absolute(b, 0.0).size(knob, h).fill(theme::FG).border(2.0, theme::coral()));
    let playing = player.is_playing();
    col().gap(12.0).child(track).child(
        row()
            .gap(12.0)
            .center_y()
            .child(ui::button("trim-play", if playing { "Pause" } else { "Play clip" }, ui::Kind::Outline).on_press(|s: &mut App| {
                let Some(edit) = editing(s) else { return };
                let Some(player) = &edit.player else { return };
                if player.is_playing() {
                    player.pause();
                } else {
                    player.seek(edit.start);
                    player.play();
                }
            }))
            .child(text(format!("{} to {} · {} of {}", clock(edit.start), clock(end), clock(end - edit.start), clock(duration)).to_uppercase()).key("trim-times").font(theme::label(10.0)).color(theme::DIM)),
    )
}

/// The panel that edits one attachment. It takes the place of the draft's other controls until done.
pub fn editor(edit: &Edit) -> El {
    let (stage, tools, title, done) = match edit.kind {
        Kind::Image => (image_stage(edit), image_tools(edit), "Edit image", "Use this image"),
        Kind::Video => (video_stage(edit), video_tools(edit), "Trim video", "Use this clip"),
    };
    col()
        .key("media-editor")
        .gap(14.0)
        .child(text(title.to_uppercase()).font(theme::label(11.0)).color(theme::DIM))
        .child(row().child(stage))
        .child(tools)
        .child(
            row()
                .gap(8.0)
                .child(ui::button("media-edit-done", done, ui::Kind::Primary).on_press(apply))
                .child(ui::button("media-edit-cancel", "Cancel", ui::Kind::Ghost).on_press(|s: &mut App| {
                    if let Some(draft) = &mut s.draft {
                        if let Some(player) = draft.editing.take().and_then(|edit| edit.player) {
                            player.pause();
                        }
                    }
                })),
        )
}

/// For the end-to-end check: turns the first attachment a quarter and crops it square, as the buttons would.
pub fn edit_first(s: &mut App) -> bool {
    let Some(key) = s.draft.as_ref().and_then(|draft| draft.media.first()).map(|item| item.key) else { return false };
    open(s, key);
    let Some(edit) = editing(s) else { return false };
    edit.turn(1);
    edit.aspect = Some(1.0);
    edit.crop = centred(edit.size, edit.aspect);
    apply(s);
    true
}

/// For headless snapshots: a drawn picture standing in for a real photo, opened in the editor.
pub fn sample(s: &mut App) {
    let (w, h) = (960u32, 640u32);
    let image = RgbaImage::from_fn(w, h, |x, y| {
        let (fx, fy) = (x as f32 / w as f32, y as f32 / h as f32);
        let sun = ((fx - 0.7).powi(2) + (fy - 0.3).powi(2)).sqrt() < 0.12;
        let hill = fy > 0.62 + 0.08 * (fx * 9.0).sin();
        let [r, g, b] = if sun { [255, 214, 120] } else if hill { [36, 92, 70] } else { [(40.0 + 120.0 * fy) as u8, (70.0 + 110.0 * fy) as u8, (150.0 + 80.0 * fy) as u8] };
        image::Rgba([r, g, b, 255])
    });
    let Some(draft) = &mut s.draft else { return };
    let mut item = blank(1, Kind::Image, "harbour.jpg".into(), "image/jpeg");
    show(&item.thumb, &image);
    item.base = Some(Arc::new(image));
    item.saved = Some(json!({}));
    draft.media.push(item);
    open(s, 1);
    if let Some(edit) = editing(s) {
        edit.aspect = Some(1.0);
        edit.crop = centred(edit.size, edit.aspect);
    }
}
