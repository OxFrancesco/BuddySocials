//! Posts, Inbox, Goals and Accounts.

use rune::{El, col, el, row, text, text_input};
use serde_json::{Value as Json, json};

use crate::backend::{AuthState, Cmd};
use crate::{App, DraftEdit, fmt, home, media, preview, theme, ui};

pub(crate) fn open(url: String) -> impl Fn(&mut App, &mut rune::Tx) {
    move |s, tx| {
        if !url.is_empty() && tx.open_url(&url).is_err() {
            s.notice = Some("Could not open your browser.".into());
        }
    }
}

fn platform_chips(prefix: &str, current: &str, set: fn(&mut App, String)) -> El {
    let mut chips = row().gap(8.0).flex_wrap();
    for platform in std::iter::once("all").chain(theme::PLATFORMS) {
        let value = platform.to_string();
        chips = chips.child(
            ui::chip(format!("{prefix}-{platform}"), theme::platform_label(platform), current == platform).on_press(move |s: &mut App| set(s, value.clone())),
        );
    }
    chips
}

/// The longest post each platform takes, to show a count while writing. The server decides what can be sent.
fn text_limit(platform: &str) -> Option<usize> {
    match platform {
        "x" => Some(280),
        "linkedin" => Some(3000),
        _ => None,
    }
}

fn view_switch(s: &App) -> El {
    row()
        .gap(8.0)
        .child(ui::chip("posts-published", "Published", !s.show_drafts).on_press(|s: &mut App| s.show_drafts = false))
        .child(ui::chip("posts-drafts", "Drafts", s.show_drafts).on_press(|s: &mut App| s.show_drafts = true))
}

pub fn draft_json(edit: &DraftEdit) -> Json {
    let mut draft = json!({ "text": edit.text.text.clone(), "accountIds": edit.accounts });
    if let Some(id) = &edit.id {
        draft["draftId"] = json!(id);
    }
    if let Some(records) = media::records(edit) {
        draft["media"] = json!(records);
    }
    draft
}

