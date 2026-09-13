use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};


// Registry of in-flight reminder tasks. Each entry is a JoinHandle we can
// abort when the user cancels or replaces a reminder. Keyed by link id.
// Cleared on task completion so we never abort a fired reminder.
static REMINDER_TASKS: Mutex<Option<HashMap<String, tokio::task::JoinHandle<()>>>> = Mutex::new(None);

// Queue serializing popup display: at most one reminder card is on screen at a
// time. When a timer fires and a card is already showing, the new one goes
// into `queue`; `current` is the link id of what's visible. When a card is
// dismissed (Okay or View), we pop the queue entry with the *earliest*
// remind_at_iso — i.e. most-overdue first — and show it next.
struct ReminderQueue {
    current: Option<String>,
    queue: Vec<QueuedReminder>,
}
struct QueuedReminder {
    link_id: String,
    title: String,
    // Kept as ISO string so we can sort lexicographically once normalized to a
    // common representation via parse_iso_to_unix. Multiple offsets in the
    // wild — always parse before comparing.
    remind_at_iso: String,
}
static REMINDER_QUEUE: Mutex<Option<ReminderQueue>> = Mutex::new(None);

// Fired when the user clicks the View button — library listens and scrolls
// to the item. Not the same as the (retired) "reminder-fired" name, which
// was overloaded and confusing. Popup itself now writes acknowledged_at
// straight to localStorage (shared across webviews on the same protocol),
// so we no longer need a separate ack event on the wire.
const REMINDER_VIEW_EVENT: &str = "later://reminder-view-requested";

const POPUP_LABEL: &str = "popup";
const SPOTLIGHT_LABEL: &str = "main";
const LIBRARY_LABEL: &str = "library";
const POPUP_WIDTH: f64 = 400.0;
const POPUP_HEIGHT: f64 = 520.0;
const SPOTLIGHT_WIDTH: f64 = 620.0;
const SPOTLIGHT_HEIGHT: f64 = 64.0;

// Gates the popup blur-hide handler. Set to false during first-launch onboarding
// so the popup stays open while the user reads it — clicking away or focus
// bouncing during macOS accessory-mode startup would otherwise clobber the show.
// `finalize_first_launch` flips it back to true when the user submits or skips.
static HIDE_POPUP_ON_BLUR: AtomicBool = AtomicBool::new(true);

