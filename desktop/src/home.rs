//! The dashboard: the same widgets, in the same order, as the phone's home screen.
//! The layout is the one saved from the phone; this screen reads it.

use std::hash::{Hash, Hasher};

use rune::{Cx, El, Pixels, col, el, row, text};
use serde_json::{Value as Json, json};

use crate::backend::QuerySpec;
use crate::dither::{self, Series};
use crate::{App, Chart, Tab, days_ms, fmt, theme, ui};

const PAD: f32 = 24.0;
const GAP: f32 = 16.0;
const TILE_PAD: f32 = 16.0;
const TITLE_H: f32 = 16.0;
const COLS: f32 = 4.0;

fn platform_arg(config: &Json) -> Json {
    match config["platform"].as_str() {
        Some(platform) if platform != "all" => json!({ "platform": platform }),
        _ => json!({}),
    }
}

fn merge(mut base: Json, extra: Json) -> Json {
    if let (Some(base), Some(extra)) = (base.as_object_mut(), extra.as_object()) {
        base.extend(extra.clone());
    }
    base
}

fn overview_args(config: &Json, today: &str) -> Json {
    json!({ "today": today, "days": config["range"].as_f64().unwrap_or(28.0) })
}

fn top_posts_args(config: &Json, hour: f64) -> Json {
    let range = config["range"].as_f64().unwrap_or(28.0);
    merge(json!({ "since": hour - days_ms(range), "metric": config["metric"], "limit": 8 }), platform_arg(config))
}

/// The live queries one widget reads.
pub fn queries_for(widget: &Json, today: &str, hour: f64) -> Vec<QuerySpec> {
    let config = &widget["config"];
    match widget["type"].as_str().unwrap_or("") {
        "metric" | "trend" | "split" | "mix" | "platform" => vec![QuerySpec::new("dashboard:overview", overview_args(config, today))],
        "topPosts" => vec![QuerySpec::new("dashboard:topPosts", top_posts_args(config, hour))],
        "latestPost" => vec![QuerySpec::new("dashboard:latestPost", platform_arg(config))],
        "inbox" => vec![QuerySpec::new("comments:openSummary", platform_arg(config))],
        _ => Vec::new(),
    }
}

fn metric_label(metric: &str) -> &'static str {
    match metric {
        "views" => "Views",
        "likes" => "Likes",
        "comments" => "Comments",
        "shares" => "Shares",
        "saves" => "Saves",
        "followers" => "New followers",
        _ => "Interactions",
    }
}

fn metric_value(day: &Json, metric: &str) -> f64 {
    let read = |name: &str| day[name].as_f64().unwrap_or(0.0);
    if metric == "engagement" { read("likes") + read("comments") + read("shares") + read("saves") } else { read(metric) }
}

struct PlatformTotal {
    platform: String,
    total: f64,
    previous: f64,
    days: Vec<f64>,
}

struct Metric {
    series: Vec<f64>,
    total: f64,
    change: Option<f64>,
    by_platform: Vec<PlatformTotal>,
    has_data: bool,
}

/// One metric over the overview's days, for one platform or all of them.
fn metric_of(overview: &Json, metric: &str, filter: &str) -> Metric {
    let length = overview["days"].as_array().map_or(0, Vec::len);
    let by_platform: Vec<PlatformTotal> = overview["platforms"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Json::as_str)
        .filter(|platform| filter == "all" || *platform == filter)
        .map(|platform| {
            let days: Vec<f64> = (0..length).map(|index| metric_value(&overview["series"][platform][index], metric)).collect();
            PlatformTotal {
                platform: platform.to_string(),
                total: days.iter().sum(),
                previous: metric_value(&overview["previous"][platform], metric),
                days,
            }
        })
        .collect();
    let series: Vec<f64> = (0..length).map(|index| by_platform.iter().map(|entry| entry.days[index]).sum()).collect();
    let total: f64 = series.iter().sum();
    let previous: f64 = by_platform.iter().map(|entry| entry.previous).sum();
    Metric {
        series,
        total,
        change: fmt::percent_change(total, previous),
        has_data: !by_platform.is_empty() && (total > 0.0 || previous > 0.0),
        by_platform,
    }
}

