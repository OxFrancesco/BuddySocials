//! The few controls every page shares.

use rune::{Cursor, El, ScrollSpec, col, row, text};

use crate::theme;

#[derive(Clone, Copy, PartialEq)]
pub enum Kind {
    /// Coral, for the one main action.
    Primary,
    Outline,
    /// Text only.
    Ghost,
}

pub fn button(key: impl Into<String>, label: &str, kind: Kind) -> El {
    let (fill, ink, border) = match kind {
        Kind::Primary => (theme::coral(), theme::BG, theme::coral()),
        Kind::Outline => (theme::BG, theme::FG, theme::FG),
        Kind::Ghost => (theme::BG, theme::DIM, theme::CLEAR),
    };
    row()
        .key(key)
        .role("button")
        .label(label)
        .focusable(true)
        .h(32.0)
        .px(12.0)
        .center()
        .fill(fill)
        .border(2.0, border)
        .hover(theme::FG.alpha(0.12))
        .cursor(Cursor::Pointer)
        .child(text(label.to_uppercase()).font(theme::label(11.0)).color(ink))
}

/// One of a row of mutually exclusive choices.
pub fn chip(key: impl Into<String>, label: &str, active: bool) -> El {
    row()
        .key(key)
        .role("button")
        .label(label)
        .h(30.0)
        .px(12.0)
        .center()
        .fill(if active { theme::FG } else { theme::BG })
        .border(2.0, if active { theme::FG } else { theme::line() })
        .cursor(Cursor::Pointer)
        .child(text(label.to_uppercase()).font(theme::label(11.0)).color(if active { theme::BG } else { theme::FG }))
}

/// A page: an optional bar of controls that stays put, and content that scrolls under it.
pub fn page(key: &str, bar: Option<El>, content: El) -> El {
    let mut page = col().key(key).grow(1.0).min_h(0.0);
    if let Some(bar) = bar {
        page = page.child(bar.px(24.0).pt(20.0).pb(12.0));
    }
    page.child(
        col()
            .key(format!("{key}-scroll"))
            .grow(1.0)
            .min_h(0.0)
            .scroll(ScrollSpec { stick_bottom: false })
            .child(content),
    )
}

/// Shown where a list or widget has nothing to say yet.
pub fn empty(message: &str) -> El {
    text(message).font(theme::mono(13.0)).color(theme::FAINT)
}
