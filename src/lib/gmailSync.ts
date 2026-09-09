// Gmail sync loop — runs from the library window on a 20-min interval.
//
// One round-trip per poll:
//   1. gmail_sync (Rust)     — Rust reads refresh_token from Keychain, worker
//                              hits Gmail with a fresh access_token, returns
//                              new-since-cursor message metadata + new history_id.
//   2. filter                — drop threads that are still-dismissed per the
//                              rejection log (openloops.isThreadStillDismissed).
//   3. extract_openloops     — worker Anthropic call, one verdict per message.
//   4. upsert                — new OpenLoops land in localStorage; existing
//                              open-thread items are de-duped inside upsert.
//   5. saveGmailHistoryId + saveLastSyncedAt.
//
// Errors at any step short-circuit: last_synced_at is only bumped on a fully
// successful poll, so the Settings card's "updated Xm ago" indicator is
// honest — it's the last successful sync, not the last attempted one.

import {
  isThreadStillDismissed,
  loadGmailHistoryId,
  saveGmailHistoryId,
  saveLastSyncedAt,
  upsertOpenLoops,
  logWeakExtraction,
  type OpenLoop,
  type OpenLoopType,
} from './openloops'
import { loadUserProfileText } from './profile'

interface SyncedMessage {
  message_id: string
  thread_id: string
  subject: string
  from_name: string
  from_email: string
  snippet: string
  body: string
  internal_date_ms: number
}

interface Extraction {
  index: number
  decision: 'extract' | 'skip'
  type: OpenLoopType | ''
  summary: string
  quoted_clause: string
  due_at: string
  skip_reason: string
}

export interface PollOutcome {
  ok: boolean
  messages_fetched: number
  extracted: number
  reason?: string
}

// Poll cadence and startup delay are picked here so the whole loop is
// tunable from one place. 20 min matches the Phase-B decision.
export const POLL_INTERVAL_MS = 20 * 60 * 1000
// Wait a bit after the library window mounts before firing the first poll so
// launch isn't slammed with network work. 3s is enough for reminders to
// finish their own boot rescheduler.
export const POLL_STARTUP_DELAY_MS = 3000

// Turn { error, detail } into a compact human-friendly reason for the
// Settings card. Handy for triage when the wrangler tail is stale, since
// this lands right in the UI.
function describeError(err: string, detail: unknown): string {
  if (!detail) return err
  try {
    const s = typeof detail === 'string' ? detail : JSON.stringify(detail)
    return `${err} · ${s.slice(0, 400)}`
  } catch { return err }
}

// Idempotent — safe to call multiple times; earlier interval is cleared.
let pollTimer: ReturnType<typeof setInterval> | null = null

export function startPollLoop(onEachPoll?: (outcome: PollOutcome) => void): () => void {
  stopPollLoop()
  const runOnce = () => {
    void pollOnce().then(o => { onEachPoll?.(o) })
  }
  const initialTimeout = setTimeout(runOnce, POLL_STARTUP_DELAY_MS)
  pollTimer = setInterval(runOnce, POLL_INTERVAL_MS)
  return () => {
    clearTimeout(initialTimeout)
    stopPollLoop()
  }
}

export function stopPollLoop(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}

// One poll iteration. Returns a small outcome record for the debug preview
// in Settings — nothing else looks at it right now.
export async function pollOnce(): Promise<PollOutcome> {
  const connectedEmail = localStorage.getItem('later:gmail_connected_email')
  if (!connectedEmail) return { ok: false, messages_fetched: 0, extracted: 0, reason: 'not_connected' }

  let invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
  try {
    invoke = (await import('@tauri-apps/api/core')).invoke
  } catch {
    return { ok: false, messages_fetched: 0, extracted: 0, reason: 'not_in_tauri' }
  }

  // ---- Fetch ----
  const historyId = loadGmailHistoryId()
  const syncResult = await invoke<{
    messages?: SyncedMessage[]
    new_history_id?: string | null
    error?: string
    detail?: unknown
  }>('gmail_sync', { sinceHistoryId: historyId ?? null })

  if (syncResult.error) {
    console.warn('[gmailSync] gmail_sync error:', syncResult.error, syncResult.detail)
    return { ok: false, messages_fetched: 0, extracted: 0, reason: describeError(syncResult.error, syncResult.detail) }
  }

  const messages = syncResult.messages ?? []
  const newHistoryId = syncResult.new_history_id ?? historyId ?? null

  // ---- Filter rejections ----
  // If a thread was dismissed at history_id X and the returned history_id
  // hasn't moved past X, don't resurface — that's the "no re-notify on the
  // same thread" guard.
  const filtered = messages.filter(m => {
    if (!m.thread_id) return true
    return !isThreadStillDismissed(m.thread_id, newHistoryId ?? '')
  })

  if (!filtered.length) {
    // Even a no-op poll bumps the cursor + timestamp so the "updated Xm ago"
    // line reflects the fact that we DID check.
    if (newHistoryId) saveGmailHistoryId(newHistoryId)
    saveLastSyncedAt(new Date().toISOString())
    return { ok: true, messages_fetched: messages.length, extracted: 0 }
  }

  // ---- Extract ----
  const extractResult = await invoke<{
    extractions?: Extraction[]
    error?: string
    detail?: unknown
  }>('extract_openloops', {
    messages: filtered,
    userProfile: loadUserProfileText(),
    userEmail: connectedEmail,
  })

  if (extractResult.error) {
    console.warn('[gmailSync] extract_openloops error:', extractResult.error, extractResult.detail)
    // Keep the history_id fresh so we don't re-fetch the same batch next
    // poll — extraction failure isn't a reason to re-hit Gmail.
    if (newHistoryId) saveGmailHistoryId(newHistoryId)
    return { ok: false, messages_fetched: filtered.length, extracted: 0, reason: describeError(extractResult.error, extractResult.detail) }
  }

  const extractions = extractResult.extractions ?? []
  const nowIso = new Date().toISOString()
  const loops: OpenLoop[] = []
  for (const e of extractions) {
    if (e.decision !== 'extract') continue
    const m = filtered[e.index]
    if (!m) { console.warn('[gmailSync] extraction index out of range', e); continue }
    if (!e.type || (e.type !== 'promise' && e.type !== 'pending' && e.type !== 'bill' && e.type !== 'event')) continue

    const quoted = e.quoted_clause?.trim() || null
    const dueAt = e.due_at?.trim() || null

    const loop: OpenLoop = {
      id: `openloop-${m.message_id}`,
      type: e.type,
      summary: (e.summary || '').trim() || m.subject,
      sender_name: m.from_name,
      sender_email: m.from_email,
      quoted_clause: quoted,
      due_at: dueAt,
      source_thread_id: m.thread_id,
      source_message_id: m.message_id,
      source_message_snippet: m.snippet,
      gmail_url: `https://mail.google.com/mail/u/0/#inbox/${m.thread_id}`,
      status: 'open',
      created_at: nowIso,
    }
    if (!quoted) logWeakExtraction(loop)
    loops.push(loop)
  }

  upsertOpenLoops(loops)
  if (newHistoryId) saveGmailHistoryId(newHistoryId)
  saveLastSyncedAt(nowIso)
  return { ok: true, messages_fetched: filtered.length, extracted: loops.length }
}
