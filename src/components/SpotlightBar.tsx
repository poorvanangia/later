import { useState, useRef, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'

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
  onSave: (text: string) => void
}

export function SpotlightBar({ onSave }: Props) {
  const [value, setValue] = useState('')
  const [saved, setSaved] = useState(false)
  const [placeholderIndex, setPlaceholderIndex] = useState(0)
  const [fade, setFade] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    // React stays mounted across hide/show cycles, so refocus when the window
    // regains focus — otherwise the next Cmd+Shift+L lands on a blurred input.
    const onFocus = () => inputRef.current?.focus()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

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
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        invoke('hide_spotlight').catch(() => {})
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = value.trim()
    if (!trimmed) return
    onSave(trimmed)
    setValue('')
    setSaved(true)
    setTimeout(() => setSaved(false), 1000)
    // Keep input focused so the user can chain more saves without re-opening.
    // The spotlight only dismisses on Escape (handler above) or click-outside
    // (Rust hides on Focused(false)).
    inputRef.current?.focus()
  }

  return (
    <div style={{
      width: '100vw',
      height: '100vh',
      margin: 0,
      padding: 0,
      background: '#ffffff',
      display: 'flex',
      alignItems: 'center',
    }}>
      <style>{`
        * { box-sizing: border-box; }
        body { margin: 0; padding: 0; background: #ffffff; }
        input::placeholder {
          color: #bbb;
          transition: opacity 0.3s ease;
        }
      `}</style>

      <form
        onSubmit={handleSubmit}
        style={{
          display: 'flex',
          alignItems: 'center',
          width: '100%',
          height: '100%',
        }}
      >
        {/* Later logo */}
        <div style={{
          padding: '0 16px 0 22px',
          display: 'flex',
          alignItems: 'center',
          flexShrink: 0,
        }}>
          {saved ? (
            <span style={{ fontSize: 18, color: '#2d8a4e' }}>✓</span>
          ) : (
            <span style={{
              fontSize: 17,
              fontWeight: 600,
              fontFamily: "'Fraunces', serif",
              color: '#1a1a1a',
              letterSpacing: '-0.2px',
            }}>
              L<span style={{ color: '#a10808' }}>.</span>
            </span>
          )}
        </div>

        {/* Divider */}
        <div style={{
          width: 1,
          height: 22,
          background: '#e8e8e4',
          marginRight: 16,
          flexShrink: 0,
        }} />

        {/* Input */}
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={saved ? 'Saved!' : PLACEHOLDERS[placeholderIndex]}
          style={{
            flex: 1,
            fontSize: 15,
            padding: 0,
            border: 'none',
            outline: 'none',
            background: 'transparent',
            color: '#1a1a1a',
            fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
            opacity: fade ? 1 : 0.3,
            transition: 'opacity 0.3s ease',
          }}
        />

        {/* Enter hint */}
        {value.length > 0 && !saved && (
          <div style={{
            padding: '0 20px',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flexShrink: 0,
          }}>
            <kbd style={{
              background: '#f4f4f2',
              border: '1px solid #e0e0dc',
              borderRadius: 5,
              padding: '3px 8px',
              fontSize: 11,
              color: '#888',
              fontFamily: 'inherit',
            }}>
              ↵
            </kbd>
            <span style={{ fontSize: 12, color: '#bbb' }}>save</span>
          </div>
        )}
      </form>
    </div>
  )
}
