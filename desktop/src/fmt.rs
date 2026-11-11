//! Number and date wording, matching the phone app's `shared/format.ts`.

use std::time::{SystemTime, UNIX_EPOCH};

const DAY_MS: f64 = 86_400_000.0;

pub fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

fn trim(value: f64) -> String {
    let fixed = if value.abs() >= 100.0 { format!("{value:.0}") } else { format!("{value:.1}") };
    fixed.strip_suffix(".0").map(str::to_string).unwrap_or(fixed)
}

pub fn compact(value: f64) -> String {
    let abs = value.abs();
    if abs >= 1_000_000.0 {
        format!("{}M", trim(value / 1_000_000.0))
    } else if abs >= 1_000.0 {
        format!("{}K", trim(value / 1_000.0))
    } else {
        format!("{}", value.round() as i64)
    }
}

pub fn grouped(value: f64) -> String {
    let digits = (value.round().abs() as u64).to_string();
    let mut out = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            out.push(',');
        }
        out.push(digit);
    }
    if value < -0.5 { format!("-{out}") } else { out }
}

pub fn percent_change(current: f64, previous: f64) -> Option<f64> {
    (previous > 0.0).then(|| (current - previous) / previous * 100.0)
}

pub fn signed_percent(value: f64) -> String {
    let rounded = if value.abs() >= 10.0 { value.round() } else { (value * 10.0).round() / 10.0 };
    format!("{}{}%", if rounded > 0.0 { "+" } else { "" }, trim(rounded))
}

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// Days since 1970-01-01 to (year, month, day), all UTC.
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

/// YYYY-MM-DD in UTC, the key every stored day uses.
pub fn day_key(timestamp_ms: f64) -> String {
    let (year, month, day) = civil((timestamp_ms / DAY_MS).floor() as i64);
    format!("{year:04}-{month:02}-{day:02}")
}

pub fn short_date(timestamp_ms: f64) -> String {
    let (_, month, day) = civil((timestamp_ms / DAY_MS).floor() as i64);
    format!("{day} {}", MONTHS[(month - 1) as usize])
}

pub fn relative_time(timestamp_ms: f64, now_ms: f64) -> String {
    let seconds = ((now_ms - timestamp_ms) / 1000.0).max(0.0).round();
    if seconds < 60.0 {
        return "now".into();
    }
    let minutes = (seconds / 60.0).round();
    if minutes < 60.0 {
        return format!("{minutes}m");
    }
    let hours = (minutes / 60.0).round();
    if hours < 24.0 {
        return format!("{hours}h");
    }
    let days = (hours / 24.0).round();
    if days < 7.0 {
        return format!("{days}d");
    }
    let weeks = (days / 7.0).round();
    if weeks < 9.0 {
        return format!("{weeks}w");
    }
    short_date(timestamp_ms)
}
