import { useState, useRef, useEffect } from 'react'
import type { LinkRow } from '../App'
import { PendingSuggestionChip } from './PendingSuggestionChip'
import { loadCategoryDescriptions, saveCategoryDescription } from '../lib/classifier'
import { isCmdKHintVisible } from '../lib/hints'
import { ReminderPopover } from './ReminderPopover'
import { formatReminderLabel, formatAcknowledgedAgo, getReminderState } from '../lib/reminders'
import { SettingsPage } from './SettingsPage'

// Bell icon — matches LinkRow's TagIcon convention: 11×11 render, 12×12
// viewBox, 1.4 stroke, rounded caps, color inherited via currentColor.
// `filled` swaps the stroke-only outline for a solid glyph, used to shout
// "unacknowledged / overdue" without adding red.
const BellIcon = ({ filled = false }: { filled?: boolean }) => (
  <svg width="11" height="11" viewBox="0 0 12 12" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 1.5v.75" />
    <path d="M2.5 9.25V6a3.5 3.5 0 0 1 7 0v3.25" />
    <path d="M1.5 9.25h9" />
    <path d="M4.75 10.5a1.25 1.25 0 0 0 2.5 0" />
  </svg>
)

function getDomain(url: string): string {
  try { return new URL(url).hostname.replace('www.', '') }
  catch { return '' }
}

function isLongItem(link: LinkRow): boolean {
  const text = link.note || link.title || ''
  return text.length > 100
}

type Props = {
  links: LinkRow[]
  categories: string[]
  activeView: string
  search: string
  onNavigate: (view: string) => void
  onAddCategory: (name: string, description?: string) => void
  onDone: (id: string) => void
  onSearchChange: (q: string) => void
  onCategoryChange: (id: string, category: string) => void
  onDeleteCategory?: (name: string) => void
  onUpdateItem?: (id: string, updates: Partial<LinkRow>) => void
  onAddItem?: (text: string, category?: string) => void
  onDeleteItem?: (id: string) => void
  onDeleteItems?: (ids: string[]) => void
  onSplitItem?: (id: string, before: string, after: string, newId: string) => void
  onMergeItems?: (intoId: string, fromId: string, intoText: string, fromText: string) => void
  onAcceptSuggestion?: (id: string) => void
  onRejectSuggestion?: (id: string) => void
  onSetReminder?: (id: string, remindAtIso: string) => void
  onClearReminder?: (id: string) => void
}

