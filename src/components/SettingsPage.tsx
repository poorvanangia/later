// Settings page — currently home to just the Gmail connection.
//
// Connection lives in two places:
//   - macOS Keychain (Rust side): the refresh_token. Never crosses to JS.
//   - localStorage (JS side):     later:gmail_connected_email (for display),
//                                 later:gmail_history_id + later:gmail_last_synced_at
//                                 (via lib/openloops)
// The Rust `gmail_connection_status` command is authoritative for whether
// we're connected — we cross-check localStorage against it on mount so a
// stale-looking "Connected as X" doesn't linger after a keychain wipe.

import { useEffect, useState } from 'react'
import { formatSyncedAgo, loadLastSyncedAt } from '../lib/openloops'
import { pollOnce } from '../lib/gmailSync'

const CREAM = '#fafaf9'
const TEXT = '#1a1a1a'
const MUTED = '#888'
const ACCENT = '#2d8a4e'
const CARD_BG = '#fff'
const CARD_BORDER = '#e8e8e4'

interface ConnectResult { ok: boolean; error?: string; email?: string | null }
interface ConnectionStatus { connected: boolean; configured: boolean }

// Real Tauri invoke. Returns { email } on success. Rust surfaces any failure
// as a serialized ConnectError with a `reason` slug + human-readable detail;
// we surface `detail` in the UI banner.
async function connectGmail(): Promise<ConnectResult> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const res = await invoke<{ email: string | null }>('connect_gmail')
    return { ok: true, email: res.email }
  } catch (err) {
    // Tauri serializes ConnectError as a plain object under `err`; sometimes
    // it's a bare string (e.g. panic). Handle both.
    const msg = extractErrorMessage(err)
    return { ok: false, error: msg }
  }
}

async function disconnectGmail(): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('disconnect_gmail')
  } catch (err) {
    console.error('[settings] disconnect_gmail failed', err)
  }
  localStorage.removeItem('later:gmail_connected_email')
  localStorage.removeItem('later:gmail_history_id')
  localStorage.removeItem('later:gmail_last_synced_at')
  try {
    const { emit } = await import('@tauri-apps/api/event')
    await emit('later://state-changed')
  } catch { /* not in Tauri */ }
}

async function loadStatus(): Promise<ConnectionStatus> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<ConnectionStatus>('gmail_connection_status')
  } catch {
    return { connected: false, configured: false }
  }
}

function extractErrorMessage(err: unknown): string {
  if (typeof err === 'string') return err
  if (err && typeof err === 'object') {
    const e = err as { detail?: string; reason?: string; message?: string }
    if (e.detail) return e.reason ? `${e.reason}: ${e.detail}` : e.detail
    if (e.message) return e.message
  }
  return 'Unknown error connecting to Gmail'
}

