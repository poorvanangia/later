import { useState, useEffect, useRef } from 'react'

type Props = {
  open: boolean
  onClose: () => void
  onSave: (url: string, note: string) => void
}

export function SaveModal({ open, onClose, onSave }: Props) {
  const [url, setUrl] = useState('')
  const [note, setNote] = useState('')
  const [showNote, setShowNote] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setUrl('')
      setNote('')
      setShowNote(false)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = url.trim()
    if (!trimmed) return
    const finalUrl = trimmed.startsWith('http') ? trimmed : `https://${trimmed}`
    onSave(finalUrl, note.trim())
    onClose()
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.18)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        style={{
          background: '#fff',
          borderRadius: 16,
          padding: '28px 28px 24px',
          width: '100%',
          maxWidth: 480,
          margin: '0 16px',
          boxShadow: '0 8px 40px rgba(0,0,0,0.12)',
        }}
      >
        <div style={{ marginBottom: 6, fontSize: 13, color: '#999', fontWeight: 500, letterSpacing: '0.02em' }}>
          SAVE A LINK
        </div>
        <form onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Paste any URL…"
            style={{
              width: '100%',
              fontSize: 16,
              padding: '12px 0',
              border: 'none',
              borderBottom: '1.5px solid #e8e8e6',
              outline: 'none',
              background: 'transparent',
              color: '#1a1a1a',
              fontFamily: 'inherit',
            }}
          />

          {showNote ? (
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add a note (optional)…"
              rows={2}
              style={{
                width: '100%',
                fontSize: 14,
                padding: '10px 0',
                border: 'none',
                borderBottom: '1.5px solid #e8e8e6',
                outline: 'none',
                background: 'transparent',
                color: '#555',
                fontFamily: 'inherit',
                resize: 'none',
                marginTop: 4,
              }}
            />
          ) : (
            <button
              type="button"
              onClick={() => setShowNote(true)}
              style={{
                marginTop: 10,
                fontSize: 13,
                color: '#bbb',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
                fontFamily: 'inherit',
              }}
            >
              + add a note
            </button>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                fontSize: 14,
                color: '#aaa',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '8px 14px',
                fontFamily: 'inherit',
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              style={{
                fontSize: 14,
                fontWeight: 500,
                color: '#fff',
                background: '#1a1a1a',
                border: 'none',
                cursor: 'pointer',
                padding: '8px 20px',
                borderRadius: 8,
                fontFamily: 'inherit',
              }}
            >
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
