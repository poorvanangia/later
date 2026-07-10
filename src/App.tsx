import { useState, useEffect } from 'react'
import { LibraryPage } from './components/LibraryPage'
import { SpotlightBar } from './components/SpotlightBar'

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
  const [, setUndoStack] = useState<Snapshot[]>([])

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

  // Reload from localStorage on storage event (other browser tabs) OR Tauri
  // event (other Tauri windows in this same app).
  useEffect(() => {
    const reload = () => {
      console.log('[later] sync: reloading from localStorage')
      setLinks(loadLinks())
      setCategories(loadCategories())
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

  const classifyItem = async (id: string, text: string) => {
    console.log('[later] classifyItem start', { id, text: text.slice(0, 60) })
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const raw = await invoke<string>('classify_item', { text, existingCategories: allCategories })
      console.log('[later] classifyItem response', { id, raw })
      const cleaned = (raw || '').trim().replace(/^["']|["']$/g, '').replace(/[.,;:!?]+$/, '').trim()
      const generic = /^(other|misc|miscellaneous|uncategori[sz]ed|general|unknown)$/i
      if (!cleaned || generic.test(cleaned)) {
        // Empty response = backend silently failed (likely API error). Mark as
        // processed but leave category null; surface as "AI failed" in UI.
        console.warn('[later] classifyItem: empty or generic response — backend likely errored (see Rust stderr)')
        applyBackgroundUpdate(prev => prev.map(l => l.id === id ? { ...l, ai_processed: true } : l))
        return
      }
      applyBackgroundUpdate(prev => prev.map(l => l.id === id ? { ...l, category: cleaned, ai_processed: true } : l))
      if (!allCategories.includes(cleaned)) handleAddCategory(cleaned)
    } catch (err) {
      console.error('[later] classifyItem invoke threw', err)
      applyBackgroundUpdate(prev => prev.map(l => l.id === id ? { ...l, ai_processed: true } : l))
    }
  }

  const summariseItem = async (id: string, text: string) => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const summary = await invoke<string>('classify_item', {
        text: `Summarise this in 6 words or less as a title: ${text.slice(0, 500)}`
      })
      if (summary && summary.length > 0) {
        applyBackgroundUpdate(prev => prev.map(l => l.id === id ? { ...l, title: summary } : l))
      }
    } catch { }
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
    mutateLinks(prev => prev.map(l => l.id === id ? { ...l, category } : l))
    if (!allCategories.includes(category)) handleAddCategory(category)
  }

  const handleAddCategory = (name: string) => {
    const updated = [...new Set([...categories, name])]
    setCategories(updated)
    saveCategories(updated)
  }

  const handleDeleteCategory = (name: string) => {
    mutate(prev => ({
      links: prev.links.map(l => l.category === name ? { ...l, category: null } : l),
      categories: prev.categories.filter(c => c !== name),
    }))
    if (view === `cat:${name}`) setView('library')
  }

  const handleDeleteItem = (id: string) => {
    mutateLinks(prev => prev.filter(l => l.id !== id))
  }

  const handleDeleteItems = (ids: string[]) => {
    if (ids.length === 0) return
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
    />
  )
}
