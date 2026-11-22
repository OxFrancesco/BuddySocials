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

/// Readable UTC date and time: "23 Nov 15:00 UTC".
pub fn format_datetime(timestamp_ms: f64) -> String {
    let total_secs = (timestamp_ms / 1000.0).floor() as i64;
    let days = total_secs.div_euclid(86_400);
    let rem = total_secs.rem_euclid(86_400);
    let hours = rem / 3600;
    let mins = (rem % 3600) / 60;
    let (_, month, day) = civil(days);
    format!("{day} {} {hours:02}:{mins:02} UTC", MONTHS[(month - 1) as usize])
}

/// Days since 1970-01-01 from a UTC calendar date.
fn days_from_civil(year: i64, month: u32, day: u32) -> Option<i64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let y = year - i64::from(month <= 2);
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if month > 2 { month - 3 } else { month + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

/// Tomorrow at `hour:00` UTC in Unix milliseconds.
pub fn tomorrow_utc_at(now_ms: f64, hour: u32) -> f64 {
    let today_days = (now_ms / DAY_MS).floor() as i64;
    let target_secs = (today_days + 1) * 86_400 + i64::from(hour) * 3600;
    (target_secs as f64) * 1000.0
}

/// Parses "YYYY-MM-DD HH:MM" (UTC), ISO-8601 "YYYY-MM-DDTHH:MM(:SS)?Z?", or "+2h" / "+30m".
pub fn parse_schedule(input: &str, now_ms: f64) -> Option<f64> {
    let trimmed = input.trim();
    if let Some(rest) = trimmed.strip_prefix('+') {
        if let Some(hours) = rest.strip_suffix('h').or_else(|| rest.strip_suffix('H')) {
            let n: f64 = hours.trim().parse().ok()?;
            return (n > 0.0).then_some(now_ms + n * 3_600_000.0);
        }
        if let Some(mins) = rest.strip_suffix('m').or_else(|| rest.strip_suffix('M')) {
            let n: f64 = mins.trim().parse().ok()?;
            return (n > 0.0).then_some(now_ms + n * 60_000.0);
        }
        if let Some(days) = rest.strip_suffix('d').or_else(|| rest.strip_suffix('D')) {
            let n: f64 = days.trim().parse().ok()?;
            return (n > 0.0).then_some(now_ms + n * DAY_MS);
        }
    }
    let clean = trimmed.trim_end_matches('Z').trim_end_matches('z').trim_end_matches("UTC").trim();
    let (date_part, time_part) = clean.split_once('T').or_else(|| clean.split_once(' '))?;
    let mut d = date_part.split('-');
    let year: i64 = d.next()?.parse().ok()?;
    let month: u32 = d.next()?.parse().ok()?;
    let day: u32 = d.next()?.parse().ok()?;
    let mut t = time_part.split(':');
    let hour: u32 = t.next()?.parse().ok()?;
    let min: u32 = t.next()?.parse().ok()?;
    let sec: u32 = t.next().and_then(|s| s.split('.').next()).unwrap_or("0").parse().ok()?;
    if hour > 23 || min > 59 || sec > 59 {
        return None;
    }
    let days = days_from_civil(year, month, day)?;
    let total_secs = days * 86_400 + i64::from(hour) * 3600 + i64::from(min) * 60 + i64::from(sec);
    Some((total_secs as f64) * 1000.0)
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

/// A file size for people: "840 KB", "4.2 MB".
pub fn bytes(bytes: f64) -> String {
    const MB: f64 = 1024.0 * 1024.0;
    if bytes < MB {
        format!("{} KB", (bytes / 1024.0).round().max(1.0))
    } else if bytes < MB * 1024.0 {
        format!("{:.1} MB", bytes / MB)
    } else {
        format!("{:.1} GB", bytes / (MB * 1024.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedule_parsing_and_formatting_roundtrip() {
        let now = 1_795_364_000_000.0;
        let in_2h = parse_schedule("+2h", now).unwrap();
        assert!((in_2h - (now + 7_200_000.0)).abs() < 1.0);
        let in_30m = parse_schedule("+30m", now).unwrap();
        assert!((in_30m - (now + 1_800_000.0)).abs() < 1.0);
        let iso = parse_schedule("2026-11-23T15:30:00Z", now).unwrap();
        assert_eq!(format_datetime(iso), "23 Nov 15:30 UTC");
        let space = parse_schedule("2026-11-23 15:30", now).unwrap();
        assert_eq!(space, iso);
        assert!(parse_schedule("not a date", now).is_none());
    }
}
