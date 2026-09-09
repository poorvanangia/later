import { useState, useEffect } from 'react'
import { LibraryPage } from './components/LibraryPage'
import { SpotlightBar } from './components/SpotlightBar'
import { Onboarding } from './components/Onboarding'
import {
  loadCategoryDescriptions,
  saveCategoryDescription,
  deleteCategoryDescription,
  loadPendingNewNames,
  enqueueSuggestNew,
  acceptPendingNew,
  rejectPendingNewOnItem,
  pruneQueue,
  logRejection,
  type PendingSuggestion,
  type ClassifyResponse,
} from './lib/classifier'
import { loadUserProfileText } from './lib/profile'
import { scheduleReminderNative, cancelReminderNative } from './lib/reminders'
import { startPollLoop } from './lib/gmailSync'
import { loadOpenLoops, markAccepted, markRejected, loadGmailHistoryId, type OpenLoop } from './lib/openloops'

const SYNC_EVENT = 'later://state-changed'

// Tauri webviews share localStorage but the browser `storage` event doesn't
// fire reliably cross-window on macOS WKWebView. We emit a Tauri event after
// every persisted change and listen in every window so library/popup/spotlight
// stay in sync.
async function broadcastChange() {
  try {
    const { emit } = await import('@tauri-apps/api/event')
    await emit(SYNC_EVENT)
  } catch { }
}

const WINDOW_LABEL = (window as any).__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? ''
const IS_SPOTLIGHT = WINDOW_LABEL === 'main'

// Serialize classify_item calls so each one sees the pending queue populated
// by the previous. Rapid entry of similar items (three purchases in a row)
// would otherwise fire three parallel classifications, all reading an empty
// pending queue and independently proposing different new-category names.
let classifyChain: Promise<void> = Promise.resolve()

// Legacy seed names from v0.1.7 and earlier — never a design goal, just
// pre-population that leaked through onto every new install. Kept only for the
// one-time purge in loadCategories(); do not re-seed.
const LEGACY_SEED_CATEGORIES = ['Articles', 'Cooking', 'Travel', 'Shopping', 'Videos', 'Research', 'Work', 'Health', 'Finance', 'Entertainment', 'News']
const UNDO_LIMIT = 20

export type ItemType = 'link' | 'note' | 'pdf'

type Snapshot = { links: LinkRow[]; categories: string[] }

export type LinkRow = {
  id: string
  url: string
  title: string | null
  note: string | null
  category: string | null
  label: string | null
  read_time_minutes: number | null
  intent: 'read' | 'act' | null
  is_done: boolean
  ai_processed: boolean
  created_at: string
  item_type: ItemType
  // Present when the classifier was unsure or proposed a new category. The
  // item's `category` field stays null (uncategorized) until the user taps ✓
  // on the chip. Rejection clears this and logs the rejection.
  pending_suggestion?: PendingSuggestion | null
  // Optional one-time reminder. ISO datetime. When set, the Rust side has
  // a tokio task waiting to fire the reminder popup at this time.
  remind_at?: string | null
  // Set when the popup has actually been presented on screen. Gates re-firing:
  // once a popup was shown (even if the user ignored it and quit the app),
  // we do NOT show it again on next launch. Cleared whenever remind_at is
  // reset — a fresh schedule is a fresh popup.
  fired_at?: string | null
  // Set when the user pressed Okay or View. This is the "user actually saw
  // this" signal; drives the acknowledged bell state and its "reminded X ago"
  // tooltip. Cleared whenever remind_at is reset.
  acknowledged_at?: string | null
  // Provenance for items created from external sources (Gmail today; WhatsApp,
  // LinkedIn later). Kept as a small discriminated union so the LinkRow
  // itself doesn't grow a Gmail-specific set of fields — new sources just add
  // a new `kind` variant.
  source_ref?: LinkSourceRef | null
}

export type LinkSourceRef = {
  kind: 'gmail'
  thread_id: string
  message_id: string
  url: string     // pre-computed deep link, so the UI never needs Gmail's URL scheme
}

