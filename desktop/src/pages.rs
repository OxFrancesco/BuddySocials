//! Posts, Inbox, Goals and Accounts.

use rune::{El, col, el, row, text, text_input};
use serde_json::{Value as Json, json};

use crate::backend::{AuthState, Cmd};
use crate::{App, fmt, home, theme, ui};

fn open(url: String) -> impl Fn(&mut App, &mut rune::Tx) {
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

pub fn posts(s: &App) -> El {
    let bar = platform_chips("posts-filter", &s.posts_filter, |s, value| s.posts_filter = value);
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
    let mut list = col().padding(24.0).gap(24.0).max_w(720.0);
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
    let mut list = col().padding(24.0).max_w(720.0);
    for platform in theme::PLATFORMS {
        let own: Vec<&Json> = accounts.iter().filter(|account| account["platform"] == platform).collect();
        let can_connect = available.is_some_and(|available| available[platform] == true);
        let has_direct = own.iter().any(|account| account["source"] == "direct");
        let mut section = col().key(format!("platform-{platform}")).py(18.0).gap(14.0).border_sides([0.0, 0.0, 1.0, 0.0], theme::line());
        let mut head = row().gap(12.0).center_y().child(text(theme::platform_label(platform).to_uppercase()).font(theme::display(20.0)).color(theme::FG).grow(1.0));
        if can_connect {
            let another = has_direct;
            head = head.child(
                ui::button(format!("connect-{platform}"), if has_direct { "Add another" } else { "Connect" }, if has_direct { ui::Kind::Outline } else { ui::Kind::Primary })
                    .on_press(move |s: &mut App| s.send(Cmd::Connect { platform: platform.to_string(), another })),
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
                if account["status"] == "reconnect" && can_connect {
                    actions = actions.child(
                        ui::button(format!("reconnect-{id}"), "Sign in again", ui::Kind::Primary)
                            .on_press(move |s: &mut App| s.send(Cmd::Connect { platform: platform.to_string(), another: false })),
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
    let mut foot = col().pt(24.0).gap(12.0).items_start();
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
