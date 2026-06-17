import { useState, useRef, useEffect } from 'react'
import type { LinkRow } from '../App'

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
  onAddCategory: (name: string) => void
  onDone: (id: string) => void
  onSearchChange: (q: string) => void
  onCategoryChange: (id: string, category: string) => void
  onDeleteCategory?: (name: string) => void
  onUpdateItem?: (id: string, updates: Partial<LinkRow>) => void
  onAddItem?: (text: string, category?: string) => void
  onDeleteItem?: (id: string) => void
}

export function LibraryPage({
  links, categories, activeView, search,
  onNavigate, onAddCategory, onDone, onSearchChange, onCategoryChange,
  onDeleteCategory, onUpdateItem, onAddItem, onDeleteItem,
}: Props) {
  const [addingCat, setAddingCat] = useState(false)
  const [newCatName, setNewCatName] = useState('')
  const [editingCat, setEditingCat] = useState<string | null>(null)
  const [editingCatValue, setEditingCatValue] = useState('')
  const [editingItemId, setEditingItemId] = useState<string | null>(null)
  const [editingValue, setEditingValue] = useState('')
  const [newLineValue, setNewLineValue] = useState('')
  const [openDropdownId, setOpenDropdownId] = useState<string | null>(null)
  const [addingCatInline, setAddingCatInline] = useState(false)
  const [inlineCatValue, setInlineCatValue] = useState('')
  const [hoveredItemId, setHoveredItemId] = useState<string | null>(null)
  const [selectedItem, setSelectedItem] = useState<LinkRow | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [lastIndex, setLastIndex] = useState<number | null>(null)
  const [showWelcome, setShowWelcome] = useState(() => !localStorage.getItem('later:welcomeDone'))
  const newLineRef = useRef<HTMLInputElement>(null)
  const editRefs = useRef<Record<string, HTMLInputElement | null>>({})
  const dropdownRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef<Record<number, HTMLDivElement | null>>({})
  const listContainerRef = useRef<HTMLDivElement>(null)
  const [barTop, setBarTop] = useState<number | null>(null)

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

  const getPageTitle = () => {
    if (activeView === 'library') return 'All Items'
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

  // Keyboard: select-all, copy, delete, escape, arrow navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || '').toLowerCase()
      const isInputFocused = tag === 'input' || tag === 'textarea'

      // Arrow keys always drive list navigation — even if a text input has focus,
      // since Up/Down don't do anything useful inside a single-line input anyway.
      if (!e.metaKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          if (sorted.length === 0) { newLineRef.current?.focus(); return }
          if (e.shiftKey && lastIndex !== null) {
            const ni = Math.min(lastIndex + 1, sorted.length - 1)
            if (sorted[ni]) { setSelectedIds(p => new Set([...p, sorted[ni].id])); setLastIndex(ni) }
          } else if (lastIndex === null) {
            setSelectedIds(new Set([sorted[0].id])); setLastIndex(0)
            if (isInputFocused) (document.activeElement as HTMLElement)?.blur()
          } else if (lastIndex >= sorted.length - 1) {
            // Already at the last item — flow forward into the new-item input
            setSelectedIds(new Set()); setLastIndex(null)
            newLineRef.current?.focus()
          } else {
            const ni = lastIndex + 1
            setSelectedIds(new Set([sorted[ni].id])); setLastIndex(ni)
            if (isInputFocused) (document.activeElement as HTMLElement)?.blur()
          }
        } else {
          e.preventDefault()
          if (isInputFocused) (document.activeElement as HTMLElement)?.blur()
          if (sorted.length === 0) return
          if (e.shiftKey && lastIndex !== null) {
            const pi = Math.max(lastIndex - 1, 0)
            if (sorted[pi]) { setSelectedIds(p => new Set([...p, sorted[pi].id])); setLastIndex(pi) }
          } else if (lastIndex === null) {
            // Coming back up from the new-item input — land on the last item
            const ni = sorted.length - 1
            setSelectedIds(new Set([sorted[ni].id])); setLastIndex(ni)
          } else {
            const pi = Math.max(lastIndex - 1, 0)
            setSelectedIds(new Set([sorted[pi].id])); setLastIndex(pi)
          }
        }
        return
      }

      // Everything below only applies when NOT typing in a text field
      if (isInputFocused) return

      // Cmd+A — select everything in the current view (Apple Notes style)
      if (e.metaKey && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        setSelectedIds(new Set(sorted.map(l => l.id)))
        setLastIndex(sorted.length - 1)
        return
      }

      // Cmd+C — copy selected item titles to clipboard
      if (e.metaKey && e.key.toLowerCase() === 'c' && selectedIds.size > 0) {
        e.preventDefault()
        const text = sorted.filter(l => selectedIds.has(l.id)).map(l => l.title || l.url).join('\n')
        navigator.clipboard?.writeText(text).catch(() => {})
        return
      }

      // Backspace/Delete — remove all selected items
      if ((e.key === 'Backspace' || e.key === 'Delete') && selectedIds.size > 0) {
        e.preventDefault()
        if (onDeleteItem) selectedIds.forEach(id => onDeleteItem(id))
        setSelectedIds(new Set())
        setLastIndex(null)
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
  }, [selectedIds, lastIndex, sorted, onDeleteItem])

  // Position the sliding focus bar next to whichever row the keyboard cursor is on —
  // only when exactly one item is the "current" cursor (not a multi-select range)
  useEffect(() => {
    if (selectedIds.size === 1 && lastIndex !== null) {
      const rowEl = rowRefs.current[lastIndex]
      if (rowEl) {
        setBarTop(rowEl.offsetTop + rowEl.offsetHeight / 2)
        return
      }
    }
    setBarTop(null)
  }, [selectedIds, lastIndex, sorted.length])

  const handleRowClick = (link: LinkRow, index: number, e: React.MouseEvent) => {
    if (e.metaKey) {
      e.preventDefault()
      setSelectedIds(prev => { const n = new Set(prev); if (n.has(link.id)) n.delete(link.id); else n.add(link.id); return n })
      setLastIndex(index); return
    }
    if (e.shiftKey && lastIndex !== null) {
      e.preventDefault()
      const s = Math.min(lastIndex, index), en = Math.max(lastIndex, index)
      setSelectedIds(prev => new Set([...prev, ...sorted.slice(s, en + 1).map(l => l.id)]))
      setLastIndex(index); return
    }
    if (selectedIds.size > 0) { setSelectedIds(new Set()); setLastIndex(null); return }
    if (isLongItem(link)) { setSelectedItem(link) }
    else { setEditingItemId(link.id); setEditingValue(link.title || ''); setTimeout(() => editRefs.current[link.id]?.focus(), 50) }
  }

  const saveEdit = (id: string) => {
    const t = editingValue.trim()
    if (t && onUpdateItem) onUpdateItem(id, { title: t })
    else if (!t && onDeleteItem) onDeleteItem(id)
    setEditingItemId(null); setEditingValue('')
  }

  // New items inherit the current category if we're viewing one — AI only classifies
  // items added from "All Items" where there's no obvious category yet.
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

  const submitNewCategory = () => { const t = newCatName.trim(); if (t) onAddCategory(t); setNewCatName(''); setAddingCat(false) }
  const startEditCat = (cat: string) => { setEditingCat(cat); setEditingCatValue(cat) }
  const submitEditCat = () => {
    const t = editingCatValue.trim()
    if (t && t !== editingCat) { links.forEach(l => { if (l.category === editingCat) onCategoryChange(l.id, t) }); onAddCategory(t); if (activeView === `cat:${editingCat}`) onNavigate(`cat:${t}`) }
    setEditingCat(null); setEditingCatValue('')
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
          <span style={{ fontSize: 44, fontWeight: 600, color: '#1a1a1a', fontFamily: "'Fraunces', serif", letterSpacing: '-1.5px', marginBottom: 10 }}>
            Later<span style={{ color: '#a10808' }}>.</span>
          </span>
          <span style={{ fontSize: 16, color: '#aaa', marginBottom: 56 }}>Save anything. Find it when it matters.</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 28, textAlign: 'left', width: '100%', marginBottom: 56 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
              <div style={{ flexShrink: 0, width: 80, textAlign: 'center', fontSize: 12, fontWeight: 600, color: '#666', background: '#f0f0ec', border: '1px solid #e0e0dc', borderRadius: 7, padding: '7px 8px' }}>⌘ ⇧ L</div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 500, color: '#1a1a1a', marginBottom: 3 }}>Quick save from anywhere</div>
                <div style={{ fontSize: 13, color: '#999', lineHeight: '1.5' }}>Links, notes, tasks — press ⌘⇧L from any app on your Mac.</div>
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
      <div style={{ padding: '4px 12px', marginBottom: 24 }}>
        <span style={{ fontSize: 18, fontWeight: 600, color: '#1a1a1a', fontFamily: "'Fraunces', serif", letterSpacing: '-0.2px' }}>Later<span style={{ color: '#a10808' }}>.</span></span>
      </div>
      <button onClick={() => { onNavigate('library'); setSelectedItem(null); setSelectedIds(new Set()); setLastIndex(null) }} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 12px', fontSize: 14, marginBottom: 16, fontWeight: activeView === 'library' ? 500 : 400, color: activeView === 'library' ? '#1a1a1a' : '#888', background: activeView === 'library' ? '#eeede9' : 'none', border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit' }}>All Items</button>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 12px', marginBottom: 4 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: '#bbb', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Categories</span>
        <button onClick={() => setAddingCat(true)} style={{ width: 18, height: 18, borderRadius: 4, border: '1px solid #d8d8d4', background: 'none', cursor: 'pointer', fontSize: 14, color: '#aaa', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'inherit', padding: 0 }}>+</button>
      </div>
      {categories.map((cat) => {
        const active = activeView === `cat:${cat}`
        if (editingCat === cat) return (<div key={cat} style={{ padding: '2px 4px' }}><input autoFocus value={editingCatValue} onChange={e => setEditingCatValue(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submitEditCat(); if (e.key === 'Escape') { setEditingCat(null); setEditingCatValue('') } }} onBlur={submitEditCat} style={{ width: '100%', fontSize: 14, padding: '5px 8px', border: '1px solid #c8c8c4', borderRadius: 6, outline: 'none', background: '#fff', color: '#1a1a1a', fontFamily: 'inherit' }} /></div>)
        return (<div key={cat} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <button onClick={() => { onNavigate(`cat:${cat}`); setSelectedItem(null); setSelectedIds(new Set()); setLastIndex(null) }} onDoubleClick={() => startEditCat(cat)} style={{ flex: 1, textAlign: 'left', padding: '7px 12px', fontSize: 14, fontWeight: active ? 500 : 400, color: active ? '#1a1a1a' : '#888', background: active ? '#eeede9' : 'none', border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit' }}>{cat}</button>
          {onDeleteCategory && <button onClick={() => onDeleteCategory(cat)} style={{ width: 20, height: 20, borderRadius: 4, border: 'none', background: 'none', cursor: 'pointer', color: '#ccc', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, flexShrink: 0 }} onMouseEnter={e => { e.currentTarget.style.color = '#e05c5c' }} onMouseLeave={e => { e.currentTarget.style.color = '#ccc' }}>×</button>}
        </div>)
      })}
      {addingCat && <div style={{ padding: '4px 4px' }}><input autoFocus value={newCatName} onChange={e => setNewCatName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submitNewCategory(); if (e.key === 'Escape') { setAddingCat(false); setNewCatName('') } }} onBlur={submitNewCategory} placeholder="Category name…" style={{ width: '100%', fontSize: 13, padding: '5px 8px', border: '1px solid #d8d8d4', borderRadius: 6, outline: 'none', background: '#fff', color: '#1a1a1a', fontFamily: 'inherit' }} /></div>}
    </div>
  )

  const listPanel = (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: '48px 56px 24px' }}>
        <h1 style={{ fontSize: 28, fontWeight: 600, color: '#1a1a1a', letterSpacing: '-0.5px', marginBottom: 12, lineHeight: 1.2 }}>{getPageTitle()}</h1>
        {selectedIds.size > 0 ? (
          <div style={{ fontSize: 12, color: '#888', background: '#eef2f8', border: '1px solid #dbe4f0', borderRadius: 7, padding: '6px 12px', marginBottom: 16, display: 'inline-flex', alignItems: 'center', gap: 10 }}><span>{selectedIds.size} selected</span><span style={{ color: '#bbb' }}>·</span><span style={{ color: '#aaa' }}>⌫ delete · ⌘C copy · Esc cancel</span></div>
        ) : (
          <div style={{ fontSize: 12, color: '#ccc', marginBottom: 16 }}>↑↓ to navigate · ⇧+↑↓ to select multiple · ⌘A select all</div>
        )}
        <div ref={listContainerRef} style={{ maxWidth: 640, position: 'relative' }}>
          {sorted.map((link, index) => {
            const displayTitle = link.title || getDomain(link.url) || link.url
            const isEditing = editingItemId === link.id
            const isHovered = hoveredItemId === link.id
            const dropdownOpen = openDropdownId === link.id
            const isLong = isLongItem(link)
            const isSelected = selectedIds.has(link.id)
            const isMultiSelect = selectedIds.size > 1
            return (
              <div key={link.id} ref={el => { rowRefs.current[index] = el }} onClick={e => { if (e.metaKey || (e.shiftKey && lastIndex !== null)) handleRowClick(link, index, e) }} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 8px', borderRadius: 6, background: isMultiSelect && isSelected ? '#dce7f5' : (isHovered || dropdownOpen ? '#f2f1ed' : 'transparent'), transition: 'background 0.1s', opacity: link.is_done ? 0.45 : 1, userSelect: 'none' }} onMouseEnter={() => setHoveredItemId(link.id)} onMouseLeave={() => { if (!dropdownOpen) setHoveredItemId(null) }}>
                <button onClick={e => { if (e.metaKey || e.shiftKey) return; e.stopPropagation(); toggleDone(link) }} style={{ width: 16, height: 16, borderRadius: '50%', border: `1.5px solid ${link.is_done ? '#2d8a4e' : '#c8c8c4'}`, background: link.is_done ? '#2d8a4e' : 'transparent', flexShrink: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, transition: 'all 0.15s' }}>
                  {link.is_done && <span style={{ color: '#fff', fontSize: 9 }}>✓</span>}
                </button>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, position: 'relative' }}>
                  {isEditing ? (
                    <input ref={el => { editRefs.current[link.id] = el }} value={editingValue} onChange={e => setEditingValue(e.target.value)} onBlur={() => saveEdit(link.id)} onKeyDown={e => { if (e.key === 'Enter') { saveEdit(link.id); setTimeout(() => newLineRef.current?.focus(), 80) } if (e.key === 'Escape') { setEditingItemId(null); setEditingValue('') } if (e.key === 'Backspace' && editingValue === '' && onDeleteItem) { onDeleteItem(link.id); setEditingItemId(null) } }} style={{ fontSize: 15, color: '#1a1a1a', border: 'none', outline: 'none', background: 'transparent', fontFamily: 'inherit', padding: '3px 0', textDecoration: link.is_done ? 'line-through' : 'none', minWidth: 0, flex: 1 }} />
                  ) : (
                    <div onClick={e => { e.stopPropagation(); handleRowClick(link, index, e) }} style={{ fontSize: 15, color: '#1a1a1a', cursor: isLong ? 'pointer' : 'text', padding: '3px 0', lineHeight: '1.6', textDecoration: link.is_done ? 'line-through' : 'none', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: 6 }}>
                      {displayTitle}
                      {isLong && <span style={{ fontSize: 11, color: '#bbb', flexShrink: 0 }}>↗</span>}
                    </div>
                  )}
                  {(isHovered || dropdownOpen) && !isMultiSelect && (
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      <button onClick={e => { e.stopPropagation(); setOpenDropdownId(dropdownOpen ? null : link.id); setAddingCatInline(false); setInlineCatValue('') }} style={{ fontSize: 12, color: link.category ? '#888' : '#bbb', background: dropdownOpen ? '#e8e8e4' : '#eeede9', border: 'none', cursor: 'pointer', padding: '2px 7px', borderRadius: 4, fontFamily: 'inherit', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 3 }}>
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

          {barTop !== null && (
            <div style={{
              position: 'absolute',
              left: -14,
              top: barTop,
              width: 4,
              height: 20,
              borderRadius: 4,
              background: '#a10808',
              transform: 'translateY(-50%)',
              transition: 'top 0.15s ease',
              pointerEvents: 'none',
            }} />
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 8px', marginTop: 4 }}>
            <div style={{ width: 16, height: 16, borderRadius: '50%', border: '1.5px solid #ddd', flexShrink: 0 }} />
            <input ref={newLineRef} value={newLineValue} onChange={e => setNewLineValue(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submitNewLine() }} onBlur={() => { if (newLineValue.trim()) submitNewLine() }} placeholder={activeView.startsWith('cat:') ? `New item in ${activeView.slice(4)}…` : 'New item…'} style={{ flex: 1, fontSize: 15, color: '#1a1a1a', border: 'none', outline: 'none', background: 'transparent', fontFamily: 'inherit', padding: '3px 0' }} />
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
    <div style={{ display: 'flex', height: '100vh', background: '#fafaf9', overflow: 'hidden' }}>
      {sidebar}
      {listPanel}
      {detailPanel}
    </div>
  )
}