function loadLinks(): LinkRow[] {
  try {
    const stored = localStorage.getItem('later:links')
    return stored ? JSON.parse(stored) : []
  } catch { return [] }
}

function saveLinks(links: LinkRow[]) {
  localStorage.setItem('later:links', JSON.stringify(links))
  broadcastChange()
}

function loadCategories(): string[] {
  try {
    const stored = localStorage.getItem('later:categories')
    if (!stored) return []
    let cats: string[] = JSON.parse(stored)
    // One-time purge for users upgrading from a version that auto-seeded
    // categories. Only drops legacy seed names that never got attached to any
    // saved item — genuine user- or AI-added categories keep their names.
    if (!localStorage.getItem('later:seedPurged')) {
      const rawLinks = localStorage.getItem('later:links') ?? '[]'
      const links: Array<{ category: string | null }> = JSON.parse(rawLinks)
      const usedCats = new Set(links.map(l => l.category).filter(Boolean) as string[])
      cats = cats.filter(c => !LEGACY_SEED_CATEGORIES.includes(c) || usedCats.has(c))
      localStorage.setItem('later:categories', JSON.stringify(cats))
      localStorage.setItem('later:seedPurged', '1')
    }
    return cats
  } catch { return [] }
}

function saveCategories(cats: string[]) {
  localStorage.setItem('later:categories', JSON.stringify(cats))
  broadcastChange()
}

function detectType(text: string): ItemType {
  if (text.endsWith('.pdf')) return 'pdf'
  if (text.startsWith('http://') || text.startsWith('https://') || text.includes('.')) return 'link'
  return 'note'
}