fn title_for(kind: &str, config: &Json) -> String {
    let metric = metric_label(config["metric"].as_str().unwrap_or("views"));
    let platform = config["platform"].as_str().unwrap_or("all");
    let range = config["range"].as_f64().unwrap_or(28.0);
    let with_platform = |lead: &str| {
        if platform == "all" { lead.to_string() } else { format!("{lead} · {}", theme::platform_label(platform)) }
    };
    match kind {
        "split" => format!("{metric} · {range}d · by platform"),
        "mix" => format!("{metric} · {range}d"),
        "topPosts" => format!("Top posts · {} · {range}d", with_platform(metric)),
        "latestPost" => with_platform("Latest post"),
        "inbox" => with_platform("Inbox"),
        "goals" => "Goals".to_string(),
        "platform" => format!("{} · {range}d", theme::platform_label(platform)),
        _ => format!("{} · {range}d", with_platform(metric)),
    }
}

fn figure(value: String, size: f32) -> El {
    text(value).font(theme::display(size)).color(theme::FG)
}

fn change(value: Option<f64>) -> El {
    match value.filter(|v| v.is_finite()) {
        Some(value) => text(fmt::signed_percent(value)).font(theme::label(11.0)).color(if value < 0.0 { theme::coral() } else { theme::FG }),
        None => el(),
    }
}

/// What the pointer reads off a chart: a label for each point (dates) and a name for each series.
#[derive(Default)]
struct Readout {
    labels: Vec<String>,
    names: Vec<String>,
}

/// "2026-10-15" as "15 Oct".
fn day_label(day: &str) -> String {
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let mut parts = day.split('-').skip(1).filter_map(|part| part.parse::<usize>().ok());
    match (parts.next(), parts.next()) {
        (Some(month @ 1..=12), Some(date)) => format!("{date} {}", MONTHS[month - 1]),
        _ => day.to_string(),
    }
}

fn days_of(overview: &Json) -> Vec<String> {
    overview["days"].as_array().into_iter().flatten().filter_map(Json::as_str).map(day_label).collect()
}

