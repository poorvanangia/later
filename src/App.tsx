import { useState, useEffect } from 'react'
import { LibraryPage } from './components/LibraryPage'
import { SpotlightBar } from './components/SpotlightBar'

const WINDOW_LABEL = (window as any).__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? ''
const IS_SPOTLIGHT = WINDOW_LABEL === 'main'

const SEED_CATEGORIES = ['Articles', 'Cooking', 'Travel', 'Shopping', 'Videos', 'Research', 'Work', 'Health', 'Finance', 'Entertainment', 'News']
const UNDO_LIMIT = 20

export type ItemType = 'link' | 'note' | 'pdf'

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
}

function loadCategories(): string[] {
  try {
    const stored = localStorage.getItem('later:categories')
    if (stored) return JSON.parse(stored)
    saveCategories(SEED_CATEGORIES)
    return SEED_CATEGORIES
  } catch { return SEED_CATEGORIES }
}

function saveCategories(cats: string[]) {
  localStorage.setItem('later:categories', JSON.stringify(cats))
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
  const [, setUndoStack] = useState<LinkRow[][]>([])

  const aiCategories = [...new Set(links.map(l => l.category).filter(Boolean) as string[])]
  const allCategories = [...new Set([...categories, ...aiCategories])]

  // Generic mutator — pushes the PREVIOUS state onto the undo stack, then applies the update.
  // User-initiated actions (add, edit, done, category change, delete) go through this.
  const mutateLinks = (updater: (prev: LinkRow[]) => LinkRow[]) => {
    setLinks(prev => {
      const updated = updater(prev)
      setUndoStack(stack => [...stack.slice(-(UNDO_LIMIT - 1)), prev])
      saveLinks(updated)
      return updated
    })
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

  useEffect(() => {
    const handler = () => {
      setLinks(loadLinks())
      setCategories(loadCategories())
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [])

  // Global Cmd+Z — undo the last user action
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea') return
      if (e.metaKey && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        setUndoStack(stack => {
          if (stack.length === 0) return stack
          const last = stack[stack.length - 1]
          setLinks(last)
          saveLinks(last)
          return stack.slice(0, -1)
        })
      }
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
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const category = await invoke<string>('classify_item', { text })
      const finalCategory = category && category.trim().length > 0 ? category.trim() : 'Other'
      applyBackgroundUpdate(prev => prev.map(l => l.id === id ? { ...l, category: finalCategory, ai_processed: true } : l))
      if (!allCategories.includes(finalCategory)) handleAddCategory(finalCategory)
    } catch {
      // Network/API failure — still assign a category so nothing is left blank
      applyBackgroundUpdate(prev => prev.map(l => l.id === id ? { ...l, category: 'Other', ai_processed: true } : l))
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
    const updated = categories.filter(c => c !== name)
    setCategories(updated)
    saveCategories(updated)
    mutateLinks(prev => prev.map(l => l.category === name ? { ...l, category: null } : l))
    if (view === `cat:${name}`) setView('library')
  }

  const handleDeleteItem = (id: string) => {
    mutateLinks(prev => prev.filter(l => l.id !== id))
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
    />
  )
}
