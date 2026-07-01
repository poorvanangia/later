use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const POPUP_LABEL: &str = "popup";
const SPOTLIGHT_LABEL: &str = "main";
const LIBRARY_LABEL: &str = "library";
const POPUP_WIDTH: f64 = 400.0;
const POPUP_HEIGHT: f64 = 520.0;
const SPOTLIGHT_WIDTH: f64 = 620.0;
const SPOTLIGHT_HEIGHT: f64 = 64.0;

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

#[tauri::command]
async fn classify_item(text: String, existing_categories: Option<Vec<String>>) -> String {
    eprintln!("[later] classify_item called, text len: {}", text.len());
    let api_key = match std::env::var("ANTHROPIC_API_KEY") {
        Ok(k) => k,
        Err(_) => {
            eprintln!("[later] classify_item: ANTHROPIC_API_KEY not set in environment");
            return String::new();
        }
    };

    if api_key.is_empty() {
        eprintln!("[later] classify_item: API key is empty");
        return String::new();
    }

    let categories = existing_categories.unwrap_or_default();
    let existing_block = if categories.is_empty() {
        "The user has no categories yet — invent the right one.".to_string()
    } else {
        format!("The user's existing categories:\n{}", categories.iter().map(|c| format!("- {}", c)).collect::<Vec<_>>().join("\n"))
    };

    let prompt = format!(
        r#"You are categorising a single item in a personal save-for-later app. Pick the most precise category that fits.

{existing_block}

Rules:
- If one of the user's existing categories fits well, return it EXACTLY as written (including any "Parent - Subcategory" formatting).
- Otherwise invent a new category. Prefer a single word ("Cooking", "Travel"). Use "Parent - Subcategory" ONLY when the parent already exists or when the subcategory genuinely sharpens meaning — never force a subcategory.
- NEVER reply "Other", "Misc", "Uncategorised", or anything generic. Always make a specific judgement based on intent.
- Reply with ONLY the category name. No quotes, no punctuation, no explanation.

Examples:
"Interview Jane Tuesday at 3pm" → Work - Hiring
"Fill the compliance form" → Work - Ops
"Buy suitcases" → Shopping - Travel
"Get milk on the way home" → Shopping - Groceries
"Council tax bill due Friday" → Finance - Bills
"Watch Succession S3" → Entertainment
"Recipe: miso aubergine" → Cooking
"Article on Rust async" → Research

Item: {text}"#,
        existing_block = existing_block,
        text = text,
    );

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build() {
        Ok(c) => c,
        Err(e) => { eprintln!("[later] classify_item client build failed: {}", e); return String::new(); }
    };

    let body = serde_json::json!({
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 30,
        "messages": [{"role": "user", "content": prompt}]
    });

    let res = match client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", &api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await {
        Ok(r) => r,
        Err(e) => { eprintln!("[later] classify_item request failed: {}", e); return String::new(); }
    };

    let status = res.status();
    let json: serde_json::Value = match res.json().await {
        Ok(j) => j,
        Err(e) => { eprintln!("[later] classify_item json parse failed (HTTP {}): {}", status, e); return String::new(); }
    };

    if !status.is_success() {
        eprintln!("[later] classify_item HTTP {} response: {}", status, json);
        return String::new();
    }

    let category = json["content"][0]["text"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();
    eprintln!("[later] classify_item → {:?}", category);
    category
}

#[tauri::command]
async fn generate_title(text: String) -> String {
    eprintln!("[later] generate_title called, text len: {}", text.len());
    let api_key = match std::env::var("ANTHROPIC_API_KEY") {
        Ok(k) => k,
        Err(_) => {
            eprintln!("[later] generate_title: ANTHROPIC_API_KEY not set in environment");
            return String::new();
        }
    };

    if api_key.is_empty() {
        eprintln!("[later] generate_title: API key is empty");
        return String::new();
    }

    let prompt = format!(
        r#"Summarize the following note as a short title (max 10 words, no quotes, no trailing punctuation). Reply with ONLY the title.

Note: {}"#,
        text
    );

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build() {
        Ok(c) => c,
        Err(e) => { eprintln!("[later] generate_title client build failed: {}", e); return String::new(); }
    };

    let body = serde_json::json!({
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 40,
        "messages": [{"role": "user", "content": prompt}]
    });

    let res = match client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", &api_key)
        .header("anthropic-version", "2023-06-01")
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

    let title = json["content"][0]["text"]
        .as_str()
        .unwrap_or("")
        .trim()
        .trim_matches('"')
        .to_string();
    eprintln!("[later] generate_title → {:?}", title);
    title
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
    if let Some(window) = app.get_webview_window(LIBRARY_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
        #[cfg(target_os = "macos")]
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    } else {
        let window = WebviewWindowBuilder::new(
            &app,
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
}

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
        .invoke_handler(tauri::generate_handler![fetch_title, classify_item, generate_title, open_library, hide_spotlight])
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

            // Hide popup on blur
            if let Some(w) = app.get_webview_window(POPUP_LABEL) {
                let w2 = w.clone();
                w.on_window_event(move |event| {
                    if let tauri::WindowEvent::Focused(false) = event {
                        let _ = w2.hide();
                    }
                });
            }

            // Cmd+Shift+L → spotlight
            let shortcut = Shortcut::new(
                Some(Modifiers::SUPER | Modifiers::SHIFT),
                Code::KeyL,
            );
            let app_handle = app.handle().clone();
            app.global_shortcut().on_shortcut(shortcut, move |_app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    toggle_spotlight(&app_handle);
                }
            })?;

            // Tray click → popup. Use a dedicated tray icon (just the bookmark glyph
            // on a transparent canvas) so macOS template rendering shows the glyph
            // alone — the app icon includes the white rounded-square frame, which
            // would draw as a solid square in the menu bar.
            let tray_icon = tauri::image::Image::from_bytes(
                include_bytes!("../icons/tray-icon.png"),
            )
            .expect("embedded tray-icon.png must decode");

            let _tray = TrayIconBuilder::new()
                .icon(tray_icon)
                .icon_as_template(true)
                .tooltip("Later — Click for recent · ⌘⇧L for quick save")
                .on_tray_icon_event(|tray, event| {
                    match event {
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            position,
                            ..
                        } => {
                            let app = tray.app_handle();
                            toggle_popup(app, Some((position.x, position.y)));
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Later");
}