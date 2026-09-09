// Open Loops — Gmail-extracted commitments awaiting the user's tick/cross.
//
// Storage layout in localStorage:
//   later:openloops              → array<OpenLoop>              (open + accepted + rejected)
//   later:openloop_rejections    → Record<threadId, Rejection>  (dedup guard)
//   later:openloop_closed_count  → number                       (lifetime accepted + rejected)
//   later:gmail_history_id       → string                       (Gmail sync cursor)
//   later:gmail_last_synced_at   → ISO datetime                 (for review-tab "updated X ago")
//
// Every helper broadcasts later://state-changed after a write so the library
// and any future review-tab window re-render — same pattern as LinkRow writes.

export type OpenLoopType = 'promise' | 'pending' | 'bill' | 'event'
export type OpenLoopStatus = 'open' | 'accepted' | 'rejected'

export interface OpenLoop {
  id: string                        // `openloop-${gmailMessageId}`
  type: OpenLoopType
  summary: string                   // one-line, task-shaped; not a copy of the subject
  sender_name: string
  sender_email: string
  // Real sentence from the email containing the specific fact (date, amount,
  // ask). NEVER a placeholder like "…X…" — if we couldn't find a good clause,
  // this stays null and the extraction is logged as weak. UI can decide
  // whether to show the item at all.
  quoted_clause: string | null
  due_at: string | null             // ISO datetime, may be null
  source_thread_id: string          // Gmail thread id — dedup key
  source_message_id: string         // specific message that triggered this
  source_message_snippet: string
  gmail_url: string                 // deep link
  status: OpenLoopStatus
  created_at: string
  accepted_at?: string | null
  rejected_at?: string | null
  // LinkRow id assigned when this OpenLoop is accepted — lets the review tab
  // (and future audit views) resolve "what did this become?".
  accepted_as_link_id?: string | null
}

export interface OpenLoopRejection {
  thread_id: string
  rejected_at: string
  // Gmail history id captured at rejection time. Extraction pass skips this
  // thread unless the current history id has moved past this value AND the
  // thread has new messages the user hasn't yet dismissed — i.e. genuine new
  // substance, per the spec.
  history_id_at_rejection: string
}

const SYNC_EVENT = 'later://state-changed'

async function broadcast(): Promise<void> {
  try {
    const { emit } = await import('@tauri-apps/api/event')
    await emit(SYNC_EVENT)
  } catch { /* outside Tauri — silent */ }
}

// ------- OpenLoop CRUD -------