#[tauri::command]
async fn fetch_title(url: String) -> String {
    eprintln!("[later] fetch_title called for: {}", url);
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
        .timeout(std::time::Duration::from_secs(8))
        .build();
    let client = match client {
        Ok(c) => c,
        Err(e) => { eprintln!("[later] fetch_title client build failed: {}", e); return String::new(); }
    };
    let res = match client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => { eprintln!("[later] fetch_title request failed: {}", e); return String::new(); }
    };
    let html = match res.text().await {
        Ok(t) => t,
        Err(e) => { eprintln!("[later] fetch_title body read failed: {}", e); return String::new(); }
    };
    if let Some(cap) = regex_find(&html, r#"og:title"[^>]+content="([^"]+)""#) { return cap; }
    if let Some(cap) = regex_find(&html, r#"content="([^"]+)"[^>]+og:title"#) { return cap; }
    if let Some(cap) = regex_find(&html, r#"<title[^>]*>([^<]+)</title>"#) { return cap; }
    eprintln!("[later] fetch_title: no title pattern matched");
    String::new()
}

// The Cloudflare Worker holding the ANTHROPIC_API_KEY. Both constants are
// baked into the shipped binary. The secret isn't truly secret — it's only
// meant to stop casual scraping/abuse of the endpoint. Real limits live
// server-side (per-IP rate limit + Anthropic monthly cap).
const LATER_API_BASE: &str = "https://later-api.poorvanangia03.workers.dev";
const LATER_API_KEY: &str = "c98175fec0af0ae02de9795fc7361132957c4163ceb3b403480c28dc5dc1e5b3";

// Returns the raw JSON object from the worker's /classify endpoint, forwarded
// to the JS side for verdict handling. Shape:
//   { decision: "assign"|"suggest_existing"|"suggest_new"|"none",
//     category: string, description: string, reason: string }
// On any failure (network, non-2xx, malformed JSON) returns
//   { decision: "none", category: "", description: "", reason: "<code>" }
// so the client always sees the same envelope and can decide UX without
// null-checks.
#[tauri::command]
async fn classify_item(
    text: String,
    existing_categories: Option<Vec<String>>,
    category_descriptions: Option<serde_json::Value>,
    pending_new_names: Option<Vec<String>>,
    user_profile: Option<String>,
) -> serde_json::Value {
    eprintln!("[later] classify_item called, text len: {}", text.len());

    let fail = |reason: &str| -> serde_json::Value {
        serde_json::json!({
            "decision": "none",
            "category": "",
            "description": "",
            "reason": reason,
        })
    };

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build() {
        Ok(c) => c,
        Err(e) => { eprintln!("[later] classify_item client build failed: {}", e); return fail("client_build_failed"); }
    };

    let body = serde_json::json!({
        "text": text,
        "existing_categories": existing_categories.unwrap_or_default(),
        "category_descriptions": category_descriptions.unwrap_or(serde_json::json!({})),
        "pending_new_names": pending_new_names.unwrap_or_default(),
        "user_profile": user_profile.unwrap_or_default(),
    });

    let url = format!("{}/classify", LATER_API_BASE);
    let res = match client
        .post(&url)
        .header("X-Later-Auth", LATER_API_KEY)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await {
        Ok(r) => r,
        Err(e) => { eprintln!("[later] classify_item request failed: {}", e); return fail("request_failed"); }
    };

    let status = res.status();
    let json: serde_json::Value = match res.json().await {
        Ok(j) => j,
        Err(e) => { eprintln!("[later] classify_item json parse failed (HTTP {}): {}", status, e); return fail("json_parse_failed"); }
    };

    if !status.is_success() {
        eprintln!("[later] classify_item HTTP {} response: {}", status, json);
        return fail("http_error");
    }

    eprintln!("[later] classify_item → {}", json);
    json
}

// Second-pass classification for items Haiku wasn't confident about. Same
// contract as classify_item but hits /reclassify (Sonnet 4.6 + extended
// thinking). Client only calls this when the first-pass decision was
// suggest_existing / suggest_new — never for confident assigns.
#[tauri::command]
async fn reclassify_item(
    text: String,
    existing_categories: Option<Vec<String>>,
    category_descriptions: Option<serde_json::Value>,
    pending_new_names: Option<Vec<String>>,
    user_profile: Option<String>,
) -> serde_json::Value {
    eprintln!("[later] reclassify_item called, text len: {}", text.len());

    let fail = |reason: &str| -> serde_json::Value {
        serde_json::json!({
            "decision": "none",
            "category": "",
            "description": "",
            "reason": reason,
        })
    };

    let client = match reqwest::Client::builder()
        // Sonnet + extended thinking takes noticeably longer than Haiku; give
        // it 30s. Client-side loading state absorbs the wait.
        .timeout(std::time::Duration::from_secs(30))
        .build() {
        Ok(c) => c,
        Err(e) => { eprintln!("[later] reclassify_item client build failed: {}", e); return fail("client_build_failed"); }
    };

    let body = serde_json::json!({
        "text": text,
        "existing_categories": existing_categories.unwrap_or_default(),
        "category_descriptions": category_descriptions.unwrap_or(serde_json::json!({})),
        "pending_new_names": pending_new_names.unwrap_or_default(),
        "user_profile": user_profile.unwrap_or_default(),
    });

    let url = format!("{}/reclassify", LATER_API_BASE);
    let res = match client
        .post(&url)
        .header("X-Later-Auth", LATER_API_KEY)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await {
        Ok(r) => r,
        Err(e) => { eprintln!("[later] reclassify_item request failed: {}", e); return fail("request_failed"); }
    };

    let status = res.status();
    let json: serde_json::Value = match res.json().await {
        Ok(j) => j,
        Err(e) => { eprintln!("[later] reclassify_item json parse failed (HTTP {}): {}", status, e); return fail("json_parse_failed"); }
    };

    if !status.is_success() {
        eprintln!("[later] reclassify_item HTTP {} response: {}", status, json);
        return fail("http_error");
    }

    eprintln!("[later] reclassify_item → {}", json);
    json
}

#[tauri::command]
async fn generate_title(text: String) -> String {
    eprintln!("[later] generate_title called, text len: {}", text.len());

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build() {
        Ok(c) => c,
        Err(e) => { eprintln!("[later] generate_title client build failed: {}", e); return String::new(); }
    };

    let body = serde_json::json!({ "text": text });
    let url = format!("{}/title", LATER_API_BASE);
    let res = match client
        .post(&url)
        .header("X-Later-Auth", LATER_API_KEY)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await {
        Ok(r) => r,
        Err(e) => { eprintln!("[later] generate_title request failed: {}", e); return String::new(); }
    };

    let status = res.status();
    let json: serde_json::Value = match res.json().await {
        Ok(j) => j,
        Err(e) => { eprintln!("[later] generate_title json parse failed (HTTP {}): {}", status, e); return String::new(); }
    };

    if !status.is_success() {
        eprintln!("[later] generate_title HTTP {} response: {}", status, json);
        return String::new();
    }

    let title = json["title"].as_str().unwrap_or("").trim().to_string();
    eprintln!("[later] generate_title → {:?}", title);
    title
}

#[tauri::command]
async fn submit_email(email: String) -> Result<(), String> {
    let email = email.trim().to_string();
    eprintln!("[later] submit_email called, len: {}", email.len());

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("client build failed: {}", e))?;

    let body = serde_json::json!({ "email": email });
    let url = format!("{}/subscribe", LATER_API_BASE);
    let res = client
        .post(&url)
        .header("X-Later-Auth", LATER_API_KEY)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("request failed: {}", e))?;

    let status = res.status();
    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        eprintln!("[later] submit_email HTTP {}: {}", status, text);
        return Err(format!("server returned {}", status));
    }
    eprintln!("[later] submit_email → ok");
    Ok(())
}