/// A dithered area chart, redrawn only when its numbers or size change. Under the pointer it
/// marks the nearest point and says its date and values.
fn chart(s: &App, key: &str, width: f32, height: f32, scale: f32, series: &[Series<'_>], readout: &Readout) -> El {
    let (pw, ph) = ((width * scale).round().max(1.0) as usize, (height * scale).round().max(1.0) as usize);
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    (pw, ph).hash(&mut hasher);
    for entry in series {
        entry.rgb.hash(&mut hasher);
        for value in entry.values {
            value.to_bits().hash(&mut hasher);
        }
    }
    let signature = hasher.finish();
    let mut charts = s.charts.borrow_mut();
    let cached = charts.entry(key.to_string()).or_insert_with(|| Chart { signature: 0, pixels: Pixels::new() });
    if cached.signature != signature {
        cached.pixels.set(pw as u32, ph as u32, dither::area(pw, ph, series));
        cached.signature = signature;
    }
    let (over, left) = (key.to_string(), key.to_string());
    let mut stage = el()
        .key(format!("{key}-chart"))
        .size(width, height)
        .on_pointer_move_local(move |s: &mut App, p, _| {
            let at = (p.x / width).clamp(0.0, 1.0);
            // Only a move to another point redraws, not every pixel of travel.
            if s.hover.as_ref().is_none_or(|(key, was)| *key != over || (was - at).abs() > 0.002) {
                s.hover = Some((over.clone(), at));
            }
        })
        .on_hover_change(move |s: &mut App, inside, _| {
            if !inside && s.hover.as_ref().is_some_and(|(key, _)| *key == left) {
                s.hover = None;
            }
        })
        .child(el().absolute(0.0, 0.0).size(width, height).pixels(&cached.pixels));
    let points = series.iter().map(|entry| entry.values.len()).max().unwrap_or(0);
    let Some(at) = s.hover.as_ref().filter(|(hovered, _)| hovered == key && points > 0).map(|(_, at)| *at) else { return stage };
    let index = if points == 1 { 0 } else { (at * (points - 1) as f32).round() as usize };
    let x = if points == 1 { width / 2.0 } else { index as f32 / (points - 1) as f32 * width };
    let mut note = col().padding(6.0).gap(3.0).fill(theme::BG).border(1.0, theme::FG);
    if let Some(label) = readout.labels.get(index) {
        note = note.child(text(label.to_uppercase()).font(theme::label(9.0)).color(theme::DIM));
    }
    for (order, entry) in series.iter().enumerate() {
        let Some(value) = entry.values.get(index) else { continue };
        let [r, g, b] = entry.rgb;
        let mut line = row().gap(5.0).center_y();
        if series.len() > 1 {
            line = line.child(el().size(7.0, 7.0).fill(theme::srgb(((r as u32) << 16) | ((g as u32) << 8) | b as u32)));
        }
        let name = readout.names.get(order).map(|name| format!("{name} ")).unwrap_or_default();
        note = note.child(line.child(text(format!("{name}{}", fmt::grouped(*value))).font(theme::label(10.0)).color(theme::FG)));
    }
    stage = stage.child(el().key(format!("{key}-mark")).absolute((x - 0.5).clamp(0.0, width - 1.0), 0.0).size(1.0, height).fill(theme::FG.alpha(0.7)));
    // The note sits on whichever side of the mark has room.
    let note = note.key(format!("{key}-note"));
    stage.child(if x < width / 2.0 { note.pin(Some(x + 8.0), Some(2.0), None, None) } else { note.pin(None, Some(2.0), Some(width - x + 8.0), None) })
}

struct Tile<'a> {
    s: &'a App,
    id: &'a str,
    config: &'a Json,
    /// Inner size, inside the padding and under the title.
    width: f32,
    height: f32,
    cols: f32,
    rows: f32,
    scale: f32,
}

impl Tile<'_> {
    fn overview(&self) -> Option<&Json> {
        self.s.query("dashboard:overview", overview_args(self.config, &self.s.today())).filter(|value| !value.is_null())
    }

    fn accent(&self) -> [u8; 3] {
        theme::platform_rgb(self.config["platform"].as_str().unwrap_or("all"))
    }

    /// A chart that runs to the tile's left, right and bottom edges.
    fn bleed_chart(&self, height: f32, series: &[Series<'_>], readout: &Readout) -> El {
        // Up to the inside of the 2 pt outline, not over it.
        let bleed = TILE_PAD - 2.0;
        chart(self.s, self.id, self.width + bleed * 2.0, height + bleed, self.scale, series, readout).ml(-bleed).mb(-bleed)
    }
}

fn metric_body(tile: &Tile<'_>) -> El {
    let Some(overview) = tile.overview() else { return el() };
    let data = metric_of(overview, tile.config["metric"].as_str().unwrap_or("views"), tile.config["platform"].as_str().unwrap_or("all"));
    if !data.has_data {
        return ui::empty("No data yet");
    }
    let head = col().gap(4.0).child(figure(fmt::compact(data.total), 34.0)).child(change(data.change));
    let series = [Series { values: &data.series, rgb: tile.accent() }];
    col().grow(1.0).justify_between().child(head).child(tile.bleed_chart(tile.height - 70.0, &series, &Readout { labels: days_of(overview), names: Vec::new() }))
}

fn trend_body(tile: &Tile<'_>) -> El {
    let Some(overview) = tile.overview() else { return el() };
    let data = metric_of(overview, tile.config["metric"].as_str().unwrap_or("views"), tile.config["platform"].as_str().unwrap_or("all"));
    if !data.has_data {
        return ui::empty("No data yet");
    }
    let total = if tile.rows < 2.0 { fmt::compact(data.total) } else { fmt::grouped(data.total) };
    let head = row().gap(10.0).items_end().child(figure(total, if tile.rows < 2.0 { 26.0 } else { 34.0 })).child(change(data.change));
    let series = [Series { values: &data.series, rgb: tile.accent() }];
    col().grow(1.0).justify_between().child(head).child(tile.bleed_chart(tile.height - 52.0, &series, &Readout { labels: days_of(overview), names: Vec::new() }))
}

