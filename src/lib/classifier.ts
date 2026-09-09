// Shared classifier client logic used by both the library window (App.tsx) and
// the tray popup (PopupApp.tsx). The worker's /classify endpoint returns one of
// four decisions; this module turns each decision into a state transition on
// the item and (for suggest_new) a recurrence queue that gates surfacing the
// confirm/reject chip until a theme has repeated across enough items.
//
// State stored in localStorage:
//   later:category_descriptions  Record<name, description>
//   later:pending_new            Record<proposedName, string[] linkIds>
//   later:rejections             Array<RejectionRecord>   (bounded to 500)

export type PendingSuggestion =
  | { kind: 'existing'; category: string; reason?: string }
  | { kind: 'new'; category: string; description: string; reason?: string }
  // In-flight: the fast-model first pass came back non-confident and we've
  // kicked off a reasoning-model second pass. Chip renders as "Thinking…"
  // with no ✓/✗. `fallbackCategory` holds Haiku's original guess so we can
  // gracefully fall back to an "existing" chip if the reasoning call fails.
  | { kind: 'reasoning'; fallbackCategory: string; fallbackKind: 'existing' | 'new'; fallbackDescription?: string }

export type ClassifyDecision = 'assign' | 'suggest_existing' | 'suggest_new' | 'none'

export interface ClassifyResponse {
  decision: ClassifyDecision
  category: string
  description: string
  reason: string
}

// Number of items with the same suggest_new category name that must
// accumulate before we surface the chip. 1 = surface the chip immediately on
// the first oddball item. We tried 2 briefly (as anti-suggestion-spam) but
// Haiku produces slightly different names for similar themes ("Health" vs
// "Health & Wellness"), so a 2-match threshold rarely fired and everything
// silently landed in Uncategorized. Better UX: propose immediately, let the
// user reject. Rejections are logged and can be used for future tuning.
export const NEW_CATEGORY_RECURRENCE_THRESHOLD = 1

const K_DESCS = 'later:category_descriptions'
const K_PENDING = 'later:pending_new'
const K_REJECTIONS = 'later:rejections'
const REJECTIONS_MAX = 500

export function loadCategoryDescriptions(): Record<string, string> {
  try {
    const raw = localStorage.getItem(K_DESCS)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

export function saveCategoryDescription(name: string, description: string) {
  const map = loadCategoryDescriptions()
  map[name] = description
  localStorage.setItem(K_DESCS, JSON.stringify(map))
}

export function deleteCategoryDescription(name: string) {
  const map = loadCategoryDescriptions()
  if (!(name in map)) return
  delete map[name]
  localStorage.setItem(K_DESCS, JSON.stringify(map))
}

export function loadPendingQueue(): Record<string, { linkIds: string[]; description: string }> {
  try {
    const raw = localStorage.getItem(K_PENDING)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

// Names of pending new-category proposals — passed to the classifier so it
// can reuse an existing pending name rather than inventing a near-duplicate
// for a similar item.
export function loadPendingNewNames(): string[] {
  return Object.keys(loadPendingQueue())
}

function savePendingQueue(q: Record<string, { linkIds: string[]; description: string }>) {
  localStorage.setItem(K_PENDING, JSON.stringify(q))
}

// Rejection log — used as a signal for future prompt tuning or (later) a
// retrieval store. Stored locally only; no network round-trip.
export interface RejectionRecord {
  text: string
  rejected_category: string
  kind: 'existing' | 'new'
  timestamp: string
}

export function logRejection(rec: RejectionRecord) {
  try {
    const raw = localStorage.getItem(K_REJECTIONS)
    const arr: RejectionRecord[] = raw ? JSON.parse(raw) : []
    arr.push(rec)
    if (arr.length > REJECTIONS_MAX) arr.splice(0, arr.length - REJECTIONS_MAX)
    localStorage.setItem(K_REJECTIONS, JSON.stringify(arr))
    console.log('[later/classifier] logged rejection', rec)
  } catch (e) {
    console.warn('[later/classifier] logRejection failed', e)
  }
}

// Given a suggest_new decision from the worker, enqueue this link under the
// proposed category name and report whether the queue for that name has
// reached the recurrence threshold. If it has, the caller should mark ALL
// queued items with a pending_suggestion; the returned linkIds are the ones
// to update.
export function enqueueSuggestNew(
  linkId: string,
  proposedCategory: string,
  proposedDescription: string,
): { surfaceNow: boolean; linkIdsToUpdate: string[]; description: string } {
  const q = loadPendingQueue()
  const entry = q[proposedCategory] ?? { linkIds: [], description: '' }
  if (!entry.linkIds.includes(linkId)) entry.linkIds.push(linkId)
  // Prefer the newer, non-empty description — earlier calls may have had a
  // shorter draft. Keep whichever is longer as a proxy for more informative.
  if (proposedDescription.length > entry.description.length) {
    entry.description = proposedDescription
  }
  q[proposedCategory] = entry
  savePendingQueue(q)

  const surfaceNow = entry.linkIds.length >= NEW_CATEGORY_RECURRENCE_THRESHOLD
  return {
    surfaceNow,
    linkIdsToUpdate: surfaceNow ? [...entry.linkIds] : [],
    description: entry.description,
  }
}

// Called when the user confirms a suggest_new chip. Clears the queue entry for
// that category name and returns the linkIds that should get the new category
// applied.
export function acceptPendingNew(proposedCategory: string): { linkIds: string[]; description: string } {
  const q = loadPendingQueue()
  const entry = q[proposedCategory]
  if (!entry) return { linkIds: [], description: '' }
  delete q[proposedCategory]
  savePendingQueue(q)
  return { linkIds: entry.linkIds, description: entry.description }
}

// Called when the user rejects a suggest_new chip on a specific item. Only
// removes that link from the queue; other queued items keep their pending
// chip until they're individually accepted or rejected.
export function rejectPendingNewOnItem(linkId: string, proposedCategory: string) {
  const q = loadPendingQueue()
  const entry = q[proposedCategory]
  if (!entry) return
  entry.linkIds = entry.linkIds.filter(id => id !== linkId)
  if (entry.linkIds.length === 0) delete q[proposedCategory]
  else q[proposedCategory] = entry
  savePendingQueue(q)
}

// Prune queue entries that reference linkIds no longer present (deleted items).
// Called on app boot so a rejected/deleted item can't keep a suggestion alive
// forever.
export function pruneQueue(existingLinkIds: Set<string>) {
  const q = loadPendingQueue()
  let changed = false
  for (const name of Object.keys(q)) {
    const before = q[name].linkIds.length
    q[name].linkIds = q[name].linkIds.filter(id => existingLinkIds.has(id))
    if (q[name].linkIds.length !== before) changed = true
    if (q[name].linkIds.length === 0) { delete q[name]; changed = true }
  }
  if (changed) savePendingQueue(q)
}