fn draft_editor(s: &App, edit: &DraftEdit) -> El {
    let length = edit.text.text.trim().chars().count();
    let saved = edit.id.as_ref().and_then(|id| {
        s.query("drafts:list", json!({})).and_then(Json::as_array).and_then(|drafts| drafts.iter().find(|draft| draft["_id"] == id.as_str()))
    });
    let mut accounts = row().gap(8.0).flex_wrap();
    let mut counts: Vec<(String, bool)> = Vec::new();
    for account in s.accounts() {
        let id = account["_id"].as_str().unwrap_or("").to_string();
        let platform = account["platform"].as_str().unwrap_or("");
        let chosen = edit.accounts.contains(&id);
        if chosen {
            if let Some(limit) = text_limit(platform) {
                counts.push((format!("{} {length} / {limit}", theme::platform_label(platform)), length > limit));
            }
        }
        let label = format!("{} · {}", theme::platform_label(platform), account["handle"].as_str().unwrap_or(""));
        let toggle = id.clone();
        accounts = accounts.child(ui::chip(format!("draft-account-{id}"), &label, chosen).on_press(move |s: &mut App| {
            let Some(edit) = &mut s.draft else { return };
            if let Some(at) = edit.accounts.iter().position(|entry| *entry == toggle) {
                edit.accounts.remove(at);
            } else {
                edit.accounts.push(toggle.clone());
            }
            edit.confirming = false;
        }));
    }
    let frame = col().key("draft-editor").mx(24.0).mb(24.0).padding(16.0).gap(14.0).border(2.0, if edit.drop_over { theme::coral() } else { theme::FG });
    // Cropping or trimming takes the whole panel, so the picture gets the room.
    if let Some(editing) = &edit.editing {
        return frame.child(media::editor(editing));
    }
    let mut editor = frame
        .child(
            col().min_h(120.0).child(
                text_input(&edit.text, theme::mono(15.0))
                    .key("draft-text")
                    .w_full()
                    .color(theme::FG)
                    .caret(theme::coral(), theme::coral().alpha(0.4))
                    .placeholder("What do you want to post?", theme::FAINT)
                    .on_input_paste(|s: &mut App, content, _| media::paste(s, content))
                    .on_edit(|s: &mut App| &mut s.draft.as_mut().expect("the editor is open").text),
            ),
        )
        .child(media::strip(edit))
        .child(accounts);
    if !counts.is_empty() {
        let mut line = row().gap(16.0);
        for (label, over) in counts {
            line = line.child(text(label.to_uppercase()).font(theme::label(10.0)).color(if over { theme::coral() } else { theme::DIM }));
        }
        editor = editor.child(line);
    }
    // What the server said about the saved draft: why a target can't post, or how each post went.
    for target in saved.and_then(|draft| draft["targets"].as_array()).into_iter().flatten() {
        let who = format!("{} · {}", theme::platform_label(target["platform"].as_str().unwrap_or("")), target["handle"].as_str().unwrap_or(""));
        let (note, alert) = match target["state"].as_str() {
            Some("published") => ("Published".to_string(), false),
            Some("queued") | Some("sending") => ("Publishing".to_string(), false),
            Some("failed") => (target["error"].as_str().unwrap_or("Not sent").to_string(), true),
            _ => match target["issues"].as_array().and_then(|issues| issues.first()).and_then(Json::as_str) {
                Some(issue) => (issue.to_string(), true),
                None => continue,
            },
        };
        let mut line = row().gap(12.0).center_y().child(text(format!("{who}: {note}")).font(theme::mono(13.0)).color(if alert { theme::coral() } else { theme::FG }).wrap().grow(1.0));
        if let Some(url) = target["permalink"].as_str() {
            line = line.child(ui::button(format!("open-{}", target["accountId"].as_str().unwrap_or("")), "Open", ui::Kind::Ghost).on_press_tx(open(url.to_string())));
        }
        editor = editor.child(line);
    }
    // Nothing is saved or sent while a file is still on its way up, so a draft never loses an attachment.
    let settled = !media::working(edit);
    let can_send = settled && !edit.accounts.is_empty() && (length > 0 || !edit.media.is_empty());
    let mut actions = row().gap(8.0).center_y();
    if settled {
        actions = actions.child(ui::button("draft-save", "Save", ui::Kind::Outline).on_press(|s: &mut App| {
            let Some(edit) = s.draft.take() else { return };
            s.mutate("drafts:save", draft_json(&edit));
        }));
    } else {
        actions = actions.child(text("FINISHING ATTACHMENTS").key("draft-waiting").font(theme::label(10.0)).color(theme::DIM));
    }
    if can_send {
        actions = actions.child(
            ui::button("draft-publish", if edit.confirming { "Post it now" } else { "Publish" }, ui::Kind::Primary).on_press(|s: &mut App| {
                let Some(edit) = &mut s.draft else { return };
                if !edit.confirming {
                    edit.confirming = true;
                    return;
                }
                let draft = draft_json(edit);
                s.draft = None;
                s.send(Cmd::PublishDraft { draft });
            }),
        );
    }
    actions = actions.child(ui::button("draft-close", "Close", ui::Kind::Ghost).on_press(|s: &mut App| s.draft = None));
    if let Some(id) = edit.id.clone() {
        actions = actions.child(col().grow(1.0)).child(ui::button("draft-delete", "Delete", ui::Kind::Ghost).on_press(move |s: &mut App| {
            s.mutate("drafts:remove", json!({ "draftId": id }));
            s.draft = None;
        }));
    }
    editor.child(actions)
}

fn drafts(s: &App) -> El {
    let bar = row().gap(8.0).center_y().child(view_switch(s)).child(col().grow(1.0)).child(ui::button("new-draft", "New draft", ui::Kind::Primary).on_press(|s: &mut App| {
        s.draft = Some(DraftEdit::new(None, "", Vec::new()));
    }));
    // Files dropped anywhere on the page land on the open draft, or start one.
    let mut content = col()
        .pb(32.0)
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
    if let Some(edit) = &s.draft {
        content = content.child(draft_editor(s, edit));
    }
    let Some(drafts) = s.query("drafts:list", json!({})).and_then(Json::as_array) else { return ui::page("drafts", Some(bar), content) };
    if drafts.is_empty() && s.draft.is_none() {
        content = content.child(col().px(24.0).child(ui::empty("No drafts yet.")));
    }
    ui::page("drafts", Some(bar), content.child(preview::gallery(s, drafts)).child(cleanup(s)))
}