fn legend(entries: &[(String, rune::Color)]) -> El {
    let mut legend = row().gap(14.0).flex_wrap();
    for (label, color) in entries {
        legend = legend.child(
            row().gap(6.0).center_y().child(el().size(8.0, 8.0).fill(*color)).child(text(label.clone()).font(theme::label(10.0)).color(theme::FG)),
        );
    }
    legend
}

/// Columns of stacked segments that share one scale.
fn columns(height: f32, groups: &[(String, Vec<(rune::Color, f64, bool)>)]) -> El {
    let peak = groups.iter().map(|(_, bars)| bars.iter().map(|bar| bar.1).fold(0.0, f64::max)).fold(0.0, f64::max).max(1.0);
    let bar_h = (height - 22.0).max(8.0);
    let mut chart = row().w_full().h(height).gap(12.0).items_end();
    for (label, bars) in groups {
        let mut pair = row().gap(4.0).items_end().h(bar_h);
        for (color, value, outlined) in bars {
            let h = ((*value / peak) as f32 * bar_h).max(2.0);
            let bar = el().grow(1.0).h(h);
            pair = pair.child(if *outlined { bar.border(2.0, *color) } else { bar.fill(*color) });
        }
        chart = chart.child(col().grow(1.0).gap(6.0).child(pair).child(text(label.clone()).font(theme::label(10.0)).color(theme::DIM)));
    }
    chart
}

fn split_body(tile: &Tile<'_>) -> El {
    let Some(overview) = tile.overview() else { return el() };
    let mut data = metric_of(overview, tile.config["metric"].as_str().unwrap_or("views"), "all");
    if !data.has_data {
        return ui::empty("No data yet");
    }
    data.by_platform.retain(|entry| entry.total > 0.0 || entry.previous > 0.0);
    data.by_platform.sort_by(|a, b| b.total.total_cmp(&a.total));
    let range = tile.config["range"].as_f64().unwrap_or(28.0);
    let groups: Vec<_> = data
        .by_platform
        .iter()
        .map(|entry| (theme::platform_label(&entry.platform).to_string(), vec![(theme::coral(), entry.total, false), (theme::FG, entry.previous, true)]))
        .collect();
    let keys = legend(&[(format!("Last {range}d"), theme::coral()), ("Previous".to_string(), theme::FG)]);
    col().grow(1.0).justify_between().child(keys).child(columns(tile.height - 30.0, &groups))
}

fn mix_body(tile: &Tile<'_>) -> El {
    let Some(overview) = tile.overview() else { return el() };
    let mut data = metric_of(overview, tile.config["metric"].as_str().unwrap_or("views"), "all");
    data.by_platform.retain(|entry| entry.total > 0.0);
    data.by_platform.sort_by(|a, b| b.total.total_cmp(&a.total));
    if data.by_platform.is_empty() {
        return ui::empty("No data yet");
    }
    let keys: Vec<_> = data
        .by_platform
        .iter()
        .map(|entry| (format!("{} {}", theme::platform_label(&entry.platform), fmt::compact(entry.total)), theme::platform_color(&entry.platform)))
        .collect();
    let body = if tile.config["chart"].as_str().unwrap_or("lines") == "bars" {
        let groups: Vec<_> = data
            .by_platform
            .iter()
            .map(|entry| (theme::platform_label(&entry.platform).to_string(), vec![(theme::platform_color(&entry.platform), entry.total, false)]))
            .collect();
        columns(tile.height - 34.0, &groups)
    } else {
        // Biggest platform first, so the smaller areas draw over it.
        let series: Vec<Series<'_>> = data.by_platform.iter().map(|entry| Series { values: &entry.days, rgb: theme::platform_rgb(&entry.platform) }).collect();
        let names = data.by_platform.iter().map(|entry| theme::platform_label(&entry.platform).to_string()).collect();
        tile.bleed_chart(tile.height - 34.0, &series, &Readout { labels: days_of(overview), names })
    };
    col().grow(1.0).justify_between().child(legend(&keys)).child(body)
}

