//! oddofrancesco.com/design: black, white and one coral. Grey only exists as an
//! outline. Text never goes grey; it recedes with opacity.

use rune::{Color, Family, TextStyle};

pub const BG: Color = Color { r: 0.0, g: 0.0, b: 0.0, a: 1.0 };
pub const FG: Color = Color { r: 1.0, g: 1.0, b: 1.0, a: 1.0 };
pub const DIM: Color = Color { r: 1.0, g: 1.0, b: 1.0, a: 0.7 };
pub const FAINT: Color = Color { r: 1.0, g: 1.0, b: 1.0, a: 0.6 };
pub const CLEAR: Color = Color { r: 0.0, g: 0.0, b: 0.0, a: 0.0 };

pub fn srgb(hex: u32) -> Color {
    let channel = |shift: u32| {
        let v = ((hex >> shift) & 0xff) as f32 / 255.0;
        if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
    };
    Color { r: channel(16), g: channel(8), b: channel(0), a: 1.0 }
}

pub fn coral() -> Color {
    srgb(0xD6544B)
}

pub fn line() -> Color {
    srgb(0x292929)
}

pub const PLATFORMS: [&str; 5] = ["youtube", "instagram", "tiktok", "x", "linkedin"];

pub fn platform_label(platform: &str) -> &'static str {
    match platform {
        "youtube" => "YouTube",
        "instagram" => "Instagram",
        "tiktok" => "TikTok",
        "x" => "X",
        "linkedin" => "LinkedIn",
        _ => "All",
    }
}

/// sRGB bytes, for charts drawn pixel by pixel.
pub fn platform_rgb(platform: &str) -> [u8; 3] {
    match platform {
        "youtube" => [0xFF, 0x4D, 0x4D],
        "instagram" => [0xE1, 0x44, 0x9B],
        "tiktok" => [0x2E, 0xE6, 0xE0],
        "x" => [0xF2, 0xF2, 0xF2],
        "linkedin" => [0x4C, 0x8D, 0xFF],
        _ => [0xD6, 0x54, 0x4B],
    }
}

pub fn platform_color(platform: &str) -> Color {
    let [r, g, b] = platform_rgb(platform);
    srgb(((r as u32) << 16) | ((g as u32) << 8) | b as u32)
}

const DISPLAY: Family = Family::Named("Chakra Petch");

/// Headings and figures: Chakra Petch, set in uppercase by the caller.
pub const fn display(size: f32) -> TextStyle {
    TextStyle::new(size, 700.0).family(DISPLAY).lh(size * 1.1)
}

/// Sentences, labels and numbers in tables: IBM Plex Mono.
pub const fn mono(size: f32) -> TextStyle {
    TextStyle::new(size, 400.0).lh(size * 1.45)
}

/// Small uppercase labels.
pub const fn label(size: f32) -> TextStyle {
    TextStyle::new(size, 700.0).tracking(size * 0.08).lh(size * 1.3)
}