/// Unused uploads: when they are deleted, how much is waiting, and a button to delete them now.
fn cleanup(s: &App) -> El {
    let Some(state) = s.query("media:cleanup", json!({})).filter(|state| state.is_object()) else { return el() };
    let after = state["afterDays"].as_f64();
    let mut choices = row().gap(8.0).flex_wrap();
    for days in state["options"].as_array().into_iter().flatten().filter_map(Json::as_f64) {
        let label = if days == 1.0 { "1 day".to_string() } else { format!("{days} days") };
        choices = choices.child(ui::chip(format!("cleanup-after-{days}"), &label, after == Some(days)).on_press(move |s: &mut App| s.mutate("media:setCleanup", json!({ "afterDays": days }))));
    }
    choices = choices.child(ui::chip("cleanup-after-never", "By hand", after.is_none()).on_press(|s: &mut App| s.mutate("media:setCleanup", json!({ "afterDays": null }))));
    let files = state["files"].as_f64().unwrap_or(0.0);
    let waiting = if files == 0.0 {
        "No unused files.".to_string()
    } else {
        format!("{files}{} unused file{}, {}.", if state["more"] == true { "+" } else { "" }, if files == 1.0 { "" } else { "s" }, fmt::bytes(state["bytes"].as_f64().unwrap_or(0.0)))
    };
    let mut line = row().gap(16.0).center_y().child(text(waiting).key("cleanup-waiting").font(theme::mono(13.0)).color(theme::DIM));
    if files > 0.0 {
        line = line.child(ui::button("cleanup-now", "Delete now", ui::Kind::Outline).on_press(|s: &mut App| s.mutate("media:cleanupNow", json!({}))));
    }
    col()
        .key("cleanup")
        .px(24.0)
        .pt(40.0)
        .gap(12.0)
        .child(text("DELETE UNUSED IMAGES AND VIDEOS AFTER").font(theme::label(10.0)).color(theme::DIM))
        .child(choices)
        .child(line)
}