fn platform_body(tile: &Tile<'_>) -> El {
    let Some(overview) = tile.overview() else { return el() };
    let platform = tile.config["platform"].as_str().unwrap_or("all");
    let connected = overview["platforms"].as_array().is_some_and(|list| list.iter().any(|entry| entry == platform));
    if !connected {
        return ui::empty("Not connected");
    }
    let views = metric_of(overview, "views", platform);
    let stat = |value: f64, label: &str| col().gap(2.0).child(figure(fmt::compact(value), 26.0)).child(text(label.to_uppercase()).font(theme::label(10.0)).color(theme::DIM));
    let mut stats = row().gap(20.0);
    if let Some(followers) = overview["followersTotal"][platform].as_f64().filter(|v| *v > 0.0) {
        stats = stats.child(stat(followers, "Followers"));
    }
    if tile.cols > 1.0 && views.total > 0.0 {
        stats = stats.child(stat(views.total, "Views"));
    }
    let mut body = col().grow(1.0).justify_between().child(stats);
    if views.has_data {
        body = body.child(tile.bleed_chart(tile.height - 62.0, &[Series { values: &views.series, rgb: tile.accent() }], &Readout { labels: days_of(overview), names: Vec::new() }));
    }
    body
}

fn post_title(post: &Json) -> String {
    post["title"].as_str().or(post["text"].as_str()).unwrap_or("Untitled").lines().next().unwrap_or("").to_string()
}

fn top_posts_body(tile: &Tile<'_>) -> El {
    let Some(posts) = tile.s.query("dashboard:topPosts", top_posts_args(tile.config, tile.s.hour())).and_then(Json::as_array) else { return el() };
    if posts.is_empty() {
        return ui::empty("No posts in this period");
    }
    let metric = match tile.config["metric"].as_str().unwrap_or("views") {
        "followers" => "views",
        other => other,
    };
    let row_h = 36.0;
    let per_column = ((tile.height / row_h).floor() as usize).max(1);
    let columns = if tile.cols >= 4.0 { 2 } else { 1 };
    let mut body = row().grow(1.0).gap(24.0);
    for column in 0..columns {
        let mut list = col().grow(1.0).min_w(0.0);
        for (index, post) in posts.iter().enumerate().skip(column * per_column).take(per_column) {
            let url = post["permalink"].as_str().unwrap_or("").to_string();
            list = list.child(
                row()
                    .key(format!("{}-post-{index}", tile.id))
                    .h(row_h)
                    .gap(10.0)
                    .center_y()
                    .cursor(rune::Cursor::Pointer)
                    .hover(theme::FG.alpha(0.08))
                    .on_press_tx(move |s: &mut App, tx| {
                        if !url.is_empty() && tx.open_url(&url).is_err() {
                            s.notice = Some("Could not open your browser.".into());
                        }
                    })
                    .child(text(format!("{}", index + 1)).font(theme::label(11.0)).color(theme::FAINT).w(18.0))
                    .child(el().size(8.0, 8.0).fill(theme::platform_color(post["platform"].as_str().unwrap_or(""))))
                    .child(text(post_title(post)).font(theme::mono(13.0)).color(theme::FG).truncate().grow(1.0).min_w(0.0))
                    .child(text(fmt::compact(post[metric].as_f64().unwrap_or(0.0))).font(theme::mono(13.0)).color(theme::FG)),
            );
        }
        body = body.child(list);
    }
    body
}