fn regex_find(text: &str, pattern: &str) -> Option<String> {
    let re = regex::Regex::new(pattern).ok()?;
    let caps = re.captures(text)?;
    Some(caps.get(1)?.as_str().trim().to_string())
}

#[tauri::command]
async fn hide_spotlight(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(SPOTLIGHT_LABEL) {
        let _ = window.hide();
    }
}

#[tauri::command]
async fn open_library(app: tauri::AppHandle) {
    show_or_open_library(&app);
}

// Schedule a one-time reminder for `link_id`. Any prior task for the same id
// is aborted (v1 rule: setting a new reminder replaces the old one — never
// stacks). If `remind_at_iso` is already in the past, the popup enqueues
// immediately, matching the "missed reminder" fallback for reminders that
// were scheduled before the app was quit.
#[tauri::command]
async fn schedule_reminder(
    app: tauri::AppHandle,
    link_id: String,
    title: String,
    remind_at_iso: String,
) -> Result<(), String> {
    // Parse the ISO datetime. Only a naive check — anything the worker's
    // parser produces conforms, and any user-picker output will too.
    let when = parse_iso_to_instant(&remind_at_iso)
        .ok_or_else(|| "invalid_iso".to_string())?;

    // Abort any existing task for this id.
    cancel_reminder_task(&link_id);

    let app_handle = app.clone();
    let title_for_task = title.clone();
    let id_for_task = link_id.clone();
    let iso_for_task = remind_at_iso.clone();
    let handle = tokio::spawn(async move {
        let now = std::time::Instant::now();
        if when > now {
            tokio::time::sleep(when - now).await;
        }
        // Timer fired: try to show the popup, or queue it if another is up.
        // The card doesn't steal focus and stays put until the user hits
        // Okay or View — hence the strict one-at-a-time invariant.
        show_or_enqueue(&app_handle, &id_for_task, &title_for_task, &iso_for_task);
        // Remove the completed task from the registry.
        let mut guard = REMINDER_TASKS.lock().unwrap();
        if let Some(map) = guard.as_mut() {
            map.remove(&id_for_task);
        }
    });

    let mut guard = REMINDER_TASKS.lock().unwrap();
    let map = guard.get_or_insert_with(HashMap::new);
    map.insert(link_id, handle);
    Ok(())
}

