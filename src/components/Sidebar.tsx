import { useState } from 'react'

type Props = {
  categories: string[]
  activeView: string
  onNavigate: (view: string) => void
  onAddCategory: (name: string) => void
}

export function Sidebar({ categories, activeView, onNavigate, onAddCategory }: Props) {
  const [adding, setAdding] = useState(false)
  const [newCat, setNewCat] = useState('')

  const submitNewCategory = () => {
    const trimmed = newCat.trim()
    if (trimmed) onAddCategory(trimmed)
    setNewCat('')
    setAdding(false)
  }

  const navItem = (label: string, view: string) => {
    const active = activeView === view
    return (
      <button
        key={view}
        onClick={() => onNavigate(view)}
        style={{
          display: 'block',
          width: '100%',
          textAlign: 'left',
          padding: '6px 12px',
          fontSize: 14,
          fontWeight: active ? 500 : 400,
          color: active ? '#1a1a1a' : '#888',
          background: active ? '#eeede9' : 'none',
          border: 'none',
          borderRadius: 6,
          cursor: 'pointer',
          fontFamily: 'inherit',
          transition: 'background 0.1s, color 0.1s',
        }}
        onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = '#f2f1ed' }}
        onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'none' }}
      >
        {label}
      </button>
    )
  }

  return (
    <div style={{
      width: 200,
      flexShrink: 0,
      background: '#f5f4f1',
      borderRight: '1px solid #e8e8e4',
      height: '100vh',
      position: 'sticky',
      top: 0,
      display: 'flex',
      flexDirection: 'column',
      padding: '20px 12px',
      overflowY: 'auto',
    }}>
      {/* Logo */}
      <button
        onClick={() => onNavigate('home')}
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          padding: '4px 12px', marginBottom: 24, fontFamily: 'inherit',
          textAlign: 'left',
        }}
      >
        <span style={{ fontSize: 18, fontWeight: 600, color: '#1a1a1a', fontFamily: "'Fraunces', serif", letterSpacing: '-0.2px' }}>Later<span style={{ color: '#a10808' }}>.</span></span>
      </button>

      {/* Main nav */}
      <div style={{ marginBottom: 24 }}>
        {navItem('Home', 'home')}
        {navItem('All Links', 'library')}
      </div>

      {/* Categories */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 12px', marginBottom: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: '#bbb', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            Categories
          </span>
          <button
            onClick={() => setAdding(true)}
            title="New category"
            style={{
              width: 18, height: 18, borderRadius: 4, border: '1px solid #d8d8d4',
              background: 'none', cursor: 'pointer', fontSize: 14, color: '#aaa',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              lineHeight: 1, fontFamily: 'inherit', padding: 0,
            }}
          >
            +
          </button>
        </div>

        {categories.map((cat) => navItem(cat, `cat:${cat}`))}

        {adding && (
          <div style={{ padding: '4px 12px' }}>
            <input
              autoFocus
              value={newCat}
              onChange={(e) => setNewCat(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitNewCategory()
                if (e.key === 'Escape') { setAdding(false); setNewCat('') }
              }}
              onBlur={submitNewCategory}
              placeholder="Category name…"
              style={{
                width: '100%', fontSize: 13, padding: '5px 8px',
                border: '1px solid #d8d8d4', borderRadius: 6,
                outline: 'none', background: '#fff',
                color: '#1a1a1a', fontFamily: 'inherit',
              }}
            />
          </div>
        )}
      </div>
    </div>
  )
}