fn latest_post_body(tile: &Tile<'_>) -> El {
    let Some(latest) = tile.s.query("dashboard:latestPost", platform_arg(tile.config)) else { return el() };
    if latest.is_null() {
        return ui::empty("No posts yet");
    }
    let post = &latest["post"];
    let platform = post["platform"].as_str().unwrap_or("");
    let head = col()
        .gap(4.0)
        .child(text(post_title(post)).font(theme::mono(13.0)).color(theme::FG).truncate())
        .child(
            text(format!("{} · {}", theme::platform_label(platform), fmt::relative_time(post["publishedAt"].as_f64().unwrap_or(0.0), tile.s.now)).to_uppercase())
                .font(theme::label(10.0))
                .color(theme::DIM),
        );
    let mut stats = row().gap(20.0);
    for (label, field) in [("Views", "views"), ("Likes", "likes"), ("Comments", "comments")] {
        if let Some(value) = post[field].as_f64().filter(|v| *v > 0.0) {
            stats = stats.child(col().gap(2.0).child(figure(fmt::compact(value), 20.0)).child(text(label.to_uppercase()).font(theme::label(10.0)).color(theme::DIM)));
        }
    }
    let curve: Vec<f64> = latest["curve"].as_array().into_iter().flatten().filter_map(Json::as_f64).collect();
    let mut body = col().grow(1.0).justify_between().child(col().gap(12.0).child(head).child(stats));
    if tile.rows > 1.0 && curve.len() > 2 {
        body = body.child(tile.bleed_chart(tile.height - 110.0, &[Series { values: &curve, rgb: theme::platform_rgb(platform) }], &Readout::default()));
    }
    body
}

fn inbox_body(tile: &Tile<'_>) -> El {
    let Some(summary) = tile.s.query("comments:openSummary", platform_arg(tile.config)) else { return el() };
    let count = summary["count"].as_f64().unwrap_or(0.0);
    if count == 0.0 {
        return ui::empty("All caught up");
    }
    let mut list = col().gap(8.0).grow(1.0).min_w(0.0);
    for comment in summary["latest"].as_array().into_iter().flatten().take(if tile.rows < 2.0 { 2 } else { 3 }) {
        let author = comment["authorHandle"].as_str().or(comment["authorName"].as_str()).unwrap_or("Someone");
        let meta = format!(
            "{} · {author} · {}",
            theme::platform_label(comment["platform"].as_str().unwrap_or("")),
            fmt::relative_time(comment["publishedAt"].as_f64().unwrap_or(0.0), tile.s.now)
        );
        list = list.child(
            col()
                .gap(2.0)
                .child(text(meta.to_uppercase()).font(theme::label(10.0)).color(theme::DIM).truncate())
                .child(text(comment["text"].as_str().unwrap_or("").replace('\n', " ")).font(theme::mono(13.0)).color(theme::FG).truncate()),
        );
    }
    let total = if count >= 100.0 { "99+".to_string() } else { format!("{count}") };
    row().grow(1.0).gap(20.0).items_end().child(figure(total, 40.0)).child(list)
}

/// A goal's progress: the bar fills to the value, and a tick marks where today should be.
pub fn goal_row(goal: &Json, compact: bool) -> El {
    let progress = goal["progress"].as_f64().unwrap_or(0.0).clamp(0.0, 1.0) as f32;
    let pace = goal["elapsedShare"].as_f64().unwrap_or(0.0).clamp(0.0, 1.0) as f32;
    let state = goal["state"].as_str().unwrap_or("");
    let behind = state == "behind" || state == "missed";
    let figures = format!("{} / {}", fmt::compact(goal["value"].as_f64().unwrap_or(0.0)), fmt::compact(goal["target"].as_f64().unwrap_or(0.0)));
    let bar = el()
        .w_full()
        .h(if compact { 6.0 } else { 10.0 })
        .border(1.0, theme::line())
        .child(el().w_frac(progress).h_full().fill(if state == "done" { theme::FG } else { theme::coral() }))
        .child(el().absolute(0.0, 0.0).w_frac(pace).h_full().border_sides([0.0, 2.0, 0.0, 0.0], theme::FG));
    col()
        .gap(6.0)
        .child(
            row()
                .justify_between()
                .gap(12.0)
                .child(text(goal["title"].as_str().unwrap_or("").to_string()).font(theme::mono(13.0)).color(theme::FG).truncate().grow(1.0).min_w(0.0))
                .child(text(figures).font(theme::mono(13.0)).color(if behind { theme::coral() } else { theme::FG })),
        )
        .child(bar)
}

