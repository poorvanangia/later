import { useState, useRef, useEffect } from 'react'

type Props = {
  onSave: (url: string) => void
  onViewLibrary: () => void
  onSignIn: () => void
  isSignedIn: boolean
}

export function HomePage({ onSave, onViewLibrary, onSignIn, isSignedIn }: Props) {
  const [url, setUrl] = useState('')
  const [saved, setSaved] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = url.trim()
    if (!trimmed) return
    const finalUrl = trimmed.startsWith('http') ? trimmed : `https://${trimmed}`
    onSave(finalUrl)
    setUrl('')
    setSaved(true)
  }

  return (
    <div style={{ minHeight: '100vh', background: '#fafaf9', display: 'flex', flexDirection: 'column' }}>
      {/* Top bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '24px 32px' }}>
        <span style={{ fontSize: 18, fontWeight: 600, color: '#1a1a1a', fontFamily: "'Fraunces', serif", letterSpacing: '-0.2px' }}>Later<span style={{ color: '#a10808' }}>.</span></span>
        {!isSignedIn && (
          <button
            onClick={onSignIn}
            style={{
              fontSize: 14, color: '#888', background: 'none', border: 'none',
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            Sign in
          </button>
        )}
        {isSignedIn && (
          <button
            onClick={onViewLibrary}
            style={{
              fontSize: 14, color: '#888', background: 'none', border: 'none',
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            My links →
          </button>
        )}
      </div>

      {/* Center content */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 24px' }}>
        <div style={{ width: '100%', maxWidth: 520, textAlign: 'center' }}>

          {!saved ? (
            <>
              <h1 style={{
                fontSize: 36, fontWeight: 600, color: '#1a1a1a',
                letterSpacing: '-1px', marginBottom: 8, lineHeight: 1.2,
              }}>
                Close the tab.
              </h1>
              <p style={{ fontSize: 16, color: '#aaa', marginBottom: 40, letterSpacing: '-0.1px' }}>
                It's safe here.
              </p>

              <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 10 }}>
                <input
                  ref={inputRef}
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="Paste a link…"
                  style={{
                    flex: 1, fontSize: 15, padding: '13px 18px',
                    border: '1px solid #e0e0dc', borderRadius: 10,
                    outline: 'none', background: '#fff', color: '#1a1a1a',
                    fontFamily: 'inherit',
                    boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
                  }}
                  onFocus={(e) => e.currentTarget.style.borderColor = '#c8c8c4'}
                  onBlur={(e) => e.currentTarget.style.borderColor = '#e0e0dc'}
                />
                <button
                  type="submit"
                  style={{
                    fontSize: 15, fontWeight: 500, color: '#fff',
                    background: '#1a1a1a', border: 'none', cursor: 'pointer',
                    padding: '13px 22px', borderRadius: 10, fontFamily: 'inherit',
                    whiteSpace: 'nowrap',
                  }}
                >
                  Save
                </button>
              </form>
            </>
          ) : (
            <div>
              <div style={{ fontSize: 32, fontWeight: 600, color: '#1a1a1a', letterSpacing: '-0.8px', marginBottom: 12 }}>
                Saved.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
                <button
                  onClick={() => setSaved(false)}
                  style={{
                    fontSize: 15, color: '#888', background: 'none', border: 'none',
                    cursor: 'pointer', fontFamily: 'inherit',
                  }}
                >
                  Save another link
                </button>
                <button
                  onClick={onViewLibrary}
                  style={{
                    fontSize: 15, fontWeight: 500, color: '#1a1a1a', background: 'none',
                    border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                  }}
                >
                  View saved links →
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
