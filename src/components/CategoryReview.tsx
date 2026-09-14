import { useRef, useState } from 'react'
import type { StarterCategory } from '../lib/starterCategories'

type Props = {
  initial: StarterCategory[]
  onApply: (categories: StarterCategory[]) => void
  onSkip: () => void
}

export function CategoryReview({ initial, onApply, onSkip }: Props) {
  const nextId = useRef(initial.length)
  const [items, setItems] = useState(() => initial.map((item, index) => ({ ...item, id: index })))
  const update = (index: number, patch: Partial<StarterCategory>) => setItems(current => current.map((item, i) => i === index ? { ...item, ...patch } : item))
  const add = () => setItems(current => [...current, { name: '', description: '', id: nextId.current++ }])
  const remove = (index: number) => setItems(current => current.filter((_, i) => i !== index))
  const apply = () => {
    const cleaned = items.map(item => ({ name: item.name.trim(), description: item.description.trim() })).filter(item => item.name)
    if (!cleaned.length) return onSkip()
    onApply(cleaned)
  }
  return <div style={{ position: 'fixed', inset: 0, zIndex: 120, background: 'rgba(250,250,249,.97)', display: 'flex', justifyContent: 'center', alignItems: 'center', padding: 24, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
    <div style={{ width: '100%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto' }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 24, color: '#1a1a1a' }}>Your starter categories</h2>
      <p style={{ margin: '0 0 20px', color: '#777', fontSize: 13, lineHeight: 1.5 }}>Review, rename, add, or remove anything before applying.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {items.map((item, index) => <div key={item.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input value={item.name} onChange={e => update(index, { name: e.target.value })} placeholder="Category name" style={{ ...inputStyle, flex: '0 0 38%' }} autoFocus={index === 0} />
          <input value={item.description} onChange={e => update(index, { description: e.target.value })} placeholder="What belongs here? (optional)" style={{ ...inputStyle, color: '#666' }} />
          <button onClick={() => remove(index)} aria-label={`Remove ${item.name || 'category'}`} style={removeStyle}>×</button>
        </div>)}
      </div>
      <button onClick={add} style={linkStyle}>+ Add category</button>
      <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
        <button onClick={apply} style={primaryStyle}>Apply categories</button>
        <button onClick={onSkip} style={secondaryStyle}>Skip</button>
      </div>
    </div>
  </div>
}

const inputStyle = { boxSizing: 'border-box' as const, width: '100%', padding: '10px 12px', border: '1px solid #deded8', borderRadius: 8, background: '#fff', fontSize: 13, fontFamily: 'inherit', outline: 'none' }
const removeStyle = { border: 'none', background: 'none', color: '#999', fontSize: 22, cursor: 'pointer', padding: '6px 4px' }
const linkStyle = { border: 'none', background: 'none', color: '#666', padding: '12px 0', cursor: 'pointer', fontSize: 13 }
const primaryStyle = { border: 'none', borderRadius: 8, background: '#1a1a1a', color: '#fff', padding: '11px 16px', cursor: 'pointer', fontSize: 13 }
const secondaryStyle = { border: '1px solid #deded8', borderRadius: 8, background: '#fff', color: '#666', padding: '11px 16px', cursor: 'pointer', fontSize: 13 }