fn goals_body(tile: &Tile<'_>) -> El {
    let Some(data) = tile.s.query("goals:list", json!({ "today": tile.s.today() })) else { return el() };
    let active: Vec<&Json> = data["goals"].as_array().into_iter().flatten().filter(|goal| goal["state"] != "missed").collect();
    if active.is_empty() {
        return ui::empty("No goals yet");
    }
    let fit = ((tile.height / 44.0).floor() as usize).max(1);
    let mut list = col().grow(1.0).gap(14.0).justify_end();
    for goal in active.into_iter().take(fit) {
        list = list.child(goal_row(goal, true));
    }
    list
}

fn widget(s: &App, widget: &Json, cell: f32, row_h: f32, scale: f32) -> El {
    let id = widget["id"].as_str().unwrap_or("widget");
    let kind = widget["type"].as_str().unwrap_or("");
    let (cols, rows) = match widget["size"].as_str().unwrap_or("m") {
        "s" => (1.0, 1.0),
        "m" => (2.0, 1.0),
        "l" => (2.0, 2.0),
        "w" => (4.0, 1.0),
        _ => (4.0, 2.0),
    };
    let width = cols * cell + (cols - 1.0) * GAP;
    let height = rows * row_h + (rows - 1.0) * GAP;
    let tile = Tile {
        s,
        id,
        config: &widget["config"],
        width: width - TILE_PAD * 2.0,
        height: height - TILE_PAD * 2.0 - TITLE_H - 10.0,
        cols,
        rows,
        scale,
    };
    let body = match kind {
        "metric" => metric_body(&tile),
        "trend" => trend_body(&tile),
        "split" => split_body(&tile),
        "mix" => mix_body(&tile),
        "platform" => platform_body(&tile),
        "topPosts" => top_posts_body(&tile),
        "latestPost" => latest_post_body(&tile),
        "inbox" => inbox_body(&tile),
        "goals" => goals_body(&tile),
        _ => el(),
    };
    let mut frame = col()
        .key(format!("widget-{id}"))
        .size(width, height)
        .padding(TILE_PAD)
        .gap(10.0)
        .border(2.0, theme::line())
        .clip_rounded(0.0)
        .child(text(title_for(kind, &widget["config"]).to_uppercase()).font(theme::label(10.0)).color(theme::DIM).truncate().h(TITLE_H))
        .child(col().grow(1.0).min_h(0.0).child(body));
    // Tiles that summarise another page take you there.
    let target = match kind {
        "inbox" => Some(Tab::Inbox),
        "goals" => Some(Tab::Goals),
        "latestPost" => Some(Tab::Posts),
        _ => None,
    };
    if let Some(tab) = target {
        frame = frame.cursor(rune::Cursor::Pointer).on_press(move |s: &mut App| s.tab = tab);
    }
    frame
}

pub fn view(s: &App, cx: &mut Cx<App>) -> El {
    if s.query("accounts:list", json!({})).is_some() && s.accounts().is_empty() {
        return col().grow(1.0).center().gap(12.0).child(
            col()
                .gap(12.0)
                .items_start()
                .child(ui::button("go-accounts", "Connect accounts", ui::Kind::Primary).on_press(|s: &mut App| s.tab = Tab::Accounts))
                .child(ui::button("load-demo", "Try with demo data", ui::Kind::Outline).on_press(|s: &mut App| s.mutate("accounts:loadDemo", json!({})))),
        );
    }
    let Some(layout) = s.query("layouts:get", json!({})).and_then(Json::as_array) else { return col().grow(1.0) };
    let available = cx.layout_size("main").map_or(996.0, |size| size[0]);
    let cell = ((available - PAD * 2.0 - GAP * (COLS - 1.0)) / COLS).floor().max(120.0);
    let row_h = (cell * 0.72).clamp(150.0, 210.0).round();
    let scale = cx.env().scale;
    let mut grid = row().key("grid").px(PAD).pt(20.0).pb(PAD).gap(GAP).flex_wrap().items_start();
    for item in layout {
        grid = grid.child(widget(s, item, cell, row_h, scale));
    }
    ui::page("home", None, grid)
}
