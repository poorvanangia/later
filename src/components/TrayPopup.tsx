import { useState, useRef, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { LinkRow } from '../App'

const PLACEHOLDERS = [
  'Paste a link, write a note, or save anything…',
  'Get Milk on the way home…',
  'Buy Coldplay tickets at 7pm…',
  'Book flights to Tokyo…',
  'Read this later…',
  'Remember this…',
  'Call dentist tomorrow…',
  'Watch Succession S3…',
]

type Props = {
  links: LinkRow[]
  categories: string[]
  onSave: (url: string) => void
  onDone: (id: string) => void
  onCategoryChange: (id: string, category: string) => void
  onAddCategory: (name: string) => void
  isSignedIn: boolean
  onSignIn: () => void
}

export function TrayPopup({ links, categories, onSave, onDone, onCategoryChange, onAddCategory }: Props) {
  const [value, setValue] = useState('')
  const [justSaved, setJustSaved] = useState(false)
  const [placeholderIndex, setPlaceholderIndex] = useState(0)
  const [fade, setFade] = useState(true)
  const [openDropdownId, setOpenDropdownId] = useState<string | null>(null)
  const [addingCatInline, setAddingCatInline] = useState(false)
  const [inlineCatValue, setInlineCatValue] = useState('')
  const [hoveredItemId, setHoveredItemId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    const autoPaste = async () => {
      try {
        const text = await navigator.clipboard.readText()
        if (text && (text.startsWith('http://') || text.startsWith('https://'))) {
          setValue(text)
        }
      } catch { }
    }
    autoPaste()
  }, [])

  useEffect(() => {
    const interval = setInterval(() => {
      setFade(false)
      setTimeout(() => {
        setPlaceholderIndex((i) => (i + 1) % PLACEHOLDERS.length)
        setFade(true)
      }, 300)
    }, 2500)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpenDropdownId(null)
        setAddingCatInline(false)
        setInlineCatValue('')
        setHoveredItemId(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = value.trim()
    if (!trimmed) return
    onSave(trimmed)
    setValue('')
    setJustSaved(true)
    setTimeout(() => setJustSaved(false), 2000)
  }

  const handleOpenVault = async () => {
    try { await invoke('open_library') } catch { }
  }

  const submitInlineCat = (itemId: string) => {
    const trimmed = inlineCatValue.trim()
    if (trimmed) {
      onAddCategory(trimmed)
      onCategoryChange(itemId, trimmed)
    }
    setAddingCatInline(false)
    setInlineCatValue('')
    setOpenDropdownId(null)
  }

  const activeLinks = links.filter((link) => !link.is_done)
  const doneLinks = links.filter((link) => link.is_done)
  const sortedLinks = [...activeLinks, ...doneLinks]

  return (
    <div style={{
      height: '100vh', display: 'flex', flexDirection: 'column',
      background: '#fafaf9',
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      overflow: 'hidden', userSelect: 'none',
    }}>
      {/* Header */}
      <div data-tauri-drag-region style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '14px 20px 10px', cursor: 'default', flexShrink: 0,
      }}>
        <span style={{
          fontSize: 16, fontWeight: 600, color: '#1a1a1a',
          fontFamily: "'Fraunces', serif", letterSpacing: '-0.2px',
        }}>
          Later<span style={{ color: '#a10808' }}>.</span>
        </span>
      </div>

      {/* Save input */}
      <div style={{ padding: '0 16px 12px', flexShrink: 0 }}>
        <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 8 }}>
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={PLACEHOLDERS[placeholderIndex]}
            style={{
              flex: 1, fontSize: 14, padding: '10px 14px',
              border: '1px solid #e0e0dc', borderRadius: 8,
              outline: 'none', background: '#fff', color: '#1a1a1a',
              fontFamily: 'inherit',
              opacity: fade ? 1 : 0.3,
              transition: 'opacity 0.3s ease',
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = '#c8c8c4' }}
            onBlur={(e) => { e.currentTarget.style.borderColor = '#e0e0dc' }}
          />
          <button
            type="submit"
            style={{
              fontSize: 14, fontWeight: 500, color: '#fff',
              background: justSaved ? '#2d8a4e' : '#1a1a1a',
              border: 'none', cursor: 'pointer',
              padding: '10px 16px', borderRadius: 8, fontFamily: 'inherit',
              whiteSpace: 'nowrap', transition: 'background 0.2s',
            }}
          >
            {justSaved ? '✓' : 'Save'}
          </button>
        </form>
      </div>

      <div style={{ height: 1, background: '#eeeee9', margin: '0 16px', flexShrink: 0 }} />

      {/* Recent — checklist style */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 20px' }}>
        <div style={{
          fontSize: 11, fontWeight: 600, color: '#bbb',
          letterSpacing: '0.05em', textTransform: 'uppercase',
          padding: '6px 0 4px',
        }}>
          Recent
        </div>

        {sortedLinks.length === 0 ? (
          <div style={{ fontSize: 13, color: '#ccc', padding: '12px 0' }}>
            Nothing saved yet
          </div>
        ) : (
          sortedLinks.map((link) => {
            const displayTitle = link.title || link.url
            const dropdownOpen = openDropdownId === link.id
            const isHovered = hoveredItemId === link.id
            return (
              <div
                key={link.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '5px 6px',
                  borderRadius: 6,
                  background: isHovered || dropdownOpen ? '#f2f1ed' : 'transparent',
                  opacity: link.is_done ? 0.4 : 1,
                }}
                onMouseEnter={() => setHoveredItemId(link.id)}
                onMouseLeave={() => { if (!dropdownOpen) setHoveredItemId(null) }}
              >
                {/* Checkbox */}
                <button
                  onClick={() => onDone(link.id)}
                  aria-label={link.is_done ? 'Mark as not done' : 'Mark as done'}
                  style={{
                    width: 15, height: 15, borderRadius: '50%',
                    border: `1.5px solid ${link.is_done ? '#2d8a4e' : '#c8c8c4'}`,
                    background: link.is_done ? '#2d8a4e' : 'transparent',
                    flexShrink: 0, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    padding: 0, transition: 'all 0.15s',
                  }}
                >
                  {link.is_done && <span style={{ color: '#fff', fontSize: 8 }}>✓</span>}
                </button>

                <div
                  style={{
                    flex: 1, minWidth: 0,
                    display: 'flex', alignItems: 'baseline', gap: 6,
                    justifyContent: 'flex-start',
                    overflow: 'visible',
                  }}
                >
                  {/* Title */}
                  <a
                    href={link.item_type === 'note' ? undefined : link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      minWidth: 0,
                      flex: '0 1 auto',
                      fontSize: 14, color: '#1a1a1a',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      textDecoration: link.is_done ? 'line-through' : 'none',
                      cursor: link.item_type === 'note' ? 'default' : 'pointer',
                    } as React.CSSProperties}
                  >
                    {displayTitle}
                  </a>
                  {(isHovered || dropdownOpen) && (
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      <button
                        onMouseDown={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          setOpenDropdownId(dropdownOpen ? null : link.id)
                          setAddingCatInline(false)
                          setInlineCatValue('')
                        }}
                        style={{
                          maxWidth: 104,
                          fontSize: 10,
                          color: link.category ? '#888' : '#bbb',
                          textTransform: 'uppercase',
                          letterSpacing: '0.04em',
                          background: dropdownOpen ? '#e8e8e4' : '#eeede9',
                          border: 'none',
                          borderRadius: 4,
                          cursor: 'pointer',
                          padding: '2px 6px',
                          fontFamily: 'inherit',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {link.category || 'Category'} ▾
                      </button>

                      {dropdownOpen && (
                      <div
                        ref={dropdownRef}
                        style={{
                          position: 'absolute',
                          left: 0,
                          top: '100%',
                          marginTop: 4,
                          background: '#fff',
                          border: '1px solid #e8e8e4',
                          borderRadius: 8,
                          boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                          width: 180,
                          maxHeight: 300,
                          overflowY: 'auto',
                          zIndex: 100,
                        }}
                      >
                        {categories.map((cat) => (
                          <button
                            key={cat}
                            onMouseDown={() => {
                              onCategoryChange(link.id, cat)
                              setOpenDropdownId(null)
                              setHoveredItemId(null)
                            }}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              width: '100%',
                              padding: '8px 10px',
                              fontSize: 13,
                              color: cat === link.category ? '#1a1a1a' : '#555',
                              fontWeight: cat === link.category ? 500 : 400,
                              background: cat === link.category ? '#f5f4f1' : 'none',
                              border: 'none',
                              cursor: 'pointer',
                              textAlign: 'left',
                              fontFamily: 'inherit',
                            }}
                          >
                            {cat}
                            {cat === link.category && <span style={{ fontSize: 11, color: '#bbb' }}>✓</span>}
                          </button>
                        ))}
                        <div style={{ height: 1, background: '#f0f0ec', margin: '2px 0' }} />
                        {addingCatInline ? (
                          <div style={{ padding: '8px 10px' }}>
                            <input
                              autoFocus
                              value={inlineCatValue}
                              onChange={(e) => setInlineCatValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') submitInlineCat(link.id)
                                if (e.key === 'Escape') {
                                  setAddingCatInline(false)
                                  setInlineCatValue('')
                                }
                              }}
                              placeholder="New category name..."
                              style={{
                                width: '100%',
                                fontSize: 13,
                                padding: '5px 7px',
                                border: '1px solid #d8d8d4',
                                borderRadius: 5,
                                outline: 'none',
                                background: '#fff',
                                color: '#1a1a1a',
                                fontFamily: 'inherit',
                              }}
                            />
                          </div>
                        ) : (
                          <button
                            onMouseDown={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              setAddingCatInline(true)
                            }}
                            style={{
                              display: 'block',
                              width: '100%',
                              padding: '8px 10px',
                              fontSize: 13,
                              color: '#999',
                              background: 'none',
                              border: 'none',
                              cursor: 'pointer',
                              textAlign: 'left',
                              fontFamily: 'inherit',
                            }}
                          >
                            + New category
                          </button>
                        )}
                      </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* Footer */}
      <div style={{
        padding: '8px 20px', borderTop: '1px solid #eeeee9',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        flexShrink: 0,
      }}>
        <span style={{ fontSize: 11, color: '#ccc' }}>
          {links.length} {links.length === 1 ? 'item' : 'items'}
        </span>
        <button
          onClick={handleOpenVault}
          style={{
            fontSize: 12, color: '#888', background: 'none',
            border: 'none', cursor: 'pointer', fontFamily: 'inherit', padding: 0,
          }}
        >
          Open vault →
        </button>
      </div>
    </div>
  )
}