// Cancel a pending reminder for `link_id`. Aborts any tokio task, drops the
// entry from the queue, and closes the popup if it's currently showing.
// Safe to call even if nothing is active.
#[tauri::command]
async fn cancel_reminder(app: tauri::AppHandle, link_id: String) {
    cancel_reminder_task(&link_id);
    // Remove from queue if pending.
    {
        let mut guard = REMINDER_QUEUE.lock().unwrap();
        if let Some(state) = guard.as_mut() {
            state.queue.retain(|q| q.link_id != link_id);
        }
    }
    // If it's the one on screen, close the window and advance the queue.
    let is_current = {
        let guard = REMINDER_QUEUE.lock().unwrap();
        guard.as_ref().and_then(|s| s.current.as_ref()) == Some(&link_id)
    };
    if is_current {
        let label = reminder_label(&link_id);
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.close();
        }
        advance_queue(&app);
    }
}

fn cancel_reminder_task(link_id: &str) {
    let mut guard = REMINDER_TASKS.lock().unwrap();
    if let Some(map) = guard.as_mut() {
        if let Some(handle) = map.remove(link_id) {
            handle.abort();
        }
    }
}

// Timer-fire entry point. If nothing is currently on screen, this becomes the
// current popup and shows. Otherwise it joins the queue. Dedup: if link_id is
// already the current popup or already in the queue (e.g. two reschedules for
// the same item race the same tick), silently drop the new one — the existing
// entry wins.
fn show_or_enqueue(app: &tauri::AppHandle, link_id: &str, title: &str, remind_at_iso: &str) {
    let should_show_now = {
        let mut guard = REMINDER_QUEUE.lock().unwrap();
        let state = guard.get_or_insert_with(|| ReminderQueue { current: None, queue: Vec::new() });
        // Dedup against current + queue.
        if state.current.as_deref() == Some(link_id) { return; }
        if state.queue.iter().any(|q| q.link_id == link_id) { return; }
        if state.current.is_none() {
            state.current = Some(link_id.to_string());
            true
        } else {
            state.queue.push(QueuedReminder {
                link_id: link_id.to_string(),
                title: title.to_string(),
                remind_at_iso: remind_at_iso.to_string(),
            });
            false
        }
    };
    if should_show_now {
        show_reminder_window(app, link_id, title);
    }
}

// Called after a popup is dismissed (Okay / View / cancel). Picks the
// most-overdue queued reminder (earliest remind_at_iso) and shows it next.
// Leaves `current` empty if the queue is empty.
fn advance_queue(app: &tauri::AppHandle) {
    let next = {
        let mut guard = REMINDER_QUEUE.lock().unwrap();
        let Some(state) = guard.as_mut() else { return };
        state.current = None;
        if state.queue.is_empty() { return; }
        // Sort ascending by parsed remind_at (earliest first = most overdue).
        // Failure to parse sorts last so a bad entry doesn't block the good ones.
        state.queue.sort_by_key(|q| parse_iso_to_unix(&q.remind_at_iso).unwrap_or(i64::MAX));
        let picked = state.queue.remove(0);
        state.current = Some(picked.link_id.clone());
        Some(picked)
    };
    if let Some(q) = next {
        show_reminder_window(app, &q.link_id, &q.title);
    }
}

