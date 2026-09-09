import { useState, useEffect } from 'react'
import { TrayPopup } from './components/TrayPopup'
import { Onboarding } from './components/Onboarding'
import {
  loadCategoryDescriptions,
  saveCategoryDescription,
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

const SYNC_EVENT = 'later://state-changed'

// See App.tsx for rationale — serialize classifications so pending_new_names
// converge across rapid entry.
let classifyChain: Promise<void> = Promise.resolve()

async function broadcastChange() {
  try {
    const { emit } = await import('@tauri-apps/api/event')
    await emit(SYNC_EVENT)
  } catch { }
}

// Legacy seed names from v0.1.7 and earlier — never a design goal, just
// pre-population that leaked through onto every new install. Kept only for the
// one-time purge in loadCategories(); do not re-seed.
const LEGACY_SEED_CATEGORIES = ['Articles', 'Cooking', 'Travel', 'Shopping', 'Videos', 'Research', 'Work', 'Health', 'Finance', 'Entertainment', 'News']

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
  pending_suggestion?: PendingSuggestion | null
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
  const [showOnboarding, setShowOnboarding] = useState(() => {
    try { return !localStorage.getItem('later:onboardingComplete') } catch { return false }
  })

  const aiCategories = [...new Set(links.map(l => l.category).filter(Boolean) as string[])]
  const allCategories = [...new Set([...categories, ...aiCategories])]

  // Prune pending-new-category queue on mount so deleted items don't keep a
  // stale suggestion alive.
  useEffect(() => {
    pruneQueue(new Set(links.map(l => l.id)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Sync when other windows update localStorage. Storage events are flaky in
  // Tauri WKWebView so we also listen for a Tauri event.
  useEffect(() => {
    const reload = () => {
      console.log('[later/popup] sync: reloading from localStorage')
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

  const classifyItem = (id: string, text: string): Promise<void> => {
    classifyChain = classifyChain.then(() => classifyItemImpl(id, text)).catch(() => {})
    return classifyChain
  }

  const applyLinksHelper = (fn: (l: LinkRow) => LinkRow) => setLinks(prev => {
    const updated = prev.map(fn)
    saveLinks(updated)
    return updated
  })

  const classifyItemImpl = async (id: string, text: string) => {
    console.log('[later/popup] classifyItem start', { id, text: text.slice(0, 60) })
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const result = await invoke<ClassifyResponse>('classify_item', {
        text,
        existingCategories: categories,
        categoryDescriptions: loadCategoryDescriptions(),
        pendingNewNames: loadPendingNewNames(),
        userProfile: loadUserProfileText(),
      })
      console.log('[later/popup] classifyItem response', { id, result })

      if (result.decision === 'assign' && result.category) {
        applyLinksHelper(l => l.id === id ? { ...l, category: result.category, ai_processed: true, pending_suggestion: null } : l)
        return
      }

      // Non-confident → placeholder chip + reasoning second pass.
      if ((result.decision === 'suggest_existing' || result.decision === 'suggest_new') && result.category) {
        const fallbackKind = result.decision === 'suggest_existing' ? 'existing' as const : 'new' as const
        applyLinksHelper(l => l.id === id
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
          : l)
        reasoningReclassify(id, text, {
          category: result.category,
          kind: fallbackKind,
          description: result.description,
          reason: result.reason,
        }).catch(err => console.error('[later/popup] reasoning pass threw', err))
        return
      }

      // decision === 'none'
      applyLinksHelper(l => l.id === id ? { ...l, ai_processed: true } : l)
    } catch (err) {
      console.error('[later/popup] classifyItem invoke threw', err)
      setLinks(prev => {
        const updated = prev.map(l => l.id === id ? { ...l, ai_processed: true } : l)
        saveLinks(updated)
        return updated
      })
    }
  }

  const applyClassifyVerdict = (originId: string, result: ClassifyResponse) => {
    if (result.decision === 'assign' && result.category) {
      applyLinksHelper(l => l.id === originId ? { ...l, category: result.category, pending_suggestion: null } : l)
      return
    }
    if (result.decision === 'suggest_existing' && result.category) {
      applyLinksHelper(l => l.id === originId
        ? { ...l, category: null, pending_suggestion: { kind: 'existing', category: result.category, reason: result.reason } }
        : l)
      return
    }
    if (result.decision === 'suggest_new' && result.category) {
      const { surfaceNow, linkIdsToUpdate, description } = enqueueSuggestNew(originId, result.category, result.description)
      const idSet = new Set([originId, ...linkIdsToUpdate])
      applyLinksHelper(l => {
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
      })
      return
    }
    applyLinksHelper(l => l.id === originId ? { ...l, pending_suggestion: null } : l)
  }

  const reasoningReclassify = async (
    id: string,
    text: string,
    fallback: { category: string; kind: 'existing' | 'new'; description: string; reason: string },
  ): Promise<void> => {
    console.log('[later/popup] reclassify start', { id, text: text.slice(0, 60) })
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const result = await invoke<ClassifyResponse>('reclassify_item', {
        text,
        existingCategories: categories,
        categoryDescriptions: loadCategoryDescriptions(),
        pendingNewNames: loadPendingNewNames(),
        userProfile: loadUserProfileText(),
      })
      console.log('[later/popup] reclassify response', { id, result })
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
      console.error('[later/popup] reclassify_item invoke threw', err)
      applyClassifyVerdict(id, {
        decision: fallback.kind === 'existing' ? 'suggest_existing' : 'suggest_new',
        category: fallback.category,
        description: fallback.description,
        reason: fallback.reason,
      })
    }
  }

  const handleAcceptSuggestion = (id: string) => {
    const link = links.find(l => l.id === id)
    if (!link?.pending_suggestion) return
    const sugg = link.pending_suggestion
    if (sugg.kind === 'reasoning') return
    const applyLinks = (fn: (l: LinkRow) => LinkRow) => setLinks(prev => {
      const updated = prev.map(fn); saveLinks(updated); return updated
    })
    if (sugg.kind === 'existing') {
      applyLinks(l => l.id === id ? { ...l, category: sugg.category, pending_suggestion: null } : l)
      return
    }
    const { linkIds, description } = acceptPendingNew(sugg.category)
    const idSet = new Set(linkIds.length > 0 ? linkIds : [id])
    if (!categories.includes(sugg.category)) {
      const updatedCats = [...new Set([...categories, sugg.category])]
      setCategories(updatedCats)
      saveCategories(updatedCats)
      saveCategoryDescription(sugg.category, description || sugg.description)
    }
    applyLinks(l => idSet.has(l.id) ? { ...l, category: sugg.category, pending_suggestion: null } : l)
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
    setLinks(prev => {
      const updated = prev.map(l => l.id === id ? { ...l, pending_suggestion: null } : l)
      saveLinks(updated)
      return updated
    })
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
      const updated = prev.map((l) => l.id === id ? { ...l, category, pending_suggestion: null } : l)
      saveLinks(updated)
      return updated
    })
    // Explicit user pick from the item's menu — user is choosing to create a
    // new category via the inline "+ New" affordance. Only sidebar entries
    // count as user categories, so this is the sanctioned path to create one.
    if (!categories.includes(category)) handleAddCategory(category)
  }

  const handleAddCategory = (name: string, description?: string) => {
    const updated = [...new Set([...categories, name])]
    setCategories(updated)
    saveCategories(updated)
    if (description !== undefined) saveCategoryDescription(name, description)
  }

  return (
    <>
      <TrayPopup
        links={links}
        categories={allCategories}
        onSave={handleSave}
        onDone={handleDone}
        onCategoryChange={handleCategoryChange}
        onAddCategory={handleAddCategory}
        onAcceptSuggestion={handleAcceptSuggestion}
        onRejectSuggestion={handleRejectSuggestion}
        isSignedIn={true}
        onSignIn={() => {}}
      />
      {showOnboarding && <Onboarding onDone={() => setShowOnboarding(false)} />}
    </>
  )
}
