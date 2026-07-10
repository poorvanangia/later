use std::sync::atomic::{AtomicBool, Ordering};
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

#[tauri::command]
async fn classify_item(text: String, existing_categories: Option<Vec<String>>) -> String {
    eprintln!("[later] classify_item called, text len: {}", text.len());

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build() {
        Ok(c) => c,
        Err(e) => { eprintln!("[later] classify_item client build failed: {}", e); return String::new(); }
    };

    let body = serde_json::json!({
        "text": text,
        "existing_categories": existing_categories.unwrap_or_default(),
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

    let category = json["category"].as_str().unwrap_or("").trim().to_string();
    eprintln!("[later] classify_item → {:?}", category);
    category
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
        .invoke_handler(tauri::generate_handler![fetch_title, classify_item, generate_title, open_library, hide_spotlight, submit_email, finalize_first_launch])
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
            if !marker_present {
                eprintln!("[later] first-launch marker missing — will auto-open popup");
                HIDE_POPUP_ON_BLUR.store(false, Ordering::Relaxed);
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    show_popup_centered(&handle);
                });
            } else {
                eprintln!("[later] first-launch marker present — normal launch");
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Later");
}