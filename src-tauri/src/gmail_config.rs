// Gmail OAuth config.
//
// The client_id is the public identifier for our OAuth 2.0 Desktop app,
// registered in Google Cloud Console. It's not really a secret — the same
// value will end up in the wrangler worker anyway — but keeping it in one
// well-labelled spot means rotating it is a one-file change.
//
// The worker side ALSO needs both GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET
// present as wrangler secrets — /gmail/exchange returns `gmail_not_configured`
// if either is missing.
//
// If GMAIL_CLIENT_ID here is left as a placeholder, `connect_gmail` refuses
// to start the OAuth flow and returns a "not_configured" error — the UI
// displays a hint pointing at this file so a partial setup is loud not silent.

pub const GMAIL_CLIENT_ID: &str = "346082819699-a3gmimgdr8eid2ga6u898m8nevua44rc.apps.googleusercontent.com";

// Scope covers read-only inbox access + the openid+email pair we use to
// identify which account the user connected. No send, no modify.
pub const GMAIL_SCOPES: &str = "https://www.googleapis.com/auth/gmail.readonly openid email";

// macOS Keychain identifiers. Keeping these as constants means a `security`
// CLI user can locate them easily and we can't accidentally drift the
// service string between set/get/delete call sites.
pub const KEYCHAIN_SERVICE: &str = "com.later.app.gmail";
pub const KEYCHAIN_ACCOUNT_REFRESH: &str = "refresh_token";

pub fn is_configured() -> bool {
    GMAIL_CLIENT_ID != "REPLACE_WITH_YOUR_GMAIL_CLIENT_ID" && !GMAIL_CLIENT_ID.is_empty()
}
