import { useState, useEffect, useRef } from 'react'
import type { LinkRow as LinkRowType } from '../lib/supabase'

function getDomain(url: string): string {
  try { return new URL(url).hostname.replace('www.', '') }
  catch { return '' }
}

const TagIcon = () => (
  <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 1h4.5l5 5-4.5 4.5L1 6V1z"/>
    <circle cx="3.5" cy="3.5" r="0.8" fill="currentColor" stroke="none"/>
  </svg>
)

type Props = {
  link: LinkRowType
  categories: string[]
  onDone: (id: string) => void
  onCategoryChange: (id: string, category: string) => void
}

export function LinkRow({ link, categories, onDone, onCategoryChange }: Props) {
  const domain = getDomain(link.url)
  const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=32` : null
  const displayTitle = link.title || link.label || domain || link.url

  const meta = [
    domain,
    link.ai_processed && link.read_time_minutes ? `${link.read_time_minutes} min read` : null,
  ].filter(Boolean).join(' · ')

  const [hovered, setHovered] = useState(false)
  const [catOpen, setCatOpen] = useState(false)
  const [addingCat, setAddingCat] = useState(false)
  const [newCatName, setNewCatName] = useState('')
  const popoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!catOpen) return
    const handler = (e: MouseEvent) => {
      if (!popoverRef.current?.contains(e.target as Node)) {
        setCatOpen(false)
        setAddingCat(false)
        setNewCatName('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [catOpen])

  const handleCatSelect = (cat: string) => {
    onCategoryChange(link.id, cat)
    setCatOpen(false)
  }

  const handleNewCat = () => {
    const trimmed = newCatName.trim()
    if (trimmed) {
      onCategoryChange(link.id, trimmed)
    }
    setCatOpen(false)
    setAddingCat(false)
    setNewCatName('')
  }

  const showActions = hovered || catOpen

  return (
    <div
      style={{ position: 'relative' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { if (!catOpen) setHovered(false) }}
    >
      <a
        href={link.url}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: 'flex', alignItems: 'center', gap: 14,
          padding: '15px 0', textDecoration: 'none',
          borderBottom: '1px solid #f0f0ec',
          cursor: 'pointer',
          paddingRight: 62,
        }}
      >
        {/* Favicon */}
        <div style={{
          width: 28, height: 28, borderRadius: 6,
          background: '#f0f0ec', flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          overflow: 'hidden',
        }}>
          {faviconUrl
            ? <img src={faviconUrl} width={16} height={16} alt="" style={{ objectFit: 'contain' }} onError={(e) => { e.currentTarget.style.display = 'none' }} />
            : <span style={{ fontSize: 11, color: '#bbb' }}>↗</span>
          }
        </div>

        {/* Text */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 14, fontWeight: 500, color: '#1a1a1a',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            marginBottom: 2,
          }}>
            {!link.ai_processed
              ? <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {displayTitle}
                  <span className="shimmer" style={{ width: 60, height: 10, display: 'inline-block', borderRadius: 4, verticalAlign: 'middle' }} />
                </span>
              : displayTitle
            }
          </div>
          {meta && (
            <div style={{ fontSize: 12, color: '#aaa' }}>{meta}</div>
          )}
        </div>

        {/* Read time */}
        {link.ai_processed && link.read_time_minutes && (
          <div style={{ fontSize: 12, color: '#bbb', flexShrink: 0 }}>
            {link.read_time_minutes} min
          </div>
        )}
      </a>

      {/* Action buttons — shown on hover */}
      <div style={{
        position: 'absolute', right: 0, top: '50%', transform: 'translateY(-50%)',
        display: 'flex', alignItems: 'center', gap: 4,
        opacity: showActions ? 1 : 0,
        transition: 'opacity 0.15s',
        pointerEvents: showActions ? 'auto' : 'none',
      }}>
        {/* Category button */}
        <div style={{ position: 'relative' }} ref={popoverRef}>
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setCatOpen((o) => !o) }}
            title="Change category"
            style={{
              width: 24, height: 24, borderRadius: '50%',
              border: '1px solid #d8d8d4', background: catOpen ? '#1a1a1a' : '#fff',
              cursor: 'pointer', display: 'flex', alignItems: 'center',
              justifyContent: 'center', color: catOpen ? '#fff' : '#aaa',
              transition: 'all 0.15s', fontFamily: 'inherit',
            }}
          >
            <TagIcon />
          </button>

          {/* Category popover */}
          {catOpen && (
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                position: 'absolute', right: 0, bottom: 'calc(100% + 6px)',
                background: '#fff', border: '1px solid #e8e8e4',
                borderRadius: 10, padding: '6px 0',
                minWidth: 160, zIndex: 100,
                boxShadow: '0 4px 16px rgba(0,0,0,0.10)',
              }}
            >
              {categories.map((cat) => (
                <button
                  key={cat}
                  onClick={() => handleCatSelect(cat)}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    width: '100%', padding: '7px 14px',
                    fontSize: 13, color: cat === link.category ? '#1a1a1a' : '#555',
                    fontWeight: cat === link.category ? 500 : 400,
                    background: 'none', border: 'none', cursor: 'pointer',
                    textAlign: 'left', fontFamily: 'inherit',
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = '#f5f4f1'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
                >
                  {cat}
                  {cat === link.category && (
                    <span style={{ fontSize: 11, color: '#bbb' }}>✓</span>
                  )}
                </button>
              ))}

              <div style={{ borderTop: '1px solid #f0f0ec', margin: '4px 0' }} />

              {addingCat ? (
                <div style={{ padding: '6px 10px' }}>
                  <input
                    autoFocus
                    value={newCatName}
                    onChange={(e) => setNewCatName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleNewCat()
                      if (e.key === 'Escape') { setAddingCat(false); setNewCatName('') }
                    }}
                    placeholder="Category name…"
                    style={{
                      width: '100%', fontSize: 13, padding: '5px 8px',
                      border: '1px solid #d8d8d4', borderRadius: 6,
                      outline: 'none', background: '#fff',
                      color: '#1a1a1a', fontFamily: 'inherit',
                    }}
                  />
                </div>
              ) : (
                <button
                  onClick={() => setAddingCat(true)}
                  style={{
                    display: 'block', width: '100%', padding: '7px 14px',
                    fontSize: 13, color: '#aaa',
                    background: 'none', border: 'none', cursor: 'pointer',
                    textAlign: 'left', fontFamily: 'inherit',
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = '#f5f4f1'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
                >
                  + New category
                </button>
              )}
            </div>
          )}
        </div>

        {/* Done button */}
        <button
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDone(link.id) }}
          title="Mark as done"
          style={{
            width: 24, height: 24, borderRadius: '50%',
            border: '1px solid #d8d8d4', background: '#fff',
            cursor: 'pointer', display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontSize: 11, color: '#aaa',
            transition: 'all 0.15s', fontFamily: 'inherit',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#1a1a1a'; e.currentTarget.style.color = '#1a1a1a' }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#d8d8d4'; e.currentTarget.style.color = '#aaa' }}
        >
          ✓
        </button>
      </div>
    </div>
  )
}