const REMINDER_WIDTH: f64 = 320.0;
const REMINDER_HEIGHT: f64 = 130.0;

// Build the label used for a reminder card window. One card per link id.
fn reminder_label(link_id: &str) -> String {
    // Window labels must be alphanumeric + underscore/hyphen. Link ids are
    // already in that shape ("link-1788923875363") so a straight concat works.
    format!("reminder_{}", link_id.replace('-', "_"))
}

// Percent-encode arbitrary text so it can safely ride in a URL query. Only
// alphanumerics and a few reserved chars pass through untouched.
fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

// Spawn the custom reminder card window in the top-right corner. Transparent,
// no chrome, doesn't steal focus. If a card for this link is already open we
// bring it forward instead of stacking a second one.
fn show_reminder_window(app: &tauri::AppHandle, link_id: &str, body_text: &str) {
    let label = reminder_label(link_id);
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.show();
        let _ = existing.set_always_on_top(true);
        return;
    }

    let url = format!(
        "reminder.html?id={}&text={}",
        url_encode(link_id),
        url_encode(body_text)
    );

    let build = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::App(url.into()),
    )
    .title("Later — Reminder")
    .inner_size(REMINDER_WIDTH, REMINDER_HEIGHT)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .skip_taskbar(true)
    .always_on_top(true)
    // Turn OFF the OS-drawn window shadow — otherwise macOS paints a
    // rectangular drop shadow around the entire webview, showing up as a
    // gray halo around our rounded card. We supply our own shadow via CSS.
    .shadow(false)
    // Don't steal focus from whatever the user was doing.
    .focused(false)
    .visible(false)
    .build();

    let window = match build {
        Ok(w) => w,
        Err(e) => { eprintln!("[later] show_reminder_window build failed: {}", e); return; }
    };

    // Position top-right after build so we can read the monitor size.
    if let Ok(Some(monitor)) = window.primary_monitor() {
        let scale = monitor.scale_factor();
        let screen_w = monitor.size().width as f64 / scale;
        // 20px right margin, 40px top margin (below the menu bar).
        let x = screen_w - REMINDER_WIDTH - 20.0;
        let y = 40.0;
        let _ = window.set_position(tauri::Position::Logical(
            tauri::LogicalPosition::new(x, y),
        ));
    }
    let _ = window.show();
}

// Close a reminder card. Called by the "Okay" button; also invoked by
// open_item_from_reminder before it switches focus to the vault. The popup
// itself persists acknowledged_at to localStorage before invoking this — we
// only handle window teardown and queue advancement here.
#[tauri::command]
async fn close_reminder_window(app: tauri::AppHandle, link_id: String) {
    let label = reminder_label(&link_id);
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.close();
    }
    advance_queue(&app);
}

// "View" button: open the main vault window, emit an event carrying the item
// id so the frontend can scroll to and highlight the item, and dismiss the
// reminder card. Acknowledgment persistence happens in the popup itself.
#[tauri::command]
async fn open_item_from_reminder(app: tauri::AppHandle, link_id: String) {
    show_or_open_library(&app);
    if let Err(e) = app.emit(REMINDER_VIEW_EVENT, &link_id) {
        eprintln!("[later] emit reminder-view-requested failed: {}", e);
    }
    let label = reminder_label(&link_id);
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.close();
    }
    advance_queue(&app);
}