export default function App() {
  const [view, setView] = useState<string>('library')
  const [links, setLinks] = useState<LinkRow[]>(loadLinks)
  const [search, setSearch] = useState('')
  const [categories, setCategories] = useState<string[]>(loadCategories)
  const [openLoops, setOpenLoops] = useState<OpenLoop[]>(loadOpenLoops)
  const [, setUndoStack] = useState<Snapshot[]>([])
  // "First-run nudge" state — persisted so it survives reloads. Semantics
  // (matches spec): show banner only on a fresh 0→N transition; dismiss
  // silently until count returns to 0.
  const [nudgeDismissed, setNudgeDismissed] = useState<boolean>(() =>
    localStorage.getItem('later:openloops_nudge_dismissed') === '1'
  )
  // Onboarding was previously mounted in the (now-retired) popup window. Now
  // that the vault is the first thing users see, it lives here — shown as an
  // overlay when the completion marker is missing.
  const [showOnboarding, setShowOnboarding] = useState(() => {
    try { return WINDOW_LABEL === 'library' && !localStorage.getItem('later:onboardingComplete') } catch { return false }
  })

  const aiCategories = [...new Set(links.map(l => l.category).filter(Boolean) as string[])]
  const allCategories = [...new Set([...categories, ...aiCategories])]

  // Generic mutator — pushes the PREVIOUS state onto the undo stack, then applies the update.
  // User-initiated actions (add, edit, done, category change, delete) go through this.
  const mutate = (updater: (prev: Snapshot) => Snapshot) => {
    const prevSnap: Snapshot = { links, categories }
    const next = updater(prevSnap)
    setUndoStack(stack => [...stack.slice(-(UNDO_LIMIT - 1)), prevSnap])
    setLinks(next.links)
    setCategories(next.categories)
    saveLinks(next.links)
    saveCategories(next.categories)
  }

  const mutateLinks = (updater: (prev: LinkRow[]) => LinkRow[]) => {
    mutate(prev => ({ links: updater(prev.links), categories: prev.categories }))
  }

  // Background AI updates (title fetch, classification, summarisation) bypass undo —
  // they're automatic, not something the user did, so Cmd+Z shouldn't touch them.
  const applyBackgroundUpdate = (updater: (prev: LinkRow[]) => LinkRow[]) => {
    setLinks(prev => {
      const updated = updater(prev)
      saveLinks(updated)
      return updated
    })
  }

  // Prune the pending-new-category queue on mount so deleted items don't
  // keep a suggestion alive. Runs once per window mount.
  useEffect(() => {
    pruneQueue(new Set(links.map(l => l.id)))
    // Only on first mount — not on every links change (would thrash localStorage).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reload from localStorage on storage event (other browser tabs) OR Tauri
  // event (other Tauri windows in this same app). Also pulls the open-loops
  // queue in — it lives in the same shared localStorage and syncs the same way.
  useEffect(() => {
    const reload = () => {
      console.log('[later] sync: reloading from localStorage')
      setLinks(loadLinks())
      setCategories(loadCategories())
      setOpenLoops(loadOpenLoops())
    }
    window.addEventListener('storage', reload)
    let unlisten: (() => void) | undefined
    ;(async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        unlisten = await listen(SYNC_EVENT, reload)
      } catch { }
    })()
    return () => {
      window.removeEventListener('storage', reload)
      if (unlisten) unlisten()
    }
  }, [])

  // Nudge-reset effect: whenever the open-loops count hits zero, clear the
  // dismissed flag so the NEXT 0→N transition surfaces the banner again.
  // (Setting on rise is done inline in the banner render — no effect needed
  // since we always compute "should show" from count + dismissed.)
  const openLoopsCount = openLoops.filter(l => l.status === 'open').length
  useEffect(() => {
    if (openLoopsCount === 0 && nudgeDismissed) {
      setNudgeDismissed(false)
      localStorage.removeItem('later:openloops_nudge_dismissed')
    }
  }, [openLoopsCount, nudgeDismissed])
  const dismissNudge = () => {
    setNudgeDismissed(true)
    localStorage.setItem('later:openloops_nudge_dismissed', '1')
  }

  // Check for app updates once per library-window mount. Gated to the library
  // window because the spotlight pops up many times a day — a confirm dialog
  // there would be disruptive. If the user never opens the library, they won't
  // see updates; that's the tradeoff for a menu-bar app where the main UI is
  // the transient spotlight.
  useEffect(() => {
    if (WINDOW_LABEL !== 'library') return
    let cancelled = false
    ;(async () => {
      try {
        const { check } = await import('@tauri-apps/plugin-updater')
        const update = await check()
        if (cancelled || !update) return
        const yes = window.confirm(
          `A new version of Later is available (${update.version}). Update now?`
        )
        if (!yes) return
        await update.downloadAndInstall()
        const { relaunch } = await import('@tauri-apps/plugin-process')
        await relaunch()
      } catch (e) {
        console.warn('[later] update check failed:', e)
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Global Cmd+Z — undo the last user action. Works even when an input is focused:
  // every row in the library is an <input>, so gating on focus would mean undo
  // essentially never fires. We pop our own stack and preventDefault so the
  // browser's native input-undo doesn't fight us.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.metaKey || e.shiftKey) return
      if (e.key.toLowerCase() !== 'z') return
      console.log('[later] Cmd+Z pressed')
      e.preventDefault()
      setUndoStack(stack => {
        if (stack.length === 0) {
          console.log('[later] undo: stack empty, nothing to restore')
          return stack
        }
        const last = stack[stack.length - 1]
        console.log('[later] undo: restoring', { links: last.links.length, categories: last.categories.length })
        setLinks(last.links); saveLinks(last.links)
        setCategories(last.categories); saveCategories(last.categories)
        return stack.slice(0, -1)
      })
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const fetchTitle = async (id: string, url: string, forcedCategory?: string) => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const title = await invoke<string>('fetch_title', { url })
      if (title && title.length > 0) {
        applyBackgroundUpdate(prev => prev.map(l => l.id === id ? { ...l, title } : l))
        if (!forcedCategory) classifyItem(id, title)
      }
    } catch { }
  }

  const classifyItem = (id: string, text: string): Promise<void> => {
    classifyChain = classifyChain.then(() => classifyItemImpl(id, text)).catch(() => {})
    return classifyChain
  }

  const classifyItemImpl = async (id: string, text: string) => {
    console.log('[later] classifyItem start', { id, text: text.slice(0, 60) })
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      // Pass ONLY user-defined categories (sidebar entries) — never the union
      // with AI-assigned labels, which would let past hallucinations become
      // the taxonomy for future items.
      const result = await invoke<ClassifyResponse>('classify_item', {
        text,
        existingCategories: categories,
        categoryDescriptions: loadCategoryDescriptions(),
        pendingNewNames: loadPendingNewNames(),
        userProfile: loadUserProfileText(),
      })
      console.log('[later] classifyItem response', { id, result })

      if (result.decision === 'assign' && result.category) {
        applyBackgroundUpdate(prev => prev.map(l =>
          l.id === id ? { ...l, category: result.category, ai_processed: true, pending_suggestion: null } : l
        ))
        return
      }

      // Non-confident Haiku verdict → surface a "Thinking…" chip, then kick
      // off the reasoning pass. Reasoning result replaces this via the same
      // decision handlers. Only real content flows through reasoning;
      // empty/gibberish (`none`) is dropped as before.
      if ((result.decision === 'suggest_existing' || result.decision === 'suggest_new') && result.category) {
        const fallbackKind = result.decision === 'suggest_existing' ? 'existing' as const : 'new' as const
        applyBackgroundUpdate(prev => prev.map(l =>
          l.id === id
            ? {
                ...l,
                category: null,
                ai_processed: true,
                pending_suggestion: {
                  kind: 'reasoning',
                  fallbackCategory: result.category,
                  fallbackKind,
                  fallbackDescription: result.description,
                },
              }
            : l
        ))
        // Fire-and-forget: non-blocking so the row is interactive immediately.
        reasoningReclassify(id, text, {
          category: result.category,
          kind: fallbackKind,
          description: result.description,
          reason: result.reason,
        }).catch(err => console.error('[later] reasoning pass threw', err))
        return
      }

      // decision === 'none' — no category, no chip. Just mark processed.
      applyBackgroundUpdate(prev => prev.map(l => l.id === id ? { ...l, ai_processed: true } : l))
    } catch (err) {
      console.error('[later] classifyItem invoke threw', err)
      applyBackgroundUpdate(prev => prev.map(l => l.id === id ? { ...l, ai_processed: true } : l))
    }
  }

  // Apply a classifier verdict to an item's pending_suggestion state. Shared
  // between the first pass and the reasoning second pass. `originId` is the
  // id whose text was classified; queue-mate ids also get the chip in the
  // suggest_new case.
  const applyClassifyVerdict = (originId: string, result: ClassifyResponse) => {
    if (result.decision === 'assign' && result.category) {
      applyBackgroundUpdate(prev => prev.map(l =>
        l.id === originId ? { ...l, category: result.category, pending_suggestion: null } : l
      ))
      return
    }
    if (result.decision === 'suggest_existing' && result.category) {
      applyBackgroundUpdate(prev => prev.map(l =>
        l.id === originId
          ? { ...l, category: null, pending_suggestion: { kind: 'existing', category: result.category, reason: result.reason } }
          : l
      ))
      return
    }
    if (result.decision === 'suggest_new' && result.category) {
      const { surfaceNow, linkIdsToUpdate, description } = enqueueSuggestNew(originId, result.category, result.description)
      const idSet = new Set([originId, ...linkIdsToUpdate])
      applyBackgroundUpdate(prev => prev.map(l => {
        if (l.id === originId) {
          return {
            ...l,
            pending_suggestion: surfaceNow ? { kind: 'new', category: result.category, description, reason: result.reason } : l.pending_suggestion,
          }
        }
        if (surfaceNow && idSet.has(l.id)) {
          return { ...l, pending_suggestion: { kind: 'new', category: result.category, description, reason: result.reason } }
        }
        return l
      }))
      return
    }
    // decision === 'none' — clear any placeholder chip so the row shows the
    // regular Category dropdown, not a stuck "Thinking…" state.
    applyBackgroundUpdate(prev => prev.map(l =>
      l.id === originId ? { ...l, pending_suggestion: null } : l
    ))
  }

  // Second-pass reclassification via Sonnet 4.6 + extended thinking. Only
  // called for items Haiku wasn't confident about. Fallback param preserves
  // Haiku's answer so a failed reasoning call still shows something useful
  // to the user rather than a phantom Thinking… chip.
  const reasoningReclassify = async (
    id: string,
    text: string,
    fallback: { category: string; kind: 'existing' | 'new'; description: string; reason: string },
  ): Promise<void> => {
    console.log('[later] reclassify start', { id, text: text.slice(0, 60) })
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const result = await invoke<ClassifyResponse>('reclassify_item', {
        text,
        existingCategories: categories,
        categoryDescriptions: loadCategoryDescriptions(),
        pendingNewNames: loadPendingNewNames(),
        userProfile: loadUserProfileText(),
      })
      console.log('[later] reclassify response', { id, result })
      // If reasoning failed (returned "none" as a defensive fallback), keep
      // Haiku's original guess rather than dropping the item to uncategorized.
      if (result.decision === 'none') {
        applyClassifyVerdict(id, {
          decision: fallback.kind === 'existing' ? 'suggest_existing' : 'suggest_new',
          category: fallback.category,
          description: fallback.description,
          reason: fallback.reason,
        })
        return
      }
      applyClassifyVerdict(id, result)
    } catch (err) {
      console.error('[later] reclassify_item invoke threw', err)
      // Fall back to Haiku's suggestion so the chip isn't stuck.
      applyClassifyVerdict(id, {
        decision: fallback.kind === 'existing' ? 'suggest_existing' : 'suggest_new',
        category: fallback.category,
        description: fallback.description,
        reason: fallback.reason,
      })
    }
  }

  const summariseItem = async (id: string, text: string) => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const summary = await invoke<string>('generate_title', { text: text.slice(0, 2000) })
      if (summary && summary.length > 0) {
        applyBackgroundUpdate(prev => prev.map(l => l.id === id ? { ...l, title: summary } : l))
      }
    } catch { }
  }

  const handleAcceptSuggestion = (id: string) => {
    const link = links.find(l => l.id === id)
    if (!link?.pending_suggestion) return
    const sugg = link.pending_suggestion
    // Reasoning placeholder has no ✓/✗ buttons but guard anyway.
    if (sugg.kind === 'reasoning') return
    if (sugg.kind === 'existing') {
      applyBackgroundUpdate(prev => prev.map(l =>
        l.id === id ? { ...l, category: sugg.category, pending_suggestion: null } : l
      ))
      return
    }
    // kind === 'new': add the category to the sidebar with the AI-drafted
    // description, then apply it to every item currently queued under this
    // proposed name (all sharing the same chip).
    const { linkIds, description } = acceptPendingNew(sugg.category)
    const idSet = new Set(linkIds.length > 0 ? linkIds : [id])
    if (!categories.includes(sugg.category)) {
      const updatedCats = [...new Set([...categories, sugg.category])]
      setCategories(updatedCats)
      saveCategories(updatedCats)
      saveCategoryDescription(sugg.category, description || sugg.description)
    }
    applyBackgroundUpdate(prev => prev.map(l =>
      idSet.has(l.id) ? { ...l, category: sugg.category, pending_suggestion: null } : l
    ))
  }

  // Reminder handlers. Setting a new reminder replaces any prior one, and
  // resets the fired/acknowledged flags so the fresh schedule is a fresh
  // popup — an item the user acknowledged last week can be re-reminded
  // tomorrow without leaking the old "quiet acknowledged" bell state.
  const handleSetReminder = (id: string, remindAtIso: string) => {
    const link = links.find(l => l.id === id)
    if (!link) return
    const title = link.title || link.note || link.url || 'Later reminder'
    mutateLinks(prev => prev.map(l => l.id === id
      ? { ...l, remind_at: remindAtIso, fired_at: null, acknowledged_at: null }
      : l))
    scheduleReminderNative(id, title, remindAtIso)
  }
  const handleClearReminder = (id: string) => {
    mutateLinks(prev => prev.map(l => l.id === id
      ? { ...l, remind_at: null, fired_at: null, acknowledged_at: null }
      : l))
    cancelReminderNative(id)
  }

  // On mount: reschedule pending reminders (covers app restarts and OS wake).
  // Skip anything already presented — `fired_at` is set by the popup itself
  // when it appears (writes localStorage from the popup webview, which
  // shares the same origin/localStorage as the library). This is the
  // "no re-notify / no nag loop" guard from the spec.
  //
  // Anything past + not-yet-fired goes straight into Rust's queue; Rust
  // sorts by remind_at internally, so multiple missed reminders present
  // one at a time, most-overdue first, when the app comes back.
  useEffect(() => {
    if (WINDOW_LABEL !== 'library') return
    for (const link of links) {
      if (!link.remind_at) continue
      if (link.fired_at) continue  // already presented — don't re-fire
      const target = new Date(link.remind_at).getTime()
      if (isNaN(target)) continue
      const title = link.title || link.note || link.url || 'Later reminder'
      scheduleReminderNative(link.id, title, link.remind_at)
    }
    // "View" button in the popup asks Rust to open the vault and emit
    // this event; we scroll to the referenced item via a hash marker
    // that LibraryPage watches.
    let unlisten: (() => void) | undefined
    ;(async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        unlisten = await listen<string>('later://reminder-view-requested', event => {
          const id = event.payload
          console.log('[later] reminder view requested for', id)
          window.location.hash = `#item=${encodeURIComponent(id)}`
        })
      } catch { }
    })()
    return () => { if (unlisten) unlisten() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Gmail poll loop — only in the library window (single owner) and only for
  // the lifetime of that window. If the user closes and reopens the library,
  // the loop restarts fresh; the sync cursor in localStorage means we don't
  // re-process anything either way.
  useEffect(() => {
    if (WINDOW_LABEL !== 'library') return
    const stop = startPollLoop()
    return () => { stop() }
  }, [])

  // Accept an OpenLoop → real LinkRow. Runs through the same classifier path
  // manual saves take, so Gmail-extracted items land in the same categories.
  // If the OpenLoop carries a due_at, we schedule a reminder in the same
  // motion — the reminder system doesn't care whether the item's source is
  // the user typing or Gmail extraction.
  const handleAcceptOpenLoop = (loop: OpenLoop) => {
    const id = `link-${Date.now()}`
    const newLink: LinkRow = {
      id,
      url: loop.summary,   // note-shaped item — no URL to fetch
      title: loop.summary,
      note: loop.summary,
      category: null,
      label: null,
      read_time_minutes: null,
      intent: null,
      is_done: false,
      ai_processed: false,
      created_at: new Date().toISOString(),
      item_type: 'note',
      source_ref: {
        kind: 'gmail',
        thread_id: loop.source_thread_id,
        message_id: loop.source_message_id,
        url: loop.gmail_url,
      },
      remind_at: loop.due_at ?? null,
      fired_at: null,
      acknowledged_at: null,
    }
    mutateLinks(prev => [newLink, ...prev])
    // Kick classification the same way handleSave does for note-type items.
    setTimeout(() => classifyItem(id, loop.summary), 100)
    // If we have a due date, wire the reminder — matches how handleSetReminder
    // schedules for manually-set ones.
    if (loop.due_at) {
      scheduleReminderNative(id, loop.summary, loop.due_at)
    }
    markAccepted(loop.id, id)
    setOpenLoops(loadOpenLoops())  // eager local refresh; sync event will confirm
  }

  const handleRejectOpenLoop = (loop: OpenLoop) => {
    // Anchor the rejection to the current sync cursor so the extraction path
    // can re-surface this thread ONLY if it gains new content past this point.
    const historyId = loadGmailHistoryId() ?? ''
    markRejected(loop.id, historyId)
    setOpenLoops(loadOpenLoops())
  }

  const handleRejectSuggestion = (id: string) => {
    const link = links.find(l => l.id === id)
    if (!link?.pending_suggestion) return
    const sugg = link.pending_suggestion
    if (sugg.kind === 'reasoning') return
    logRejection({
      text: link.title || link.note || link.url || '',
      rejected_category: sugg.category,
      kind: sugg.kind,
      timestamp: new Date().toISOString(),
    })
    if (sugg.kind === 'new') rejectPendingNewOnItem(id, sugg.category)
    applyBackgroundUpdate(prev => prev.map(l =>
      l.id === id ? { ...l, pending_suggestion: null } : l
    ))
  }

  // forcedCategory: if the user added this item while viewing a specific category,
  // it's assigned that category directly and AI classification is skipped entirely.
  const handleSave = (text: string, forcedCategory?: string) => {
    const trimmed = text.trim()
    const type = detectType(trimmed)
    const isUrl = type === 'link' || type === 'pdf'
    const url = isUrl && !trimmed.startsWith('http') ? `https://${trimmed}` : trimmed
    const domain = isUrl ? (() => { try { return new URL(url).hostname.replace('www.', '') } catch { return url } })() : null

    const newLink: LinkRow = {
      id: `link-${Date.now()}`,
      url,
      title: type === 'note' ? trimmed : domain,
      note: type === 'note' ? trimmed : null,
      category: forcedCategory ?? null,
      label: null,
      read_time_minutes: null,
      intent: null,
      is_done: false,
      ai_processed: !!forcedCategory,
      created_at: new Date().toISOString(),
      item_type: type,
    }

    mutateLinks(prev => [newLink, ...prev])

    if (isUrl) {
      setTimeout(() => fetchTitle(newLink.id, url, forcedCategory), 100)
    } else if (trimmed.length > 100) {
      setTimeout(() => summariseItem(newLink.id, trimmed), 100)
      if (!forcedCategory) setTimeout(() => classifyItem(newLink.id, trimmed), 200)
    } else {
      if (!forcedCategory) setTimeout(() => classifyItem(newLink.id, trimmed), 100)
    }
  }

  const handleDone = (id: string) => {
    mutateLinks(prev => prev.map(l => l.id === id ? { ...l, is_done: true } : l))
  }

  const handleUpdateItem = (id: string, updates: Partial<LinkRow>) => {
    mutateLinks(prev => prev.map(l => l.id === id ? { ...l, ...updates } : l))
  }

  const handleCategoryChange = (id: string, category: string) => {
    // Manual category change from the item's tag menu. Also clears any pending
    // suggestion — the user has settled the question by picking directly.
    mutateLinks(prev => prev.map(l => l.id === id ? { ...l, category, pending_suggestion: null } : l))
    // If the user picked a category via the "+ New category" inline input on
    // the item's popover, add it to the sidebar. Only sidebar entries count as
    // user-defined categories, so this is the one place client-side we
    // intentionally create one — driven by explicit user choice.
    if (!categories.includes(category)) handleAddCategory(category)
  }

  const handleAddCategory = (name: string, description?: string) => {
    const updated = [...new Set([...categories, name])]
    setCategories(updated)
    saveCategories(updated)
    if (description !== undefined) saveCategoryDescription(name, description)
  }

  const handleDeleteCategory = (name: string) => {
    mutate(prev => ({
      links: prev.links.map(l => l.category === name ? { ...l, category: null } : l),
      categories: prev.categories.filter(c => c !== name),
    }))
    deleteCategoryDescription(name)
    if (view === `cat:${name}`) setView('library')
  }

  const handleDeleteItem = (id: string) => {
    cancelReminderNative(id)
    mutateLinks(prev => prev.filter(l => l.id !== id))
  }

  const handleDeleteItems = (ids: string[]) => {
    if (ids.length === 0) return
    ids.forEach(id => cancelReminderNative(id))
    const set = new Set(ids)
    mutateLinks(prev => prev.filter(l => !set.has(l.id)))
  }

  // Split an item at the cursor. `before` stays in the original row, `after`
  // becomes a brand-new row inserted right after it. The undo snapshot stores
  // the user's *typed* text (before + after), so Cmd+Z restores what they had
  // on screen, not the last-committed title.
  const handleSplitItem = (id: string, before: string, after: string, newId: string) => {
    const original = links.find(l => l.id === id)
    if (!original) return
    const originalText = before + after
    const prevSnap: Snapshot = {
      links: links.map(l => l.id === id ? { ...l, title: originalText } : l),
      categories,
    }
    const newItem: LinkRow = {
      id: newId,
      url: '',
      title: after,
      note: null,
      category: original.category,
      label: null,
      read_time_minutes: null,
      intent: null,
      is_done: false,
      ai_processed: !!original.category,
      created_at: new Date().toISOString(),
      item_type: 'note',
    }
    const nextLinks = links.flatMap(l => l.id === id ? [{ ...l, title: before }, newItem] : [l])
    setUndoStack(stack => [...stack.slice(-(UNDO_LIMIT - 1)), prevSnap])
    setLinks(nextLinks); saveLinks(nextLinks)
  }

  // Merge `fromId` into `intoId`. `intoText` and `fromText` are the live input
  // values at the moment Backspace was pressed — used both to compute the
  // merged result and to reconstruct the pre-merge state for undo.
  const handleMergeItems = (intoId: string, fromId: string, intoText: string, fromText: string) => {
    const intoLink = links.find(l => l.id === intoId)
    const fromLink = links.find(l => l.id === fromId)
    if (!intoLink || !fromLink) return
    const prevSnap: Snapshot = {
      links: links.map(l => {
        if (l.id === intoId) return { ...l, title: intoText }
        if (l.id === fromId) return { ...l, title: fromText }
        return l
      }),
      categories,
    }
    const merged = intoText + fromText
    const nextLinks = links
      .map(l => l.id === intoId ? { ...l, title: merged } : l)
      .filter(l => l.id !== fromId)
    setUndoStack(stack => [...stack.slice(-(UNDO_LIMIT - 1)), prevSnap])
    setLinks(nextLinks); saveLinks(nextLinks)
  }

  const handleNavigate = (newView: string) => {
    setView(newView)
    setSearch('')
  }

  if (IS_SPOTLIGHT) {
    return <SpotlightBar onSave={handleSave} />
  }

  return (
    <>
      <LibraryPage
        links={links}
        categories={allCategories}
        activeView={view}
        search={search}
        onNavigate={handleNavigate}
        onAddCategory={handleAddCategory}
        onDeleteCategory={handleDeleteCategory}
        onDone={handleDone}
        onSearchChange={setSearch}
        onCategoryChange={handleCategoryChange}
        onUpdateItem={handleUpdateItem}
        onAddItem={handleSave}
        onDeleteItem={handleDeleteItem}
        onDeleteItems={handleDeleteItems}
        onSplitItem={handleSplitItem}
        onMergeItems={handleMergeItems}
        onAcceptSuggestion={handleAcceptSuggestion}
        onRejectSuggestion={handleRejectSuggestion}
        onSetReminder={handleSetReminder}
        onClearReminder={handleClearReminder}
        openLoopsCount={openLoopsCount}
        openLoops={openLoops}
        onAcceptOpenLoop={handleAcceptOpenLoop}
        onRejectOpenLoop={handleRejectOpenLoop}
        showOpenLoopsNudge={openLoopsCount > 0 && !nudgeDismissed}
        onDismissOpenLoopsNudge={dismissNudge}
      />
      {showOnboarding && <Onboarding onDone={() => setShowOnboarding(false)} />}
    </>
  )
}
