import { useState, useEffect } from 'react'
import { TrayPopup } from './components/TrayPopup'

const SEED_CATEGORIES = ['Articles', 'Cooking', 'Travel', 'Shopping', 'Videos', 'Research', 'Work', 'Health', 'Finance', 'Entertainment', 'News']

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
    const links = stored ? JSON.parse(stored) : []
    const normalized = normalizeStoredLinks(links)
    if (stored && JSON.stringify(links) !== JSON.stringify(normalized)) saveLinks(normalized)
    return normalized
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

function isPlainUrl(text: string): boolean {
  if (/\s/.test(text)) return false
  try {
    const url = text.startsWith('http://') || text.startsWith('https://') ? text : `https://${text}`
    const parsed = new URL(url)
    return Boolean(parsed.hostname.includes('.'))
  } catch { return false }
}

function detectType(text: string): ItemType {
  if (isPlainUrl(text) && text.toLowerCase().endsWith('.pdf')) return 'pdf'
  if (isPlainUrl(text)) return 'link'
  return 'note'
}

function fallbackTitle(text: string): string {
  const firstUsefulLine = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.length > 0 && !isPlainUrl(line))
  const source = firstUsefulLine || text.trim()
  const words = source.replace(/\s+/g, ' ').split(' ').filter(Boolean)
  return words.slice(0, 10).join(' ').replace(/[.,;:!?-]+$/, '')
}

function formatLongText(text: string): string {
  const cleaned = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (cleaned.includes('\n\n')) return cleaned

  const lines = cleaned.split('\n').map(line => line.trim()).filter(Boolean)
  const hasMeaningfulLineBreaks = lines.length > 1 && lines.some(line => line.length > 80)
  const source = hasMeaningfulLineBreaks ? lines.join('\n\n') : lines.join(' ')
  if (source.includes('\n\n')) return source

  const sentences = source.match(/[^.!?]+[.!?]+["')\]]?|[^.!?]+$/g)
    ?.map(sentence => sentence.trim())
    .filter(Boolean) || [source]

  const paragraphs: string[] = []
  let current = ''

  sentences.forEach((sentence) => {
    const next = current ? `${current} ${sentence}` : sentence
    if (current && next.length > 360) {
      paragraphs.push(current)
      current = sentence
    } else {
      current = next
    }
  })

  if (current) paragraphs.push(current)
  return paragraphs.join('\n\n')
}

function normalizeStoredLinks(links: LinkRow[]): LinkRow[] {
  return links.map((link) => {
    const urlContainsLongText = link.item_type !== 'note' && /\s/.test(link.url) && link.url.length > 100
    const rawNote = link.note || (urlContainsLongText ? link.url : null)
    const note = rawNote && rawNote.length > 100 ? formatLongText(rawNote) : rawNote
    const needsShortTitle = Boolean(note && note.length > 100 && (!link.title || link.title === note || link.title.length > 100))

    if (urlContainsLongText || needsShortTitle || note !== rawNote) {
      return {
        ...link,
        url: urlContainsLongText ? '' : link.url,
        item_type: urlContainsLongText ? 'note' : link.item_type,
        note,
        title: needsShortTitle || urlContainsLongText ? fallbackTitle(note || link.url) : link.title,
      }
    }

    return link
  })
}

export function PopupApp() {
  const [links, setLinks] = useState<LinkRow[]>(loadLinks)
  const [categories, setCategories] = useState<string[]>(loadCategories)

  const aiCategories = [...new Set(links.map(l => l.category).filter(Boolean) as string[])]
  const allCategories = [...new Set([...categories, ...aiCategories])]

  // Sync when other windows update localStorage
  useEffect(() => {
    const handler = () => {
      setLinks(loadLinks())
      setCategories(loadCategories())
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [])

  const fetchTitle = async (id: string, url: string) => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const title = await invoke<string>('fetch_title', { url })
      if (title && title.length > 0) {
        setLinks((prev) => {
          const updated = prev.map((l) => l.id === id ? { ...l, title } : l)
          saveLinks(updated)
          return updated
        })
        classifyItem(id, title)
      }
    } catch { }
  }

  const classifyItem = async (id: string, text: string) => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const category = await invoke<string>('classify_item', { text })
      if (category && category.length > 0) {
        setLinks((prev) => {
          const updated = prev.map((l) => l.id === id ? { ...l, category, ai_processed: true } : l)
          saveLinks(updated)
          return updated
        })
        if (!allCategories.includes(category)) {
          handleAddCategory(category)
        }
      }
    } catch { }
  }

  const titleLongItem = async (id: string, text: string) => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const title = await invoke<string>('generate_title', { text })
      const cleanTitle = title?.trim() || fallbackTitle(text)
      setLinks((prev) => {
        const updated = prev.map((l) => l.id === id ? { ...l, title: cleanTitle } : l)
        saveLinks(updated)
        return updated
      })
    } catch {
      setLinks((prev) => {
        const updated = prev.map((l) => l.id === id ? { ...l, title: fallbackTitle(text) } : l)
        saveLinks(updated)
        return updated
      })
    }
  }

  const handleSave = (text: string) => {
    const trimmed = text.trim()
    const type = detectType(trimmed)
    const isUrl = type === 'link' || type === 'pdf'
    const isLongNote = type === 'note' && trimmed.length > 100
    const noteText = isLongNote ? formatLongText(trimmed) : trimmed
    const url = isUrl && !trimmed.startsWith('http') ? `https://${trimmed}` : trimmed
    const domain = isUrl ? (() => { try { return new URL(url).hostname.replace('www.', '') } catch { return url } })() : null

    const newLink: LinkRow = {
      id: `link-${Date.now()}`,
      url,
      title: type === 'note' ? (isLongNote ? fallbackTitle(noteText) : trimmed) : domain,
      note: type === 'note' ? noteText : null,
      category: null,
      label: null,
      read_time_minutes: null,
      intent: null,
      is_done: false,
      ai_processed: false,
      created_at: new Date().toISOString(),
      item_type: type,
    }

    setLinks((prev) => {
      const updated = [newLink, ...prev]
      saveLinks(updated)
      return updated
    })

    if (isUrl) {
      setTimeout(() => fetchTitle(newLink.id, url), 100)
    } else if (isLongNote) {
      setTimeout(() => titleLongItem(newLink.id, noteText), 100)
      setTimeout(() => classifyItem(newLink.id, noteText), 100)
    } else {
      setTimeout(() => classifyItem(newLink.id, trimmed), 100)
    }
  }

  const handleDone = (id: string) => {
    setLinks((prev) => {
      const updated = prev.map((l) => l.id === id ? { ...l, is_done: !l.is_done } : l)
      saveLinks(updated)
      return updated
    })
  }

  const handleCategoryChange = (id: string, category: string) => {
    setLinks((prev) => {
      const updated = prev.map((l) => l.id === id ? { ...l, category } : l)
      saveLinks(updated)
      return updated
    })
    if (!allCategories.includes(category)) handleAddCategory(category)
  }

  const handleAddCategory = (name: string) => {
    const updated = [...new Set([...categories, name])]
    setCategories(updated)
    saveCategories(updated)
  }

  return (
    <TrayPopup
      links={links}
      categories={allCategories}
      onSave={handleSave}
      onDone={handleDone}
      onCategoryChange={handleCategoryChange}
      onAddCategory={handleAddCategory}
      isSignedIn={true}
      onSignIn={() => {}}
    />
  )
}
