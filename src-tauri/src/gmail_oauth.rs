// Gmail OAuth 2.0 with PKCE — desktop-app flow, loopback redirect.
//
// Steps (from user's perspective, one click):
//   1. User clicks "Connect Gmail" in Settings.
//   2. We generate a code_verifier (random) + code_challenge (SHA-256 of it).
//   3. We bind a TCP listener on 127.0.0.1:<random-free-port>.
//   4. We open the default browser to Google's authorize URL with our
//      redirect_uri pointing back at that loopback port.
//   5. User approves in Google. Google redirects the browser to
//      http://127.0.0.1:PORT/?code=X&state=Y.
//   6. Our loopback listener accepts the connection, parses code + state,
//      sends back a small HTML "you can close this tab" page, and closes.
//   7. We POST {code, code_verifier, redirect_uri} to the Later worker's
//      /gmail/exchange endpoint. The worker holds the client_secret and does
//      the actual token exchange with Google, returning refresh + access
//      tokens + the connected user's email.
//   8. We stash the refresh_token in the macOS Keychain; return the email
//      to the frontend so Settings can display "Connected as x@y".
//
// Explicitly out of scope here: token refresh (Phase C, when we start
// polling Gmail); the frontend UI.

use base64::Engine;
use rand::RngCore;
use sha2::Digest;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

use crate::gmail_config::{
    is_configured, GMAIL_CLIENT_ID, GMAIL_SCOPES, KEYCHAIN_ACCOUNT_REFRESH, KEYCHAIN_SERVICE,
};

const LATER_API_BASE: &str = "https://later-api.poorvanangia03.workers.dev";
const LATER_API_KEY: &str = "c98175fec0af0ae02de9795fc7361132957c4163ceb3b403480c28dc5dc1e5b3";

// Max time we're willing to wait for the user to come back from Google. If
// they wander off, we release the port and error out cleanly rather than
// leaving a listener open forever.
const LOOPBACK_TIMEOUT: Duration = Duration::from_secs(300);

// Result returned to the frontend on successful connect.
#[derive(serde::Serialize)]
pub struct ConnectOk {
    pub email: Option<String>,
}

// Every failure path funnels through the same error surface so the frontend
// can render a single "connect_error" state with a specific detail string.
// Reasons kept short + machine-parseable so the UI can key off them if we
// want per-reason messaging later.
#[derive(serde::Serialize, Debug)]
pub struct ConnectError {
    pub reason: String,
    pub detail: String,
}

impl ConnectError {
    fn new(reason: &str, detail: impl Into<String>) -> Self {
        Self { reason: reason.to_string(), detail: detail.into() }
    }
}

// Entry point. Kicks off the whole flow synchronously (blocks the invoking
// task while waiting for the browser round-trip). Called from a Tauri
// command that's already async, so blocking here just parks the future.
pub async fn run_connect_flow() -> Result<ConnectOk, ConnectError> {
    if !is_configured() {
        return Err(ConnectError::new(
            "not_configured",
            "GMAIL_CLIENT_ID is not set in src-tauri/src/gmail_config.rs. Paste your Google OAuth Client ID there and rebuild.",
        ));
    }

    // Bind loopback FIRST — we need the assigned port for the redirect_uri
    // that goes into the auth URL. Port 0 asks the OS for any free port.
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| ConnectError::new("bind_failed", format!("could not bind loopback: {}", e)))?;
    listener.set_nonblocking(true).ok();
    let port = listener
        .local_addr()
        .map_err(|e| ConnectError::new("bind_failed", format!("no local addr: {}", e)))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{}", port);

    // PKCE: random verifier (43-128 chars, unreserved), challenge = SHA256(verifier)
    // base64url-encoded (Google requires S256).
    let verifier = generate_pkce_verifier();
    let challenge = pkce_challenge_s256(&verifier);
    let state = generate_state();

    // Build Google's authorize URL. `prompt=consent` + `access_type=offline`
    // are what get us a refresh_token — Google withholds it on subsequent
    // grants unless we explicitly ask again.
    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&code_challenge={}&code_challenge_method=S256&state={}&access_type=offline&prompt=consent",
        urlencoded(GMAIL_CLIENT_ID),
        urlencoded(&redirect_uri),
        urlencoded(GMAIL_SCOPES),
        urlencoded(&challenge),
        urlencoded(&state),
    );

    // Launch the browser. On macOS, `open` is always available.
    open_url(&auth_url)
        .map_err(|e| ConnectError::new("browser_open_failed", format!("could not open browser: {}", e)))?;

    // Wait for the redirect to hit our loopback.
    let (code, returned_state) = wait_for_callback(&listener)?;
    if returned_state != state {
        return Err(ConnectError::new(
            "state_mismatch",
            "OAuth state parameter mismatch — possible CSRF, aborted",
        ));
    }

    // Ship to worker for token exchange (worker holds client_secret).
    let tokens = exchange_code(&code, &verifier, &redirect_uri).await?;

    // Store refresh_token in Keychain. This is the only long-lived credential
    // we hold — access_tokens are worker-side, minted per sync from the
    // refresh_token we send along.
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_REFRESH)
        .and_then(|entry| entry.set_password(&tokens.refresh_token))
        .map_err(|e| ConnectError::new("keychain_write_failed", format!("could not save token to Keychain: {}", e)))?;

    Ok(ConnectOk { email: tokens.email })
}

pub fn disconnect() -> Result<(), ConnectError> {
    // Delete may fail with NoEntry if there was nothing there — treat that
    // as a no-op success so the button can always be pressed safely.
    match keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_REFRESH) {
        Ok(entry) => match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(ConnectError::new("keychain_delete_failed", e.to_string())),
        },
        Err(e) => Err(ConnectError::new("keychain_open_failed", e.to_string())),
    }
}