export function loadOpenLoops(): OpenLoop[] {
  try {
    const raw = localStorage.getItem('later:openloops')
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

export function saveOpenLoops(loops: OpenLoop[]): void {
  localStorage.setItem('later:openloops', JSON.stringify(loops))
  void broadcast()
}

// Insert a batch of freshly-extracted OpenLoops. Dedupes against existing ids
// (idempotent re-runs of the sync are safe) and against thread_ids that are
// already surfaced as open — only the first extraction from a thread wins.
export function upsertOpenLoops(fresh: OpenLoop[]): void {
  if (!fresh.length) return
  const existing = loadOpenLoops()
  const seenIds = new Set(existing.map(l => l.id))
  const openThreadIds = new Set(existing.filter(l => l.status === 'open').map(l => l.source_thread_id))
  const merged = [...existing]
  for (const l of fresh) {
    if (seenIds.has(l.id)) continue
    if (openThreadIds.has(l.source_thread_id)) continue
    merged.push(l)
  }
  saveOpenLoops(merged)
}

// Get the loops the review tab should show — open, most-recent first.
export function loadOpenQueue(): OpenLoop[] {
  return loadOpenLoops()
    .filter(l => l.status === 'open')
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
}

// ------- Status transitions -------
// These bump the lifetime closed-count exactly once per transition into a
// terminal state. Doing the count-bump here (not at the caller) keeps the
// tally impossible to double-count from two code paths.

export function markAccepted(id: string, linkId: string): void {
  const loops = loadOpenLoops()
  const target = loops.find(l => l.id === id)
  if (!target || target.status !== 'open') return
  target.status = 'accepted'
  target.accepted_at = new Date().toISOString()
  target.accepted_as_link_id = linkId
  saveOpenLoops(loops)
  bumpClosedCount()
}

export function markRejected(id: string, historyIdAtRejection: string): void {
  const loops = loadOpenLoops()
  const target = loops.find(l => l.id === id)
  if (!target || target.status !== 'open') return
  target.status = 'rejected'
  target.rejected_at = new Date().toISOString()
  saveOpenLoops(loops)
  // Also log the rejection keyed by thread for the extraction-time dedup.
  addRejection({
    thread_id: target.source_thread_id,
    rejected_at: target.rejected_at,
    history_id_at_rejection: historyIdAtRejection,
  })
  bumpClosedCount()
}

// ------- Rejection dedup log -------

export function loadRejections(): Record<string, OpenLoopRejection> {
  try {
    const raw = localStorage.getItem('later:openloop_rejections')
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

export function addRejection(r: OpenLoopRejection): void {
  const map = loadRejections()
  map[r.thread_id] = r
  localStorage.setItem('later:openloop_rejections', JSON.stringify(map))
  void broadcast()
}

// Called from the extraction path (client-side gate before showing an item).
// Returns true if this thread was previously rejected AND the current gmail
// history id has NOT moved past the recorded one — i.e. no new substance.
// If the thread has new content, the item is allowed through and the caller
// will overwrite/clear the stale rejection.
export function isThreadStillDismissed(threadId: string, currentHistoryId: string): boolean {
  const r = loadRejections()[threadId]
  if (!r) return false
  // If we have no way to compare, err on the side of NOT re-surfacing.
  if (!currentHistoryId || !r.history_id_at_rejection) return true
  // Gmail history ids are numeric strings, monotonically increasing per user.
  const now = Number(currentHistoryId)
  const then = Number(r.history_id_at_rejection)
  if (!Number.isFinite(now) || !Number.isFinite(then)) return true
  return now <= then
}

// ------- Closed-count tally (lifetime) -------

export function loadClosedCount(): number {
  const raw = localStorage.getItem('later:openloop_closed_count')
  const n = raw ? Number(raw) : 0
  return Number.isFinite(n) && n >= 0 ? n : 0
}

function bumpClosedCount(): void {
  const next = loadClosedCount() + 1
  localStorage.setItem('later:openloop_closed_count', String(next))
  void broadcast()
}

// ------- Gmail sync cursor + last-synced-at -------

export function loadGmailHistoryId(): string | null {
  return localStorage.getItem('later:gmail_history_id')
}

export function saveGmailHistoryId(id: string): void {
  localStorage.setItem('later:gmail_history_id', id)
  void broadcast()
}

export function loadLastSyncedAt(): string | null {
  return localStorage.getItem('later:gmail_last_synced_at')
}

export function saveLastSyncedAt(iso: string): void {
  localStorage.setItem('later:gmail_last_synced_at', iso)
  void broadcast()
}

// Display-only formatter for OpenLoop.due_at. Drops the time portion — the
// hour/minute the extractor infers is usually a "end of Friday" heuristic,
// not a real extracted time, so surfacing it just adds noise. The underlying
// full datetime is preserved for reminder scheduling (see App.tsx accept).
export function formatDueDate(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString()
}

// Human-friendly "updated 3m ago" for the review-tab header. Kept here rather
// than in reminders.ts so we don't cross-import date formatters between
// unrelated features.
export function formatSyncedAgo(iso: string | null): string {
  if (!iso) return 'not synced yet'
  const t = new Date(iso).getTime()
  if (isNaN(t)) return 'not synced yet'
  const diffMs = Date.now() - t
  if (diffMs < 0) return 'updated just now'
  const min = Math.round(diffMs / 60000)
  if (min < 1) return 'updated just now'
  if (min < 60) return `updated ${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `updated ${hr}h ago`
  const d = Math.round(hr / 24)
  return `updated ${d}d ago`
}

// Helper for the "weak extraction" log — items with no quoted_clause. Kept as
// a fire-and-forget local console log for now; wire to telemetry later if we
// want to tune prompts systematically.
export function logWeakExtraction(loop: Pick<OpenLoop, 'id' | 'type' | 'summary' | 'source_thread_id'>): void {
  console.warn('[later/openloops] weak extraction (no quoted_clause)', loop)
}