pub fn posts(s: &App) -> El {
    if s.show_drafts {
        return drafts(s);
    }
    let bar = row().gap(24.0).flex_wrap().child(view_switch(s)).child(platform_chips("posts-filter", &s.posts_filter, |s, value| s.posts_filter = value));
    let Some(page) = s.query("dashboard:posts", s.posts_args()) else { return ui::page("posts", Some(bar), el()) };
    let posts = page["page"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let mut list = col().px(24.0).pb(32.0);
    if posts.is_empty() {
        list = list.child(ui::empty("No posts yet."));
    }
    for post in posts {
        let platform = post["platform"].as_str().unwrap_or("");
        let title = post["title"].as_str().or(post["text"].as_str()).unwrap_or("Untitled").lines().next().unwrap_or("").to_string();
        let meta = format!("{} · {}", theme::platform_label(platform), fmt::relative_time(post["publishedAt"].as_f64().unwrap_or(0.0), s.now));
        let mut stats = row().gap(24.0);
        for (label, field) in [("Views", "views"), ("Likes", "likes"), ("Comments", "comments"), ("Shares", "shares")] {
            let value = post[field].as_f64().map(fmt::compact).unwrap_or_else(|| "–".into());
            stats = stats.child(
                col().w(72.0).gap(2.0).items_end().child(text(value).font(theme::mono(14.0)).color(theme::FG)).child(text(label.to_uppercase()).font(theme::label(9.0)).color(theme::FAINT)),
            );
        }
        list = list.child(
            row()
                .key(format!("post-{}", post["_id"].as_str().unwrap_or("")))
                .py(14.0)
                .gap(16.0)
                .center_y()
                .border_sides([0.0, 0.0, 1.0, 0.0], theme::line())
                .cursor(rune::Cursor::Pointer)
                .hover(theme::FG.alpha(0.06))
                .on_press_tx(open(post["permalink"].as_str().unwrap_or("").to_string()))
                .child(el().size(10.0, 10.0).fill(theme::platform_color(platform)))
                .child(
                    col()
                        .grow(1.0)
                        .min_w(0.0)
                        .gap(4.0)
                        .child(text(title).font(theme::mono(14.0)).color(theme::FG).truncate())
                        .child(text(meta.to_uppercase()).font(theme::label(10.0)).color(theme::DIM)),
                )
                .child(stats),
        );
    }
    ui::page("posts", Some(bar), list)
}

pub fn inbox(s: &App) -> El {
    let bar = row()
        .gap(8.0)
        .child(ui::chip("inbox-open", "Open", s.inbox_open_only).on_press(|s: &mut App| s.inbox_open_only = true))
        .child(ui::chip("inbox-everything", "All", !s.inbox_open_only).on_press(|s: &mut App| s.inbox_open_only = false));
    let Some(page) = s.query("comments:list", s.inbox_args()) else { return ui::page("inbox", Some(bar), el()) };
    let comments = page["page"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let mut list = col().px(24.0).pb(32.0);
    if comments.is_empty() {
        list = list.child(ui::empty(if s.inbox_open_only { "All caught up." } else { "No comments yet." }));
    }
    for comment in comments {
        let id = comment["_id"].as_str().unwrap_or("").to_string();
        let author = comment["authorHandle"].as_str().or(comment["authorName"].as_str()).unwrap_or("Someone");
        let platform = comment["platform"].as_str().unwrap_or("");
        let meta = format!("{} · {author} · {}", theme::platform_label(platform), fmt::relative_time(comment["publishedAt"].as_f64().unwrap_or(0.0), s.now));
        let mut item = col()
            .key(format!("comment-{id}"))
            .py(16.0)
            .gap(8.0)
            .border_sides([0.0, 0.0, 1.0, 0.0], theme::line())
            .child(
                row()
                    .gap(8.0)
                    .center_y()
                    .child(el().size(8.0, 8.0).fill(theme::platform_color(platform)))
                    .child(text(meta.to_uppercase()).font(theme::label(10.0)).color(theme::DIM)),
            )
            .child(text(comment["text"].as_str().unwrap_or("").to_string()).font(theme::mono(14.0)).color(theme::FG).wrap());
        if let Some(title) = comment["postTitle"].as_str() {
            item = item.child(text(format!("On: {}", title.lines().next().unwrap_or(""))).font(theme::mono(12.0)).color(theme::FAINT).truncate());
        }
        let reply = &comment["reply"];
        let status = reply["status"].as_str().unwrap_or("");
        if !reply.is_null() {
            let (note, ink) = match status {
                "sending" => ("Sending".to_string(), theme::DIM),
                "failed" => (format!("Not sent: {}", reply["error"].as_str().unwrap_or("try again")), theme::coral()),
                _ => ("You replied".to_string(), theme::DIM),
            };
            item = item.child(
                col()
                    .pl(12.0)
                    .gap(4.0)
                    .border_sides([0.0, 0.0, 0.0, 2.0], theme::line())
                    .child(text(note.to_uppercase()).font(theme::label(10.0)).color(ink))
                    .child(text(reply["text"].as_str().unwrap_or("").to_string()).font(theme::mono(13.0)).color(theme::FG).wrap()),
            );
        }
        let can_act = reply.is_null() || status == "failed";
        if s.reply_to.as_deref() == Some(id.as_str()) {
            let send = |s: &mut App| {
                let Some(comment_id) = s.reply_to.take() else { return };
                let text = s.reply.text.trim().to_string();
                if !text.is_empty() {
                    s.mutate("comments:reply", json!({ "commentId": comment_id, "text": text }));
                }
                s.reply.clear();
            };
            item = item.child(
                row()
                    .gap(8.0)
                    .center_y()
                    .child(
                        row().grow(1.0).min_w(0.0).h(36.0).px(10.0).center_y().border(2.0, theme::FG).child(
                            text_input(&s.reply, theme::mono(14.0))
                                .key("reply-field")
                                .single_line()
                                .grow(1.0)
                                .color(theme::FG)
                                .caret(theme::coral(), theme::coral().alpha(0.4))
                                .placeholder("Write a reply", theme::FAINT)
                                .on_edit(|s: &mut App| &mut s.reply)
                                .on_submit(move |s: &mut App, _tx| send(s)),
                        ),
                    )
                    .child(ui::button("reply-send", "Send", ui::Kind::Primary).on_press(send))
                    .child(ui::button("reply-cancel", "Cancel", ui::Kind::Ghost).on_press(|s: &mut App| {
                        s.reply_to = None;
                        s.reply.clear();
                    })),
            );
        } else if can_act {
            let done = comment["state"] == "done";
            let (reply_id, done_id) = (id.clone(), id.clone());
            item = item.child(
                row()
                    .gap(8.0)
                    .child(ui::button(format!("reply-{id}"), "Reply", ui::Kind::Outline).on_press(move |s: &mut App| {
                        s.reply_to = Some(reply_id.clone());
                        s.reply.clear();
                        s.reply.focused = true;
                    }))
                    .child(
                        ui::button(format!("done-{id}"), if done { "Reopen" } else { "Done" }, ui::Kind::Ghost)
                            .on_press(move |s: &mut App| s.mutate("comments:setDone", json!({ "commentId": done_id, "done": !done }))),
                    ),
            );
        }
        list = list.child(item);
    }
    ui::page("inbox", Some(bar), list)
}

pub fn goals(s: &App) -> El {
    let Some(data) = s.query("goals:list", json!({ "today": s.today() })) else { return ui::page("goals", None, el()) };
    let goals = data["goals"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let mut list = col().px(24.0).pt(20.0).pb(32.0).gap(24.0);
    if goals.is_empty() {
        list = list.child(ui::empty("No goals yet. Set one from the phone app."));
    }
    for goal in goals {
        let state = goal["state"].as_str().unwrap_or("");
        let days = goal["daysLeft"].as_f64().unwrap_or(0.0);
        let streak = goal["streak"].as_f64().unwrap_or(0.0);
        let mut note = match state {
            "done" => "Reached".to_string(),
            "missed" => "Missed".to_string(),
            "upcoming" => "Not started".to_string(),
            "behind" => format!("Behind · {days} days left"),
            _ => format!("On pace · {days} days left"),
        };
        if streak > 0.0 {
            note = format!("{note} · {streak} in a row");
        }
        list = list.child(
            col()
                .key(format!("goal-{}", goal["_id"].as_str().unwrap_or("")))
                .gap(8.0)
                .child(home::goal_row(goal, false))
                .child(text(note.to_uppercase()).font(theme::label(10.0)).color(if state == "behind" || state == "missed" { theme::coral() } else { theme::DIM })),
        );
    }
    ui::page("goals", None, list)
}

fn account_status(account: &Json, syncing: bool) -> (String, bool) {
    match account["status"].as_str().unwrap_or("") {
        "syncing" if syncing => ("Syncing".into(), false),
        "reconnect" => ("Sign in again".into(), true),
        "error" => (account["lastError"].as_str().unwrap_or("Sync failed").to_string(), true),
        _ => match account["limited"].as_array().filter(|limited| !limited.is_empty()) {
            Some(limited) => (format!("No access to {}", limited.iter().filter_map(Json::as_str).collect::<Vec<_>>().join(", ")), false),
            None => (if account["source"] == "demo" { "Demo data" } else { "Connected" }.to_string(), false),
        },
    }
}

pub fn accounts(s: &App) -> El {
    let accounts = s.accounts();
    let available = s.query("connectStore:availability", json!({}));
    let pages_available = s.query("connectStore:pagesAvailable", json!({})).is_some_and(|v| v == true);
    let mut list = col().px(24.0).pt(20.0).pb(32.0).gap(18.0);
    for platform in theme::PLATFORMS {
        let own: Vec<&Json> = accounts.iter().filter(|account| account["platform"] == platform).collect();
        let can_connect = available.is_some_and(|available| available[platform] == true);
        let has_direct = own.iter().any(|account| account["source"] == "direct");
        let mut section = col().key(format!("platform-{platform}")).pb(18.0).gap(14.0).border_sides([0.0, 0.0, 1.0, 0.0], theme::line());
        let mut head = row().gap(12.0).center_y().child(text(theme::platform_label(platform).to_uppercase()).font(theme::display(20.0)).color(theme::FG).grow(1.0));
        if can_connect {
            let another = has_direct;
            head = head.child(
                ui::button(format!("connect-{platform}"), if has_direct { "Add another" } else { "Connect" }, if has_direct { ui::Kind::Outline } else { ui::Kind::Primary })
                    .on_press(move |s: &mut App| s.send(Cmd::Connect { platform: platform.to_string(), another, pages: false })),
            );
        }
        if platform == "linkedin" && pages_available {
            head = head.child(
                ui::button("connect-linkedin-pages", "Add a Page", ui::Kind::Outline)
                    .on_press(|s: &mut App| s.send(Cmd::Connect { platform: "linkedin".into(), another: false, pages: true })),
            );
        }
        section = section.child(head);
        if own.is_empty() {
            section = section.child(text("NOT CONNECTED").font(theme::label(10.0)).color(theme::DIM));
        }
        for account in own {
            let id = account["_id"].as_str().unwrap_or("").to_string();
            let running = account["status"] == "syncing" && account["syncStartedAt"].as_f64().is_some_and(|started| s.now - started < 120_000.0);
            let (status, alert) = account_status(account, running);
            let mut details: Vec<String> = Vec::new();
            if let Some(followers) = account["followers"].as_f64().filter(|v| *v > 0.0) {
                details.push(format!("{} followers", fmt::compact(followers)));
            }
            if let Some(synced) = account["lastSyncedAt"].as_f64() {
                details.push(format!("updated {}", fmt::relative_time(synced, s.now)));
            }
            let mut info = col()
                .grow(1.0)
                .min_w(0.0)
                .gap(4.0)
                .child(text(account["handle"].as_str().unwrap_or("").to_string()).font(theme::mono(14.0)).color(theme::FG).truncate())
                .child(text(status.to_uppercase()).font(theme::label(10.0)).color(if alert { theme::coral() } else { theme::DIM }));
            if !details.is_empty() {
                info = info.child(text(details.join(" · ").to_uppercase()).font(theme::label(10.0)).color(theme::FAINT));
            }
            let mut actions = row().gap(8.0);
            if account["source"] == "direct" {
                let page = account["kind"] == "page";
                if account["status"] == "reconnect" && (if page { pages_available } else { can_connect }) {
                    actions = actions.child(
                        ui::button(format!("reconnect-{id}"), "Sign in again", ui::Kind::Primary)
                            .on_press(move |s: &mut App| s.send(Cmd::Connect { platform: platform.to_string(), another: false, pages: page })),
                    );
                } else {
                    let sync_id = id.clone();
                    actions = actions.child(
                        ui::button(format!("sync-{id}"), "Sync", ui::Kind::Outline).on_press(move |s: &mut App| s.mutate("accounts:syncNow", json!({ "accountId": sync_id }))),
                    );
                }
                let confirming = s.confirm_disconnect.as_deref() == Some(id.as_str());
                let disconnect_id = id.clone();
                actions = actions.child(
                    ui::button(format!("disconnect-{id}"), if confirming { "Remove its data?" } else { "Disconnect" }, ui::Kind::Ghost).on_press(move |s: &mut App| {
                        if s.confirm_disconnect.as_deref() == Some(disconnect_id.as_str()) {
                            s.mutate("connectStore:disconnect", json!({ "accountId": disconnect_id }));
                            s.confirm_disconnect = None;
                        } else {
                            s.confirm_disconnect = Some(disconnect_id.clone());
                        }
                    }),
                );
            }
            section = section.child(row().key(format!("account-{id}")).gap(16.0).center_y().child(info).child(actions));
        }
        list = list.child(section);
    }

    let has_demo = accounts.iter().any(|account| account["source"] == "demo");
    let missing = theme::PLATFORMS.iter().any(|platform| !accounts.iter().any(|account| account["platform"] == *platform));
    let mut foot = col().pt(6.0).gap(12.0).items_start();
    if has_demo {
        foot = foot.child(ui::button("remove-demo", "Remove demo data", ui::Kind::Outline).on_press(|s: &mut App| s.mutate("accounts:removeDemo", json!({}))));
    } else if missing {
        foot = foot.child(
            ui::button("load-demo-accounts", "Fill empty platforms with demo data", ui::Kind::Outline).on_press(|s: &mut App| s.mutate("accounts:loadDemo", json!({}))),
        );
    }
    let mut session = row().gap(12.0).center_y().child(ui::button("sign-out", "Sign out", ui::Kind::Ghost).on_press(|s: &mut App| s.send(Cmd::SignOut)));
    if let AuthState::SignedIn { email: Some(email) } = &s.auth {
        session = session.child(text(email.to_uppercase()).font(theme::label(10.0)).color(theme::DIM));
    }
    ui::page("accounts", None, list.child(foot.child(session)))
}