pub fn is_connected() -> bool {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_REFRESH)
        .and_then(|entry| entry.get_password())
        .is_ok()
}

// ---------- helpers ----------

#[derive(serde::Deserialize)]
struct ExchangeResponse {
    refresh_token: String,
    #[allow(dead_code)]
    access_token: String,
    #[allow(dead_code)]
    expires_in: Option<u32>,
    email: Option<String>,
}

async fn exchange_code(
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Result<ExchangeResponse, ConnectError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| ConnectError::new("http_client_build_failed", e.to_string()))?;

    let body = serde_json::json!({
        "code": code,
        "code_verifier": code_verifier,
        "redirect_uri": redirect_uri,
    });

    let res = client
        .post(format!("{}/gmail/exchange", LATER_API_BASE))
        .header("X-Later-Auth", LATER_API_KEY)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| ConnectError::new("exchange_request_failed", e.to_string()))?;

    let status = res.status();
    let text = res.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(ConnectError::new(
            "exchange_http_error",
            format!("worker returned {}: {}", status.as_u16(), text),
        ));
    }
    serde_json::from_str::<ExchangeResponse>(&text)
        .map_err(|e| ConnectError::new("exchange_parse_failed", format!("bad JSON from worker: {} — body was: {}", e, text)))
}

// Poll the (non-blocking) listener for the redirect. We keep the loop tight
// (10ms sleep) so the user's return feels instant. Timeout returns an error
// so the port isn't held forever.
fn wait_for_callback(listener: &TcpListener) -> Result<(String, String), ConnectError> {
    let started = Instant::now();
    loop {
        if started.elapsed() > LOOPBACK_TIMEOUT {
            return Err(ConnectError::new(
                "timed_out",
                "no callback received within 5 minutes",
            ));
        }
        match listener.accept() {
            Ok((mut stream, _addr)) => {
                stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).map_err(|e| {
                    ConnectError::new("loopback_read_failed", e.to_string())
                })?;
                let req = std::str::from_utf8(&buf[..n]).unwrap_or("");
                // First line looks like: `GET /?code=X&state=Y HTTP/1.1`.
                let path_and_query = req
                    .split_whitespace()
                    .nth(1)
                    .ok_or_else(|| ConnectError::new("loopback_bad_request", "no request line"))?;
                // Send a friendly HTML response before closing so the user
                // doesn't stare at "unable to connect" on the browser tab.
                let resp = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n<!doctype html><html><head><title>Later — Connected</title><meta charset=utf-8><style>body{background:#fafaf9;color:#1a1a1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}div{text-align:center}h1{font-size:20px;margin:0 0 6px;font-weight:600}p{font-size:13px;color:#888;margin:0}</style></head><body><div><h1>Connected.</h1><p>You can close this tab and return to Later.</p></div></body></html>";
                stream.write_all(resp.as_bytes()).ok();
                stream.flush().ok();
                // Parse code + state from the query string.
                let (code, state) = parse_code_and_state(path_and_query).ok_or_else(|| {
                    ConnectError::new(
                        "loopback_missing_params",
                        format!("callback URL missing code/state: {}", path_and_query),
                    )
                })?;
                return Ok((code, state));
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(10));
                continue;
            }
            Err(e) => {
                return Err(ConnectError::new("loopback_accept_failed", e.to_string()));
            }
        }
    }
}

fn parse_code_and_state(path_and_query: &str) -> Option<(String, String)> {
    // Strip fragment / path, keep only the ?-body.
    let q = path_and_query.split('?').nth(1)?;
    // Strip anything after the query terminator (fragment, whitespace, etc).
    let q = q.split(&[' ', '#'][..]).next().unwrap_or(q);
    let mut code = None;
    let mut state = None;
    for pair in q.split('&') {
        let mut it = pair.splitn(2, '=');
        let k = it.next().unwrap_or("");
        let v = it.next().unwrap_or("");
        match k {
            "code" => code = Some(url_decode(v)),
            "state" => state = Some(url_decode(v)),
            "error" => {
                // Google can bounce here with e.g. error=access_denied; surface it.
                // We still return None so the caller reports missing_params —
                // simpler than plumbing a separate error variant just for
                // one browser-side rejection.
                eprintln!("[gmail_oauth] callback carried error: {}", url_decode(v));
                return None;
            }
            _ => {}
        }
    }
    match (code, state) { (Some(c), Some(s)) => Some((c, s)), _ => None }
}

fn url_decode(s: &str) -> String {
    // Small hand-rolled decoder — only unwraps %xx and '+' to space. Enough
    // for OAuth query params (code + state don't contain UTF-8 needing more).
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'+' { out.push(' '); i += 1; continue; }
        if b == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("00"), 16) {
                out.push(v as char);
                i += 3;
                continue;
            }
        }
        out.push(b as char);
        i += 1;
    }
    out
}

fn urlencoded(s: &str) -> String {
    // Same character set as the reminder-window encoder — safe unreserved
    // set only, percent-encode everything else.
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn generate_pkce_verifier() -> String {
    // 32 random bytes → base64url → 43 chars, well within Google's 43-128 range.
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

fn pkce_challenge_s256(verifier: &str) -> String {
    let mut hasher = sha2::Sha256::new();
    hasher.update(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hasher.finalize())
}

fn generate_state() -> String {
    let mut buf = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut buf);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

#[cfg(target_os = "macos")]
fn open_url(url: &str) -> std::io::Result<()> {
    std::process::Command::new("open").arg(url).spawn().map(|_| ())
}

#[cfg(not(target_os = "macos"))]
fn open_url(_url: &str) -> std::io::Result<()> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "browser open only implemented for macOS"))
}