// Parse ISO 8601 into UNIX seconds. Used to compare/sort remind_at values
// across timezones — the queue picks the smallest (earliest = most overdue).
fn parse_iso_to_unix(iso: &str) -> Option<i64> {
    let bytes = iso.as_bytes();
    if bytes.len() < 19 { return None; }
    let year: i64 = iso.get(0..4)?.parse().ok()?;
    let month: u32 = iso.get(5..7)?.parse().ok()?;
    let day: u32 = iso.get(8..10)?.parse().ok()?;
    let hour: u32 = iso.get(11..13)?.parse().ok()?;
    let minute: u32 = iso.get(14..16)?.parse().ok()?;
    let second: u32 = iso.get(17..19)?.parse().ok()?;

    let mut offset_seconds: i64 = 0;
    let rest = &iso[19..];
    let after_frac = if let Some(dot_pos) = rest.find('.') {
        let after_dot = &rest[dot_pos + 1..];
        let end = after_dot.chars().take_while(|c| c.is_ascii_digit()).count();
        &rest[dot_pos + 1 + end..]
    } else {
        rest
    };
    if let Some(first) = after_frac.chars().next() {
        if first == 'Z' {
            offset_seconds = 0;
        } else if first == '+' || first == '-' {
            let sign: i64 = if first == '+' { 1 } else { -1 };
            let rest_off = &after_frac[1..];
            let oh: i64 = rest_off.get(0..2)?.parse().ok()?;
            let om: i64 = rest_off.get(3..5).and_then(|s| s.parse().ok()).unwrap_or(0);
            offset_seconds = sign * (oh * 3600 + om * 60);
        }
    }

    // days-from-civil (Howard Hinnant).
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let m = month as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy as u64;
    let days_from_epoch = era * 146097 + doe as i64 - 719468;
    Some(days_from_epoch * 86400
        + (hour as i64) * 3600
        + (minute as i64) * 60
        + second as i64
        - offset_seconds)
}

// Convert an ISO 8601 timestamp string to a tokio Instant relative to now.
// We're deliberately not pulling in `chrono` — parse_iso_to_unix handles the
// calendar math; we just translate the delta into an Instant here.
// Formats accepted: 2026-09-09T09:00:00[.fff][Z|+hh:mm|-hh:mm]
fn parse_iso_to_instant(iso: &str) -> Option<std::time::Instant> {
    let target_unix = parse_iso_to_unix(iso)?;
    let now_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs() as i64;
    let now_instant = std::time::Instant::now();
    if target_unix <= now_unix {
        // Past — return "now" so the task fires immediately.
        Some(now_instant)
    } else {
        let delta = target_unix - now_unix;
        Some(now_instant + std::time::Duration::from_secs(delta as u64))
    }
}

// Shared implementation used by both the `open_library` Tauri command (called
// from JS) and the tray-icon click handler (Rust-only path). Extracted so
// both entry points give identical behaviour: focus the existing window if
// present, otherwise build a new one and switch the app to Regular activation
// policy so the Dock icon appears.
fn show_or_open_library(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(LIBRARY_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        #[cfg(target_os = "macos")]
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
        return;
    }
    let window = WebviewWindowBuilder::new(
        app,
        LIBRARY_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("Later — Vault")
    .inner_size(1100.0, 720.0)
    .min_inner_size(700.0, 500.0)
    .resizable(true)
    .visible(true)
    .decorations(true)
    .build();

    if let Ok(win) = window {
        let app_handle = app.clone();
        win.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                #[cfg(target_os = "macos")]
                let _ = app_handle.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
        });
        #[cfg(target_os = "macos")]
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    }
}