export function SettingsPage() {
  const [connectedEmail, setConnectedEmail] = useState<string | null>(() =>
    localStorage.getItem('later:gmail_connected_email')
  )
  const [lastSynced, setLastSynced] = useState<string | null>(loadLastSyncedAt)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // `configured` is false when the Rust-side gmail_config.rs still has the
  // placeholder client_id. Surface a distinct message rather than letting
  // the user click Connect and get a cryptic Google error.
  const [configured, setConfigured] = useState(true)

  // Reconcile Rust-owned Keychain state with cached JS state on mount, then
  // stay in sync via the app's broadcast event. If Keychain says "no token"
  // but localStorage remembers an email, we drop the cache — this handles
  // the case where the user ran `security delete-generic-password` from the
  // CLI, or the app was reinstalled.
  useEffect(() => {
    const refresh = () => {
      setConnectedEmail(localStorage.getItem('later:gmail_connected_email'))
      setLastSynced(loadLastSyncedAt())
    }
    ;(async () => {
      const s = await loadStatus()
      setConfigured(s.configured)
      if (!s.connected) {
        localStorage.removeItem('later:gmail_connected_email')
        setConnectedEmail(null)
      }
    })()
    let unlisten: (() => void) | undefined
    ;(async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        unlisten = await listen('later://state-changed', refresh)
      } catch { }
    })()
    window.addEventListener('storage', refresh)
    return () => {
      if (unlisten) unlisten()
      window.removeEventListener('storage', refresh)
    }
  }, [])

  const onConnect = async () => {
    setConnecting(true)
    setError(null)
    const res = await connectGmail()
    setConnecting(false)
    if (res.ok) {
      // Some flows return a null email (id_token decode failed on the worker
      // side). Fall back to a generic marker so we still register "connected".
      const email = res.email ?? 'Gmail account'
      localStorage.setItem('later:gmail_connected_email', email)
      setConnectedEmail(email)
    } else if (res.error) {
      setError(res.error)
    }
  }

  const onDisconnect = async () => {
    await disconnectGmail()
    setConnectedEmail(null)
    setLastSynced(null)
  }

  // "Sync now" — manual trigger for the poll, so we don't have to wait 20 min
  // to see the extractor's output. Also updates lastSynced in place.
  const [syncing, setSyncing] = useState(false)
  const [syncSummary, setSyncSummary] = useState<string | null>(null)
  const onSyncNow = async () => {
    setSyncing(true); setSyncSummary(null)
    const outcome = await pollOnce()
    setSyncing(false)
    setLastSynced(loadLastSyncedAt())
    if (!outcome.ok) {
      setSyncSummary(`Sync failed: ${outcome.reason ?? 'unknown'}`)
    } else {
      setSyncSummary(`Fetched ${outcome.messages_fetched}, extracted ${outcome.extracted}`)
    }
  }

  return (
    <div style={{ flex: 1, padding: '48px 56px 24px', overflowY: 'auto', background: CREAM }}>
      <h1 style={{ fontSize: 28, fontWeight: 600, color: TEXT, letterSpacing: '-0.5px', marginBottom: 24, lineHeight: 1.2 }}>
        Settings
      </h1>
      <div style={{ maxWidth: 640 }}>
        <Section title="Gmail">
          <div style={{ marginBottom: 12, fontSize: 13, color: MUTED, lineHeight: 1.5 }}>
            Later can extract commitments — promises you've made, things pending on you,
            bills due — from your inbox and surface them for review. Read-only access;
            Later never sends or modifies mail.
          </div>
          {connectedEmail ? (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <span style={{
                  width: 8, height: 8, borderRadius: '50%', background: ACCENT, flexShrink: 0,
                }} />
                <span style={{ fontSize: 14, color: TEXT }}>Connected as</span>
                <span style={{ fontSize: 14, color: TEXT, fontWeight: 500 }}>{connectedEmail}</span>
              </div>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 12 }}>
                {formatSyncedAgo(lastSynced)}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={onSyncNow}
                  disabled={syncing}
                  style={{ ...buttonSecondaryStyle, opacity: syncing ? 0.5 : 1 }}
                >
                  {syncing ? 'Syncing…' : 'Sync now'}
                </button>
                <button
                  onClick={onDisconnect}
                  style={buttonSecondaryStyle}
                >
                  Disconnect
                </button>
              </div>
              {syncSummary && (
                <div style={{ marginTop: 10, fontSize: 12, color: MUTED }}>
                  {syncSummary}
                </div>
              )}
            </div>
          ) : (
            <div>
              <button
                onClick={onConnect}
                disabled={connecting || !configured}
                style={{ ...buttonPrimaryStyle, opacity: (connecting || !configured) ? 0.5 : 1, cursor: !configured ? 'not-allowed' : 'pointer' }}
              >
                {connecting ? 'Connecting…' : 'Connect Gmail'}
              </button>
              {!configured && (
                <div style={{
                  marginTop: 10, padding: '8px 12px', background: '#f5f4f1',
                  border: '1px solid #e0dfd9', borderRadius: 6,
                  fontSize: 12, color: '#666', lineHeight: 1.4,
                }}>
                  Gmail OAuth client ID not configured. Paste the Client ID
                  from Google Cloud Console into <code style={{ background: '#eeede9', padding: '1px 4px', borderRadius: 3 }}>src-tauri/src/gmail_config.rs</code> and rebuild.
                </div>
              )}
              {error && (
                <div style={{
                  marginTop: 10, padding: '8px 12px', background: '#fdf5eb',
                  border: '1px solid #f0d89a', borderRadius: 6,
                  fontSize: 12, color: '#8a5a30', lineHeight: 1.4,
                }}>
                  {error}
                </div>
              )}
            </div>
          )}
        </Section>
      </div>
    </div>
  )
}


// Small internal helper — no styling library here yet, so a local one keeps
// the section markup consistent as we add more (profile, categories, etc).
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: CARD_BG, border: `1px solid ${CARD_BORDER}`,
      borderRadius: 10, padding: '18px 20px', marginBottom: 16,
    }}>
      <h2 style={{ fontSize: 15, fontWeight: 600, color: TEXT, marginBottom: 10, letterSpacing: '-0.1px' }}>
        {title}
      </h2>
      {children}
    </div>
  )
}

const buttonPrimaryStyle: React.CSSProperties = {
  fontSize: 13, fontWeight: 500, color: '#fff', background: TEXT,
  border: 'none', borderRadius: 6, padding: '8px 16px',
  cursor: 'pointer', fontFamily: 'inherit',
}

const buttonSecondaryStyle: React.CSSProperties = {
  fontSize: 13, fontWeight: 500, color: TEXT, background: 'transparent',
  border: `1px solid ${CARD_BORDER}`, borderRadius: 6, padding: '7px 14px',
  cursor: 'pointer', fontFamily: 'inherit',
}