export function LibraryPage({
  links, categories, activeView, search,
  onNavigate, onAddCategory, onDone, onSearchChange, onCategoryChange,
  onDeleteCategory, onUpdateItem, onAddItem, onDeleteItem,
  onDeleteItems, onSplitItem, onMergeItems,
  onAcceptSuggestion, onRejectSuggestion,
  onSetReminder, onClearReminder,
}: Props) {
  const [reminderOpenId, setReminderOpenId] = useState<string | null>(null)
  const [addingCat, setAddingCat] = useState(false)
  const [newCatName, setNewCatName] = useState('')
  const [newCatDescription, setNewCatDescription] = useState('')
  const [editingCat, setEditingCat] = useState<string | null>(null)
  const [editingCatValue, setEditingCatValue] = useState('')
  const [editingCatDescription, setEditingCatDescription] = useState('')
  const [categoryDescriptions, setCategoryDescriptions] = useState<Record<string, string>>(() => loadCategoryDescriptions())
  const [newLineValue, setNewLineValue] = useState('')
  const [openDropdownId, setOpenDropdownId] = useState<string | null>(null)
  const [addingCatInline, setAddingCatInline] = useState(false)
  const [inlineCatValue, setInlineCatValue] = useState('')
  const [hoveredItemId, setHoveredItemId] = useState<string | null>(null)
  const [hoveredCat, setHoveredCat] = useState<string | null>(null)
  const [selectedItem, setSelectedItem] = useState<LinkRow | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [lastIndex, setLastIndex] = useState<number | null>(null)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [showWelcome, setShowWelcome] = useState(() => !localStorage.getItem('later:welcomeDone'))
  const newLineRef = useRef<HTMLInputElement>(null)
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({})
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Re-read descriptions when categories change — covers the case where
  // handleAcceptSuggestion in App.tsx wrote a new description via localStorage
  // while a suggest_new chip was confirmed.
  useEffect(() => {
    setCategoryDescriptions(loadCategoryDescriptions())
  }, [categories])

  // Cmd+K hint visibility: subtle bottom-right pill shown until the user has
  // pressed Cmd+K enough times (threshold = 7) to have muscle memory.
  // Re-reads on links change so it disappears after the same SYNC_EVENT that
  // spotlight fires when the counter bumps.
  const [showCmdKHint, setShowCmdKHint] = useState<boolean>(() => isCmdKHintVisible())
  useEffect(() => {
    setShowCmdKHint(isCmdKHintVisible())
  }, [links])

  const filtered = links.filter((l) => {
    const matchesView =
      activeView === 'library' ||
      activeView === 'home' ||
      (activeView.startsWith('cat:') && l.category === activeView.slice(4))
    const q = search.toLowerCase()
    const matchesSearch = !q ||
      (l.title ?? '').toLowerCase().includes(q) ||
      (l.note ?? '').toLowerCase().includes(q) ||
      (l.category ?? '').toLowerCase().includes(q) ||
      l.url.toLowerCase().includes(q)
    return matchesView && matchesSearch
  })

  const undone = filtered.filter(l => !l.is_done)
  const done = filtered.filter(l => l.is_done)
  const sorted = [...undone, ...done]

  // Open-item counts per category, for the sidebar badges
  const categoryCounts: Record<string, number> = {}
  for (const link of links) {
    if (link.is_done) continue
    if (link.category) categoryCounts[link.category] = (categoryCounts[link.category] || 0) + 1
  }

  const getPageTitle = () => {
    if (activeView === 'library') return 'Home'
    if (activeView.startsWith('cat:')) return activeView.slice(4)
    return 'Items'
  }

  // Close category dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpenDropdownId(null)
        setAddingCatInline(false)
        setInlineCatValue('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Window-level shortcuts that only apply when no input is focused.
  // Per-row arrow-key navigation lives on each input's onKeyDown.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || '').toLowerCase()
      const isInputFocused = tag === 'input' || tag === 'textarea'

      // Cmd+A — select every visible item (Apple Notes style)
      if (!isInputFocused && e.metaKey && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        setSelectedIds(new Set(sorted.map(l => l.id)))
        setLastIndex(sorted.length - 1)
        return
      }

      // Cmd+C — copy selected item titles
      if (!isInputFocused && e.metaKey && e.key.toLowerCase() === 'c' && selectedIds.size > 0) {
        e.preventDefault()
        const text = sorted.filter(l => selectedIds.has(l.id)).map(l => l.title || l.url).join('\n')
        navigator.clipboard?.writeText(text).catch(() => {})
        return
      }

      // Cmd+Delete / Cmd+Backspace — wipe every currently visible item.
      // One atomic undo step; ⌘Z restores the whole list.
      if (!isInputFocused && e.metaKey && (e.key === 'Backspace' || e.key === 'Delete')) {
        if (sorted.length === 0) return
        e.preventDefault()
        const ids = sorted.map(l => l.id)
        if (onDeleteItems) onDeleteItems(ids)
        else if (onDeleteItem) ids.forEach(id => onDeleteItem(id))
        setSelectedIds(new Set())
        setLastIndex(null)
        setTimeout(() => newLineRef.current?.focus(), 60)
        return
      }

      // Backspace/Delete — bulk-delete the multi-selected items, then auto-focus the next survivor.
      // Goes through onDeleteItems (atomic) so the entire batch is ONE undo step.
      if (!isInputFocused && (e.key === 'Backspace' || e.key === 'Delete') && selectedIds.size > 0) {
        e.preventDefault()
        const selectedIndices = sorted.map((l, i) => selectedIds.has(l.id) ? i : -1).filter(i => i >= 0)
        const firstIdx = selectedIndices.length > 0 ? Math.min(...selectedIndices) : 0
        const survivors = sorted.filter(l => !selectedIds.has(l.id))
        const nextFocusIdx = Math.min(firstIdx, survivors.length - 1)
        const targetId = nextFocusIdx >= 0 ? survivors[nextFocusIdx]?.id : null
        const idsToDelete = Array.from(selectedIds)
        if (onDeleteItems) onDeleteItems(idsToDelete)
        else if (onDeleteItem) idsToDelete.forEach(id => onDeleteItem(id))
        setSelectedIds(new Set())
        setLastIndex(null)
        setTimeout(() => {
          if (targetId) {
            const input = inputRefs.current[targetId]
            if (input) {
              input.focus()
              input.setSelectionRange(0, 0)
            }
          } else {
            newLineRef.current?.focus()
          }
        }, 60)
        return
      }

      // Cmd+Shift+ArrowDown/Up (from anywhere) OR plain Shift+ArrowDown/Up (only when
      // no input is focused, so we don't fight the native text-selection behaviour) —
      // extend (or initiate) the multi-select by one line. Mirrors Finder/Notes.
      const isMultiSelectExtend =
        (e.metaKey && e.shiftKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) ||
        (!isInputFocused && !e.metaKey && e.shiftKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp'))
      if (isMultiSelectExtend) {
        e.preventDefault()
        const dir = e.key === 'ArrowDown' ? 1 : -1

        // Figure out which row is currently focused (if any) so initiation lands on it.
        let focusedIdx = -1
        const activeEl = document.activeElement
        if (activeEl) {
          for (let i = 0; i < sorted.length; i++) {
            if (inputRefs.current[sorted[i].id] === activeEl) { focusedIdx = i; break }
          }
        }

        let head: number
        let anchor: number
        if (selectedIds.size === 0) {
          anchor = focusedIdx >= 0 ? focusedIdx : 0
          head = Math.max(0, Math.min(sorted.length - 1, anchor + dir))
        } else {
          const selIndices = sorted.map((l, i) => selectedIds.has(l.id) ? i : -1).filter(i => i >= 0)
          const topIdx = Math.min(...selIndices)
          const botIdx = Math.max(...selIndices)
          const currentHead = lastIndex !== null && (lastIndex === topIdx || lastIndex === botIdx) ? lastIndex : (dir > 0 ? botIdx : topIdx)
          anchor = currentHead === topIdx ? botIdx : topIdx
          const nextHead = currentHead + dir
          if (nextHead < 0 || nextHead >= sorted.length) {
            console.log('[multi-select] extend hit edge, no-op. head:', currentHead)
            return
          }
          head = nextHead
        }

        ;(document.activeElement as HTMLElement)?.blur()
        const s = Math.min(anchor, head), en = Math.max(anchor, head)
        const newIds = new Set(sorted.slice(s, en + 1).map(l => l.id))
        setSelectedIds(newIds)
        setLastIndex(head)
        console.log('[multi-select] extend dir:', dir, 'anchor:', anchor, 'head:', head, 'size:', newIds.size)
        return
      }

      // Plain ArrowUp/Down (no modifiers) while a multi-select is active → collapse
      // the selection to a single line: the line above the top edge (for ↑) or below
      // the bottom edge (for ↓). If size was already 1, just move it one line.
      if (!isInputFocused && !e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && selectedIds.size > 0) {
        e.preventDefault()
        const selIndices = sorted.map((l, i) => selectedIds.has(l.id) ? i : -1).filter(i => i >= 0)
        const topIdx = Math.min(...selIndices)
        const botIdx = Math.max(...selIndices)
        let targetIdx: number
        if (selectedIds.size > 1) {
          targetIdx = e.key === 'ArrowUp' ? topIdx - 1 : botIdx + 1
          if (targetIdx < 0 || targetIdx >= sorted.length) {
            targetIdx = e.key === 'ArrowUp' ? topIdx : botIdx
          }
        } else {
          const only = topIdx
          targetIdx = e.key === 'ArrowUp' ? only - 1 : only + 1
          if (targetIdx < 0 || targetIdx >= sorted.length) {
            console.log('[multi-select] plain arrow at list edge, no-op')
            return
          }
        }
        const newIds = new Set([sorted[targetIdx].id])
        setSelectedIds(newIds)
        setLastIndex(targetIdx)
        console.log('[multi-select] collapse key:', e.key, 'targetIdx:', targetIdx, 'size:', newIds.size)
        return
      }

      // Escape — clear selection
      if (e.key === 'Escape' && selectedIds.size > 0) {
        setSelectedIds(new Set())
        setLastIndex(null)
        return
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [selectedIds, sorted, lastIndex, onDeleteItem, onDeleteItems])

  // Move the text cursor into the input at row `idx`, preserving the source column
  // (clamped to the target row's length). The text-editor cross-line cursor behaviour.
  const moveCursorToItem = (idx: number, col: number) => {
    const targetLink = sorted[idx]
    if (!targetLink) return
    const input = inputRefs.current[targetLink.id]
    if (!input) return
    input.focus()
    const pos = Math.min(col, input.value.length)
    input.setSelectionRange(pos, pos)
  }

  // Apple-Notes-style commit: write whatever is in the local edit buffer back to
  // app state on blur, including empty strings. An empty row is a valid blank
  // checklist line and only goes away when the user deletes/merges it.
  const commitEdit = (id: string) => {
    setEdits(prev => {
      if (prev[id] === undefined) return prev
      const value = prev[id]
      // Backspacing a title to empty means the user wants the item gone.
      // Delete it outright instead of committing a blank row.
      if (value.trim() === '' && onDeleteItem) {
        onDeleteItem(id)
      } else if (onUpdateItem) {
        onUpdateItem(id, { title: value })
      }
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, link: LinkRow, index: number) => {
    // Cmd+Shift+ArrowUp/Down — multi-select. Suppress the native input behavior
    // (which would select text from cursor to start/end of the field) and let the
    // window-level handler do the row selection. preventDefault doesn't stop bubbling.
    if (e.metaKey && e.shiftKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      return
    }
    // Override native input Cmd+A → select all *items*, not the text in this input
    if (e.metaKey && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      setSelectedIds(new Set(sorted.map(l => l.id)))
      setLastIndex(sorted.length - 1)
      e.currentTarget.blur()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      const col = e.currentTarget.selectionStart ?? 0
      if (index >= sorted.length - 1) {
        const input = newLineRef.current
        if (input) {
          input.focus()
          const pos = Math.min(col, input.value.length)
          input.setSelectionRange(pos, pos)
        }
      } else {
        moveCursorToItem(index + 1, col)
      }
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (index === 0) return
      const col = e.currentTarget.selectionStart ?? 0
      moveCursorToItem(index - 1, col)
      return
    }
    // ArrowLeft at position 0 (plain — no shift/meta/alt) → end of previous row
    if (e.key === 'ArrowLeft' && !e.shiftKey && !e.metaKey && !e.altKey) {
      const pos = e.currentTarget.selectionStart ?? 0
      const end = e.currentTarget.selectionEnd ?? 0
      if (pos === 0 && end === 0 && index > 0) {
        e.preventDefault()
        const prevLink = sorted[index - 1]
        const input = inputRefs.current[prevLink.id]
        if (input) {
          input.focus()
          const len = input.value.length
          input.setSelectionRange(len, len)
        }
        return
      }
    }
    // ArrowRight at the end of the line → start of next row (or "New item…" input)
    if (e.key === 'ArrowRight' && !e.shiftKey && !e.metaKey && !e.altKey) {
      const pos = e.currentTarget.selectionStart ?? 0
      const end = e.currentTarget.selectionEnd ?? 0
      const len = e.currentTarget.value.length
      if (pos === len && end === len) {
        e.preventDefault()
        if (index < sorted.length - 1) {
          const nextLink = sorted[index + 1]
          const input = inputRefs.current[nextLink.id]
          if (input) { input.focus(); input.setSelectionRange(0, 0) }
        } else {
          const input = newLineRef.current
          if (input) { input.focus(); input.setSelectionRange(0, 0) }
        }
        return
      }
    }
    // Enter → split this item at the cursor. Text before stays here, text after
    // becomes a new row. Cursor lands at position 0 of the new row.
    if (e.key === 'Enter') {
      e.preventDefault()
      if (!onSplitItem) return
      const pos = e.currentTarget.selectionStart ?? 0
      const value = e.currentTarget.value
      const before = value.slice(0, pos)
      const after = value.slice(pos)
      const newId = `link-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      // Drop the local edit buffer so the input picks up the new committed title.
      setEdits(p => { const n = { ...p }; delete n[link.id]; return n })
      onSplitItem(link.id, before, after, newId)
      setTimeout(() => {
        const input = inputRefs.current[newId]
        if (input) { input.focus(); input.setSelectionRange(0, 0) }
      }, 60)
      return
    }
    if (e.key === 'Escape') {
      // Clear any active multi-selection, then just blur if nothing to clear.
      if (selectedIds.size > 0) {
        setSelectedIds(new Set())
        setLastIndex(null)
      }
      setEdits(p => { const n = { ...p }; delete n[link.id]; return n })
      e.currentTarget.blur()
      return
    }
    // Backspace — if cursor is at position 0 with no selection, merge into the
    // previous row. Empty rows fall into this case naturally (prev + "" = prev).
    if (e.key === 'Backspace') {
      const pos = e.currentTarget.selectionStart ?? 0
      const end = e.currentTarget.selectionEnd ?? 0
      if (pos !== end) return // let the browser delete the in-line selection
      if (pos === 0) {
        if (index === 0) {
          // No previous row to merge into — nothing happens.
          e.preventDefault()
          return
        }
        if (!onMergeItems) return
        e.preventDefault()
        const currentValue = e.currentTarget.value
        const prevLink = sorted[index - 1]
        const prevInputEl = inputRefs.current[prevLink.id]
        const prevValue = prevInputEl?.value ?? (edits[prevLink.id] ?? prevLink.title ?? '')
        const cursorTarget = prevValue.length
        setEdits(p => {
          const n = { ...p }
          delete n[link.id]
          delete n[prevLink.id]
          return n
        })
        onMergeItems(prevLink.id, link.id, prevValue, currentValue)
        setTimeout(() => {
          const input = inputRefs.current[prevLink.id]
          if (input) {
            input.focus()
            input.setSelectionRange(cursorTarget, cursorTarget)
          }
        }, 60)
        return
      }
      // pos > 0 → native single-character delete
    }
  }

  const handleRowMouseDown = (link: LinkRow, index: number, e: React.MouseEvent) => {
    if (e.metaKey) {
      e.preventDefault()
      ;(document.activeElement as HTMLElement)?.blur()
      setSelectedIds(prev => {
        const n = new Set(prev)
        if (n.has(link.id)) n.delete(link.id); else n.add(link.id)
        return n
      })
      setLastIndex(index)
      return
    }
    if (e.shiftKey && lastIndex !== null) {
      e.preventDefault()
      ;(document.activeElement as HTMLElement)?.blur()
      const s = Math.min(lastIndex, index), en = Math.max(lastIndex, index)
      setSelectedIds(prev => new Set([...prev, ...sorted.slice(s, en + 1).map(l => l.id)]))
      setLastIndex(index)
      return
    }
    // Plain click clears any active multi-selection; the input then focuses naturally
    // because the click on the row lands on the input element (flex:1 fills the row).
    if (selectedIds.size > 0) {
      setSelectedIds(new Set())
      setLastIndex(null)
    }
  }

  // New items inherit the current category if we're viewing one — AI only classifies
  // items added from "Home" where there's no obvious category yet.
  const submitNewLine = () => {
    const trimmed = newLineValue.trim()
    if (trimmed && onAddItem) {
      const forcedCategory = activeView.startsWith('cat:') ? activeView.slice(4) : undefined
      onAddItem(trimmed, forcedCategory)
    }
    setNewLineValue(''); setTimeout(() => newLineRef.current?.focus(), 50)
  }

  const toggleDone = (link: LinkRow) => {
    if (link.is_done) { if (onUpdateItem) onUpdateItem(link.id, { is_done: false }) }
    else { onDone(link.id) }
  }

  const submitNewCategory = () => {
    const t = newCatName.trim()
    const d = newCatDescription.trim()
    if (t) {
      onAddCategory(t, d)
      setCategoryDescriptions(prev => ({ ...prev, [t]: d }))
    }
    setNewCatName(''); setNewCatDescription(''); setAddingCat(false)
  }
  const startEditCat = (cat: string) => {
    setEditingCat(cat)
    setEditingCatValue(cat)
    setEditingCatDescription(categoryDescriptions[cat] ?? '')
  }
  const submitEditCat = () => {
    const t = editingCatValue.trim()
    const d = editingCatDescription.trim()
    if (t) {
      if (t !== editingCat) {
        links.forEach(l => { if (l.category === editingCat) onCategoryChange(l.id, t) })
        onAddCategory(t, d)
        if (activeView === `cat:${editingCat}`) onNavigate(`cat:${t}`)
        setCategoryDescriptions(prev => {
          const next = { ...prev }
          if (editingCat) delete next[editingCat]
          next[t] = d
          return next
        })
      } else {
        // Same name, description-only edit — persist directly without going
        // through onAddCategory (which would trigger the sidebar add path).
        saveCategoryDescription(t, d)
        setCategoryDescriptions(prev => ({ ...prev, [t]: d }))
      }
    }
    setEditingCat(null); setEditingCatValue(''); setEditingCatDescription('')
  }
  const submitInlineCat = (itemId: string) => {
    const t = inlineCatValue.trim()
    if (t) { onAddCategory(t); onCategoryChange(itemId, t) }
    setAddingCatInline(false); setInlineCatValue(''); setOpenDropdownId(null)
  }

  const dismissWelcome = () => {
    localStorage.setItem('later:welcomeDone', '1')
    setShowWelcome(false)
  }

  if (showWelcome) {
    return (
      <div style={{ display: 'flex', height: '100vh', background: '#fafaf9', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: '40px', maxWidth: 500 }}>
          <span style={{ fontSize: 44, fontWeight: 900, color: '#1a1a1a', fontFamily: "'Playfair Display', serif", letterSpacing: '-1.5px', marginBottom: 10 }}>
            Later<span style={{ color: '#2d8a4e' }}>.</span>
          </span>
          <span style={{ fontSize: 16, color: '#aaa', marginBottom: 56 }}>Save anything. Find it when it matters.</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 28, textAlign: 'left', width: '100%', marginBottom: 56 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
              <div style={{ flexShrink: 0, width: 80, textAlign: 'center', fontSize: 12, fontWeight: 600, color: '#666', background: '#f0f0ec', border: '1px solid #e0e0dc', borderRadius: 7, padding: '7px 8px' }}>⌘ K</div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 500, color: '#1a1a1a', marginBottom: 3 }}>Quick save from anywhere</div>
                <div style={{ fontSize: 13, color: '#999', lineHeight: '1.5' }}>Links, notes, tasks — press ⌘K from any app on your Mac.</div>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
              <div style={{ flexShrink: 0, width: 80, textAlign: 'center', fontSize: 12, fontWeight: 600, color: '#666', background: '#f0f0ec', border: '1px solid #e0e0dc', borderRadius: 7, padding: '7px 8px' }}>Menu bar</div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 500, color: '#1a1a1a', marginBottom: 3 }}>See your recent saves</div>
                <div style={{ fontSize: 13, color: '#999', lineHeight: '1.5' }}>Click the Later icon in your menu bar (top right) anytime.</div>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
              <div style={{ flexShrink: 0, width: 80, textAlign: 'center', fontSize: 12, fontWeight: 600, color: '#666', background: '#f0f0ec', border: '1px solid #e0e0dc', borderRadius: 7, padding: '7px 8px' }}>This vault</div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 500, color: '#1a1a1a', marginBottom: 3 }}>Everything, organised</div>
                <div style={{ fontSize: 13, color: '#999', lineHeight: '1.5' }}>AI sorts your saves into categories automatically.</div>
              </div>
            </div>
          </div>
          <button onClick={dismissWelcome} style={{ fontSize: 15, fontWeight: 500, color: '#fff', background: '#1a1a1a', border: 'none', borderRadius: 10, padding: '13px 40px', cursor: 'pointer', fontFamily: 'inherit' }}>Start saving</button>
        </div>
      </div>
    )
  }

  const sidebar = (
    <div style={{ width: 210, flexShrink: 0, background: '#f5f4f1', borderRight: '1px solid #e8e8e4', display: 'flex', flexDirection: 'column', padding: '20px 10px', overflowY: 'auto' }}>
      <div style={{ padding: '4px 12px', marginBottom: 20 }}>
        <span style={{ fontSize: 22, fontWeight: 900, color: '#1a1a1a', fontFamily: "'Playfair Display', serif", letterSpacing: '-0.3px' }}>Later<span style={{ color: '#2d8a4e' }}>.</span></span>
      </div>

      <button onClick={() => { onNavigate('library'); setSelectedItem(null); setSelectedIds(new Set()); setLastIndex(null) }} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 12px', fontSize: 17, marginBottom: 16, fontWeight: activeView === 'library' ? 600 : 500, color: '#1a1a1a', background: activeView === 'library' ? '#eeede9' : 'none', border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: "'Fraunces', serif" }}>Home</button>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 12px', marginBottom: 12 }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: '#9a9a94', fontFamily: "'Fraunces', serif" }}>Categories</span>
        <button onClick={() => setAddingCat(true)} style={{ width: 18, height: 18, borderRadius: 4, border: '1px solid #d8d8d4', background: 'none', cursor: 'pointer', fontSize: 14, color: '#aaa', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'inherit', padding: 0 }}>+</button>
      </div>
      {categories.map((cat) => {
        const active = activeView === `cat:${cat}`
        const count = categoryCounts[cat] || 0
        const catDescription = categoryDescriptions[cat]
        if (editingCat === cat) {
          return (
            <div
              key={cat}
              // Wrapper-level blur commits when focus leaves BOTH inputs
              // (name + description). Tabbing name → description doesn't
              // trigger a submit because the new focus target is still inside
              // this wrapper. Clicking anywhere outside the block dismisses.
              onBlur={e => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                  submitEditCat()
                }
              }}
              style={{ padding: '4px 4px', display: 'flex', flexDirection: 'column', gap: 4 }}
            >
              <input
                autoFocus
                value={editingCatValue}
                onChange={e => setEditingCatValue(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') submitEditCat()
                  if (e.key === 'Escape') { setEditingCat(null); setEditingCatValue(''); setEditingCatDescription('') }
                }}
                placeholder="Category name…"
                style={{ width: '100%', fontSize: 14, padding: '5px 8px', border: '1px solid #c8c8c4', borderRadius: 6, outline: 'none', background: '#fff', color: '#1a1a1a', fontFamily: 'inherit' }}
              />
              <textarea
                value={editingCatDescription}
                onChange={e => setEditingCatDescription(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitEditCat()
                  if (e.key === 'Escape') { setEditingCat(null); setEditingCatValue(''); setEditingCatDescription('') }
                }}
                placeholder="What belongs here? (optional)"
                rows={2}
                style={{ width: '100%', fontSize: 12, padding: '5px 8px', border: '1px solid #d8d8d4', borderRadius: 6, outline: 'none', background: '#fff', color: '#555', fontFamily: 'inherit', resize: 'none', lineHeight: '1.35' }}
              />
            </div>
          )
        }
        const isCatHovered = hoveredCat === cat
        return (<div
          key={cat}
          style={{ display: 'flex', alignItems: 'center', gap: 2, position: 'relative' }}
          onMouseEnter={() => setHoveredCat(cat)}
          onMouseLeave={() => setHoveredCat(null)}
        >
          <button
            onClick={() => { onNavigate(`cat:${cat}`); setSelectedItem(null); setSelectedIds(new Set()); setLastIndex(null) }}
            onDoubleClick={() => startEditCat(cat)}
            title={catDescription ? `${cat} — ${catDescription}\n\nDouble-click to edit` : `${cat}\n\nDouble-click to add a description`}
            style={{ flex: 1, textAlign: 'left', padding: '6px 12px', fontSize: 13, fontWeight: active ? 600 : 400, color: '#1a1a1a', background: active ? '#eeede9' : 'none', border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: "'Fraunces', serif", display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{cat}</span>
            {count > 0 && <span style={{ color: '#aaa', fontWeight: 400, fontSize: 13, flexShrink: 0 }}>{count}</span>}
          </button>
          {onDeleteCategory && isCatHovered && <button onClick={() => onDeleteCategory(cat)} title="Delete category" style={{ width: 20, height: 20, borderRadius: 4, border: 'none', background: 'none', cursor: 'pointer', color: '#ccc', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, flexShrink: 0 }} onMouseEnter={e => { e.currentTarget.style.color = '#e05c5c' }} onMouseLeave={e => { e.currentTarget.style.color = '#ccc' }}>×</button>}
        </div>)
      })}
      {addingCat && (
        <div
          onBlur={e => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              submitNewCategory()
            }
          }}
          style={{ padding: '4px 4px', display: 'flex', flexDirection: 'column', gap: 4 }}
        >
          <input
            autoFocus
            value={newCatName}
            onChange={e => setNewCatName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') submitNewCategory()
              if (e.key === 'Escape') { setAddingCat(false); setNewCatName(''); setNewCatDescription('') }
            }}
            placeholder="Category name…"
            style={{ width: '100%', fontSize: 13, padding: '5px 8px', border: '1px solid #d8d8d4', borderRadius: 6, outline: 'none', background: '#fff', color: '#1a1a1a', fontFamily: 'inherit' }}
          />
          <textarea
            value={newCatDescription}
            onChange={e => setNewCatDescription(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitNewCategory()
              if (e.key === 'Escape') { setAddingCat(false); setNewCatName(''); setNewCatDescription('') }
            }}
            placeholder="What belongs here? (optional)"
            rows={2}
            style={{ width: '100%', fontSize: 12, padding: '5px 8px', border: '1px solid #d8d8d4', borderRadius: 6, outline: 'none', background: '#fff', color: '#555', fontFamily: 'inherit', resize: 'none', lineHeight: '1.35' }}
          />
        </div>
      )}
      {/* Bottom-pinned settings link. Flex spacer above pushes it to the
          bottom of the sidebar column so main nav (Home + Categories) stays
          top-aligned as usual. */}
      <div style={{ flex: 1, minHeight: 12 }} />
      <button
        onClick={() => { onNavigate('settings'); setSelectedItem(null); setSelectedIds(new Set()); setLastIndex(null) }}
        style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', fontSize: 13, fontWeight: activeView === 'settings' ? 600 : 400, color: activeView === 'settings' ? '#1a1a1a' : '#8a8a86', background: activeView === 'settings' ? '#eeede9' : 'none', border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: "'Fraunces', serif" }}
      >
        Settings
      </button>
    </div>
  )

  const listPanel = (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: '48px 56px 24px' }}>
        <h1 style={{ fontSize: 28, fontWeight: 600, color: '#1a1a1a', letterSpacing: '-0.5px', marginBottom: 24, lineHeight: 1.2 }}>{getPageTitle()}</h1>
        <div style={{ maxWidth: 640 }}>
          {sorted.map((link, index) => {
            const isInSelection = selectedIds.has(link.id)
            const hideCategoryUI = selectedIds.size > 1
            const isHovered = hoveredItemId === link.id
            const dropdownOpen = openDropdownId === link.id
            const isLong = isLongItem(link)
            const value = edits[link.id] !== undefined ? edits[link.id] : (link.title ?? '')
            return (
              <div
                key={link.id}
                onMouseDown={e => handleRowMouseDown(link, index, e)}
                onMouseEnter={() => setHoveredItemId(link.id)}
                onMouseLeave={() => { if (!dropdownOpen) setHoveredItemId(null) }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  // Vertical padding removed so adjacent selected rows' inner
                  // cream blocks touch and merge into one continuous fill.
                  padding: '0 8px',
                  borderRadius: 6,
                  background: 'transparent',
                  transition: 'background 0.1s',
                  opacity: link.is_done ? 0.45 : 1,
                }}
              >
                <button
                  onMouseDown={e => e.stopPropagation()}
                  onClick={e => { if (e.metaKey || e.shiftKey) return; e.stopPropagation(); toggleDone(link) }}
                  style={{ width: 16, height: 16, borderRadius: '50%', border: `1.5px solid ${link.is_done ? '#2d8a4e' : '#c8c8c4'}`, background: link.is_done ? '#2d8a4e' : 'transparent', flexShrink: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, transition: 'all 0.15s' }}
                >
                  {link.is_done && <span style={{ color: '#fff', fontSize: 9 }}>✓</span>}
                </button>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, position: 'relative',
                  padding: '3px 8px',
                  background: isInSelection ? '#f3dcaa' : 'transparent',
                  transition: 'background 0.1s',
                }}>
                  <input
                    ref={el => { inputRefs.current[link.id] = el }}
                    value={value}
                    onChange={e => { const v = e.target.value; setEdits(p => ({ ...p, [link.id]: v })) }}
                    onBlur={() => commitEdit(link.id)}
                    onKeyDown={e => handleInputKeyDown(e, link, index)}
                    style={{
                      fontSize: 15, color: '#1a1a1a', border: 'none', outline: 'none',
                      background: 'transparent', fontFamily: 'inherit', padding: '3px 0',
                      textDecoration: link.is_done ? 'line-through' : 'none',
                      minWidth: 0, flex: 1,
                    }}
                  />
                  {isLong && (
                    <button
                      onMouseDown={e => e.stopPropagation()}
                      onClick={e => { e.stopPropagation(); setSelectedItem(link) }}
                      style={{ fontSize: 11, color: '#bbb', flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', fontFamily: 'inherit' }}
                    >↗</button>
                  )}
                  {link.pending_suggestion && !hideCategoryUI && (
                    <PendingSuggestionChip
                      suggestion={link.pending_suggestion}
                      onAccept={() => onAcceptSuggestion?.(link.id)}
                      onReject={() => onRejectSuggestion?.(link.id)}
                    />
                  )}
                  {/* Reminder bell — state machine derived from remind_at +
                      acknowledged_at via getReminderState. Rendering rules:
                        - none          → hover-only add-affordance
                        - upcoming      → muted grey chip with outline bell + relative time
                        - overdue       → solid accent-green filled bell + when
                        - acknowledged  → quiet neutral bell with "reminded X ago" tooltip
                      All three "set" states open the same ReminderPopover on click. */}
                  {!hideCategoryUI && (() => {
                    const rState = getReminderState(link)
                    const openPopover = reminderOpenId === link.id
                    const showPopover = openPopover && onSetReminder && onClearReminder
                    const popover = showPopover ? (
                      <ReminderPopover
                        currentRemindAt={link.remind_at}
                        onSet={iso => onSetReminder!(link.id, iso)}
                        onClear={() => onClearReminder!(link.id)}
                        onClose={() => setReminderOpenId(null)}
                      />
                    ) : null

                    // Add-affordance for items with no reminder — only shows on
                    // row hover or when the popover is open (so the popover
                    // doesn't slam shut when the mouse leaves the row).
                    if (rState === 'none') {
                      if (!isHovered && !openPopover) return null
                      return (
                        <div style={{ position: 'relative', flexShrink: 0 }}>
                          <button
                            onMouseDown={e => e.stopPropagation()}
                            onClick={e => { e.stopPropagation(); setReminderOpenId(openPopover ? null : link.id) }}
                            title="Add reminder"
                            style={{ color: '#bbb', background: 'transparent', border: 'none', cursor: 'pointer', padding: '3px 5px', fontFamily: 'inherit', display: 'flex', alignItems: 'center', borderRadius: 4, transition: 'color 0.12s, background 0.12s' }}
                            onMouseEnter={e => { e.currentTarget.style.color = '#666'; e.currentTarget.style.background = '#f2f1ed' }}
                            onMouseLeave={e => { e.currentTarget.style.color = '#bbb'; e.currentTarget.style.background = 'transparent' }}
                          >
                            <BellIcon />
                          </button>
                          {popover}
                        </div>
                      )
                    }

                    // Upcoming — muted grey chip. Not shouty; just present.
                    if (rState === 'upcoming') {
                      return (
                        <button
                          onMouseDown={e => e.stopPropagation()}
                          onClick={e => { e.stopPropagation(); setReminderOpenId(openPopover ? null : link.id) }}
                          title={`Reminder set for ${new Date(link.remind_at!).toLocaleString()} — click to change or clear`}
                          style={{ fontSize: 11, color: '#7a7a76', background: '#f2f1ed', border: '1px solid #e0dfd9', borderRadius: 999, padding: '2px 9px 2px 8px', cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0, position: 'relative' }}
                        >
                          <BellIcon />
                          <span>{formatReminderLabel(link.remind_at!)}</span>
                          {popover}
                        </button>
                      )
                    }

                    // Overdue — solid accent-green filled bell. Acts as safety
                    // net if the user missed the popup. Green, not red, per spec.
                    if (rState === 'overdue') {
                      return (
                        <button
                          onMouseDown={e => e.stopPropagation()}
                          onClick={e => { e.stopPropagation(); setReminderOpenId(openPopover ? null : link.id) }}
                          title={`Overdue — was scheduled for ${new Date(link.remind_at!).toLocaleString()}`}
                          style={{ fontSize: 11, color: '#2d8a4e', background: '#eef5f0', border: '1px solid #cfe0d5', borderRadius: 999, padding: '2px 9px 2px 8px', cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0, position: 'relative' }}
                        >
                          <BellIcon filled />
                          <span>{formatReminderLabel(link.remind_at!)}</span>
                          {popover}
                        </button>
                      )
                    }

                    // Acknowledged — quiet trace. No chip background, just the
                    // small bell, so it fades into the row while still leaving
                    // an audit trail via the tooltip.
                    return (
                      <div style={{ position: 'relative', flexShrink: 0 }}>
                        <button
                          onMouseDown={e => e.stopPropagation()}
                          onClick={e => { e.stopPropagation(); setReminderOpenId(openPopover ? null : link.id) }}
                          title={link.acknowledged_at ? formatAcknowledgedAgo(link.acknowledged_at) : 'Reminded'}
                          style={{ color: '#c8c6c1', background: 'transparent', border: 'none', cursor: 'pointer', padding: '3px 5px', fontFamily: 'inherit', display: 'flex', alignItems: 'center', borderRadius: 4, transition: 'color 0.12s, background 0.12s' }}
                          onMouseEnter={e => { e.currentTarget.style.color = '#8a8a86'; e.currentTarget.style.background = '#f5f4f1' }}
                          onMouseLeave={e => { e.currentTarget.style.color = '#c8c6c1'; e.currentTarget.style.background = 'transparent' }}
                        >
                          <BellIcon />
                        </button>
                        {popover}
                      </div>
                    )
                  })()}
                  {!link.pending_suggestion && (isHovered || dropdownOpen) && !hideCategoryUI && (
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      <button
                        onMouseDown={e => e.stopPropagation()}
                        onClick={e => { e.stopPropagation(); setOpenDropdownId(dropdownOpen ? null : link.id); setAddingCatInline(false); setInlineCatValue('') }}
                        style={{ fontSize: 12, color: link.category ? '#888' : '#bbb', background: dropdownOpen ? '#e8e8e4' : '#eeede9', border: 'none', cursor: 'pointer', padding: '2px 7px', borderRadius: 4, fontFamily: 'inherit', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 3 }}
                      >
                        {link.category || 'Category'}<span style={{ fontSize: 9, color: '#bbb' }}>▾</span>
                      </button>
                      {dropdownOpen && (
                        <div ref={dropdownRef} style={{ position: 'absolute', left: 0, top: '100%', marginTop: 4, background: '#fff', border: '1px solid #e8e8e4', borderRadius: 10, boxShadow: '0 6px 20px rgba(0,0,0,0.10)', width: 200, zIndex: 100, overflow: 'hidden' }}>
                          {categories.map(cat => (
                            <button key={cat} onMouseDown={() => { onCategoryChange(link.id, cat); setOpenDropdownId(null); setHoveredItemId(null) }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '8px 12px', fontSize: 13, color: cat === link.category ? '#1a1a1a' : '#555', fontWeight: cat === link.category ? 500 : 400, background: cat === link.category ? '#f5f4f1' : 'none', border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }} onMouseEnter={e => { e.currentTarget.style.background = '#f5f4f1' }} onMouseLeave={e => { e.currentTarget.style.background = cat === link.category ? '#f5f4f1' : 'none' }}>
                              {cat}{cat === link.category && <span style={{ fontSize: 11, color: '#bbb' }}>✓</span>}
                            </button>
                          ))}
                          <div style={{ height: 1, background: '#f0f0ec', margin: '2px 0' }} />
                          {addingCatInline ? (
                            <div style={{ padding: '8px 12px' }}><input autoFocus value={inlineCatValue} onChange={e => setInlineCatValue(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submitInlineCat(link.id); if (e.key === 'Escape') { setAddingCatInline(false); setInlineCatValue('') } }} placeholder="New category name…" style={{ width: '100%', fontSize: 13, padding: '5px 8px', border: '1px solid #d8d8d4', borderRadius: 5, outline: 'none', background: '#fff', color: '#1a1a1a', fontFamily: 'inherit' }} /></div>
                          ) : (
                            <button onMouseDown={e => { e.preventDefault(); e.stopPropagation(); setAddingCatInline(true) }} style={{ display: 'block', width: '100%', padding: '8px 12px', fontSize: 13, color: '#aaa', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }} onMouseEnter={e => { e.currentTarget.style.background = '#f5f4f1'; e.currentTarget.style.color = '#555' }} onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = '#aaa' }}>+ New category</button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })}

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 8px', marginTop: 4 }}>
            <div style={{ width: 16, height: 16, borderRadius: '50%', border: '1.5px solid #ddd', flexShrink: 0 }} />
            <input
              ref={newLineRef}
              value={newLineValue}
              onChange={e => setNewLineValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') submitNewLine()
                else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  if (sorted.length === 0) return
                  const col = e.currentTarget.selectionStart ?? 0
                  moveCursorToItem(sorted.length - 1, col)
                }
              }}
              onBlur={() => { if (newLineValue.trim()) submitNewLine() }}
              placeholder={activeView.startsWith('cat:') ? `New item in ${activeView.slice(4)}…` : 'New item…'}
              style={{ flex: 1, fontSize: 15, color: '#1a1a1a', border: 'none', outline: 'none', background: 'transparent', fontFamily: 'inherit', padding: '3px 0' }}
            />
          </div>
          {sorted.length === 0 && !search && <div style={{ marginTop: 4, paddingLeft: 26 }}><span style={{ fontSize: 14, color: '#ccc' }}>{activeView.startsWith('cat:') ? `Nothing in ${activeView.slice(4)} yet — type above to add` : 'Nothing saved yet — type above to add'}</span></div>}
        </div>
      </div>
      <div style={{ borderTop: '1px solid #eeeee9', background: 'rgba(250,250,249,0.95)', backdropFilter: 'blur(10px)', padding: '10px 40px', flexShrink: 0 }}>
        <input type="text" value={search} onChange={e => onSearchChange(e.target.value)} placeholder="Search anything…" style={{ width: '100%', maxWidth: 600, fontSize: 14, padding: '9px 16px', border: '1px solid #e0e0dc', borderRadius: 8, outline: 'none', background: '#fff', color: '#1a1a1a', fontFamily: 'inherit' }} onFocus={e => { e.currentTarget.style.borderColor = '#c8c8c4' }} onBlur={e => { e.currentTarget.style.borderColor = '#e0e0dc' }} />
      </div>
    </div>
  )

  const detailPanel = selectedItem && (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', borderLeft: '1px solid #e8e8e4', overflow: 'hidden' }}>
      <div style={{ padding: '20px 40px 0', borderBottom: '1px solid #eeeee9', flexShrink: 0 }}>
        <button onClick={() => setSelectedItem(null)} style={{ fontSize: 13, color: '#aaa', cursor: 'pointer', background: 'none', border: 'none', fontFamily: 'inherit', padding: '0 0 16px 0', display: 'flex', alignItems: 'center', gap: 4 }}>← Back</button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '32px 40px 80px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          {selectedItem.category && <span style={{ fontSize: 12, color: '#888', background: '#eeede9', padding: '3px 8px', borderRadius: 4 }}>{selectedItem.category}</span>}
          <span style={{ fontSize: 12, color: '#ccc' }}>{new Date(selectedItem.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
        </div>
        <h2 style={{ fontSize: 22, fontWeight: 600, color: '#1a1a1a', letterSpacing: '-0.4px', marginBottom: 24, lineHeight: 1.3 }}>{selectedItem.title || getDomain(selectedItem.url) || selectedItem.url}</h2>
        {selectedItem.note && <div style={{ fontSize: 15, color: '#333', lineHeight: 1.8, whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{selectedItem.note}</div>}
        {selectedItem.item_type === 'link' && selectedItem.url && <a href={selectedItem.url} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-block', marginTop: 24, fontSize: 13, color: '#888', textDecoration: 'none', borderBottom: '1px solid #e0e0dc', paddingBottom: 2 }}>{selectedItem.url} ↗</a>}
      </div>
      <div style={{ padding: '12px 40px', borderTop: '1px solid #eeeee9', display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={() => { toggleDone(selectedItem); setSelectedItem(null) }} style={{ fontSize: 13, color: selectedItem.is_done ? '#2d8a4e' : '#888', background: 'none', border: '1px solid #e0e0dc', borderRadius: 7, padding: '6px 14px', cursor: 'pointer', fontFamily: 'inherit' }}>{selectedItem.is_done ? '✓ Done' : 'Mark as done'}</button>
      </div>
    </div>
  )

  return (
    <div style={{ display: 'flex', height: '100vh', background: '#fafaf9', overflow: 'hidden', position: 'relative' }}>
      {sidebar}
      {activeView === 'settings' ? (
        <SettingsPage />
      ) : listPanel}
      {activeView !== 'settings' && detailPanel}
      {showCmdKHint && <CmdKHint />}
    </div>
  )
}

// Subtle, always-on hint at the bottom-right of the vault window. Fades out
// naturally once the user has pressed Cmd+K enough times (managed via
// lib/hints.ts). No dismiss button — this is an ambient reminder, not a
// modal, so the "dismiss" is just using the shortcut a few times.
function CmdKHint() {
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        bottom: 14,
        right: 18,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        background: 'rgba(255, 255, 255, 0.85)',
        border: '1px solid #eae8e2',
        borderRadius: 999,
        fontSize: 12,
        color: '#8a8a86',
        fontFamily: 'inherit',
        pointerEvents: 'none',
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        userSelect: 'none',
        zIndex: 20,
      }}
    >
      <span>Save from anywhere</span>
      <kbd
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 2,
          padding: '2px 6px',
          background: '#f5f4f1',
          border: '1px solid #e2e0da',
          borderRadius: 4,
          fontSize: 11,
          fontFamily: 'inherit',
          fontWeight: 600,
          color: '#555',
        }}
      >
        ⌘ K
      </kbd>
    </div>
  )
}