#[allow(dead_code)]  // Popup path is retired — tray now opens the main window directly.
fn toggle_popup(app: &tauri::AppHandle, position: Option<(f64, f64)>) {
    if let Some(window) = app.get_webview_window(POPUP_LABEL) {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            if let Some((px, py)) = position {
                let x = (px / 2.0) - (POPUP_WIDTH / 2.0);
                let y = (py / 2.0) + 20.0;
                let _ = window.set_position(tauri::Position::Logical(
                    tauri::LogicalPosition::new(x, y),
                ));
            }
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

#[allow(dead_code)]  // Popup path is retired — first-launch now opens the main window directly.
fn show_popup_centered(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(POPUP_LABEL) {
        if let Ok(Some(monitor)) = window.primary_monitor() {
            let screen_size = monitor.size();
            let scale = monitor.scale_factor();
            let screen_w = screen_size.width as f64 / scale;
            let screen_h = screen_size.height as f64 / scale;
            let x = (screen_w - POPUP_WIDTH) / 2.0;
            let y = (screen_h - POPUP_HEIGHT) / 2.0 - 60.0;
            let _ = window.set_position(tauri::Position::Logical(
                tauri::LogicalPosition::new(x, y),
            ));
        } else {
            eprintln!("[later] show_popup_centered: primary_monitor failed, showing at default position");
        }
        let show_res = window.show();
        let focus_res = window.set_focus();
        eprintln!("[later] show_popup_centered: show={:?} focus={:?}", show_res.is_ok(), focus_res.is_ok());
    } else {
        eprintln!("[later] show_popup_centered: popup window not found");
    }
}

fn first_launch_marker_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    match app.path().app_config_dir() {
        Ok(d) => Some(d.join("first_launch_done")),
        Err(e) => {
            eprintln!("[later] app_config_dir failed: {}", e);
            None
        }
    }
}

// Called from React once the user submits or skips the onboarding overlay.
// Writes the marker (so subsequent launches skip auto-open) and re-enables
// the blur-hide handler (so the popup dismisses normally from now on).
#[tauri::command]
async fn finalize_first_launch(app: tauri::AppHandle) {
    if let Some(marker) = first_launch_marker_path(&app) {
        if let Some(parent) = marker.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match std::fs::write(&marker, b"1") {
            Ok(_) => eprintln!("[later] finalize_first_launch: marker written at {:?}", marker),
            Err(e) => eprintln!("[later] finalize_first_launch: marker write failed: {}", e),
        }
    }
    HIDE_POPUP_ON_BLUR.store(true, Ordering::Relaxed);
}

fn toggle_spotlight(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(SPOTLIGHT_LABEL) {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            if let Ok(Some(monitor)) = window.primary_monitor() {
                let screen_size = monitor.size();
                let scale = monitor.scale_factor();
                let screen_w = screen_size.width as f64 / scale;
                let screen_h = screen_size.height as f64 / scale;
                let x = (screen_w - SPOTLIGHT_WIDTH) / 2.0;
                let y = (screen_h - SPOTLIGHT_HEIGHT) / 2.0 - 100.0;
                let _ = window.set_position(tauri::Position::Logical(
                    tauri::LogicalPosition::new(x, y),
                ));
            }
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![fetch_title, classify_item, reclassify_item, generate_title, open_library, hide_spotlight, submit_email, finalize_first_launch, schedule_reminder, cancel_reminder, close_reminder_window, open_item_from_reminder])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Popup window — loads popup.html
            let _popup = WebviewWindowBuilder::new(
                app,
                POPUP_LABEL,
                WebviewUrl::App("popup.html".into()),
            )
            .title("Later")
            .inner_size(POPUP_WIDTH, POPUP_HEIGHT)
            .resizable(false)
            .visible(false)
            .decorations(false)
            .skip_taskbar(true)
            .always_on_top(true)
            .build()?;

            // Spotlight window — loads index.html
            let _spotlight = WebviewWindowBuilder::new(
                app,
                SPOTLIGHT_LABEL,
                WebviewUrl::default(),
            )
            .title("Later — Quick Save")
            .inner_size(SPOTLIGHT_WIDTH, SPOTLIGHT_HEIGHT)
            .resizable(false)
            .visible(false)
            .decorations(false)
            .skip_taskbar(true)
            .always_on_top(true)
            .build()?;

            // Hide spotlight on blur
            if let Some(w) = app.get_webview_window(SPOTLIGHT_LABEL) {
                let w2 = w.clone();
                w.on_window_event(move |event| {
                    if let tauri::WindowEvent::Focused(false) = event {
                        let _ = w2.hide();
                    }
                });
            }

            // Hide popup on blur — but only when HIDE_POPUP_ON_BLUR is true.
            // During first-launch onboarding it's flipped false so the popup
            // stays open through startup focus turbulence and user click-away.
            if let Some(w) = app.get_webview_window(POPUP_LABEL) {
                let w2 = w.clone();
                w.on_window_event(move |event| {
                    if let tauri::WindowEvent::Focused(false) = event {
                        if HIDE_POPUP_ON_BLUR.load(Ordering::Relaxed) {
                            let _ = w2.hide();
                        }
                    }
                });
            }

            // Cmd+K → spotlight (globally registered; fires from any app).
            let shortcut = Shortcut::new(
                Some(Modifiers::SUPER),
                Code::KeyK,
            );
            let app_handle = app.handle().clone();
            app.global_shortcut().on_shortcut(shortcut, move |_app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    toggle_spotlight(&app_handle);
                }
            })?;

            // Tray click → open the main library window. Previously this opened
            // a small tray popup; now we skip the popup entirely and jump
            // straight to the full vault view (matches user's expectation that
            // clicking the icon = "open the app").
            let tray_icon = tauri::image::Image::from_bytes(
                include_bytes!("../icons/tray-icon.png"),
            )
            .expect("embedded tray-icon.png must decode");

            // Right-click / Control-click menu. Structure follows the standard
            // menu-bar-app pattern (Granola, Rectangle, Cleanshot, etc.):
            // primary action first, then app-open, separator, quit at the
            // bottom with its standard Cmd+Q accelerator.
            let add_item = MenuItem::with_id(
                app,
                "menu_add_item",
                "Add item",
                true,
                Some("Cmd+K"),
            )?;
            let open_vault = MenuItem::with_id(
                app,
                "menu_open_vault",
                "Open vault",
                true,
                None::<&str>,
            )?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(
                app,
                "menu_quit",
                "Quit Later",
                true,
                Some("Cmd+Q"),
            )?;
            let tray_menu = Menu::with_items(app, &[
                &add_item,
                &open_vault,
                &separator,
                &quit,
            ])?;

            let _tray = TrayIconBuilder::new()
                .icon(tray_icon)
                .icon_as_template(true)
                .tooltip("Later — Click to open vault · ⌘K for quick save · right-click for menu")
                .menu(&tray_menu)
                // macOS default with a menu attached is to also show the menu
                // on left-click. Disabling that so left-click keeps its
                // existing behavior (open vault) — right-click is the only
                // path to the menu, matching the additive spirit of the ask.
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "menu_add_item" => toggle_spotlight(app),
                        "menu_open_vault" => show_or_open_library(app),
                        "menu_quit" => app.exit(0),
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    match event {
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } => {
                            let app = tray.app_handle();
                            show_or_open_library(app);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            // First-launch auto-open. If the marker is missing we (a) suppress
            // blur-hide so the popup can't be clobbered by startup focus
            // shuffles or user click-away during onboarding, and (b) spawn a
            // background thread that waits half a second (letting the app
            // fully finish launching) then shows the popup centered. Marker
            // itself is only written when React calls `finalize_first_launch`
            // — that way a force-quit mid-onboarding leaves the flow ready to
            // retry on the next launch.
            let marker_present = first_launch_marker_path(&app.handle())
                .map(|p| p.exists())
                .unwrap_or(true);
            let replay_onboarding = cfg!(debug_assertions)
                && std::env::var("VITE_FORCE_ONBOARDING").as_deref() == Ok("1");
            if !marker_present || replay_onboarding {
                eprintln!("[later] onboarding launch — will auto-open library");
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    show_or_open_library(&handle);
                });
            } else {
                eprintln!("[later] first-launch marker present — normal launch");
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Later");
}