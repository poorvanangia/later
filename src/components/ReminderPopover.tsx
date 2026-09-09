import { useEffect, useRef, useState } from 'react'
import { parseReminderNL } from '../lib/reminders'

type Props = {
  currentRemindAt: string | null | undefined
  onSet: (iso: string) => void
  onClear: () => void
  onClose: () => void
}

const SUGGESTIONS = [
  'In 1 hour',
  'Tonight',
  'Tomorrow 9am',
  'Next Monday',
]

// Small popover for setting a reminder on an item. Fast path: type "tomorrow
// 9am", hit Enter, worker parses via LLM, reminder scheduled. Fallback: if
// the LLM can't confidently parse, split date + time pickers appear inline
// so the user can pick manually. Never silently fails.
export function ReminderPopover({ currentRemindAt, onSet, onClear, onClose }: Props) {
  const [text, setText] = useState('')
  const [parsing, setParsing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showPicker, setShowPicker] = useState(false)
  const [dateValue, setDateValue] = useState(() => defaultDateStr())
  const [timeValue, setTimeValue] = useState(() => defaultTimeStr())
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  const commit = async (phrase: string) => {
    const q = phrase.trim()
    if (!q) return
    setParsing(true)
    setError(null)
    try {
      const result = await parseReminderNL(q)
      if (result.parsed) {
        onSet(result.parsed)
        onClose()
      } else {
        setError("Couldn't work that one out — pick manually below.")
        setShowPicker(true)
      }
    } finally {
      setParsing(false)
    }
  }

  const commitPicker = () => {
    if (!dateValue || !timeValue) { setError('Pick a date and time'); return }
    const dt = new Date(`${dateValue}T${timeValue}`)
    if (isNaN(dt.getTime())) { setError('That date/time didn\'t work'); return }
    if (dt.getTime() <= Date.now()) { setError('Pick a future time'); return }
    onSet(dt.toISOString())
    onClose()
  }

  return (
    <div
      ref={rootRef}
      onMouseDown={e => e.stopPropagation()}
      style={{
        position: 'absolute', right: 0, top: 'calc(100% + 8px)',
        background: '#fff', border: '1px solid #e8e8e4',
        borderRadius: 12, boxShadow: '0 10px 32px rgba(0,0,0,0.10)',
        padding: 12, width: 280, zIndex: 200,
        fontFamily: 'inherit',
        textAlign: 'left',
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 500, color: '#8a8a86', letterSpacing: '0.03em', textTransform: 'uppercase', marginBottom: 6 }}>
        Remind me
      </div>
      <input
        ref={inputRef}
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); commit(text) }
          if (e.key === 'Escape') { e.preventDefault(); onClose() }
        }}
        placeholder="tomorrow 9am, in 2 hours…"
        disabled={parsing}
        style={{
          width: '100%', fontSize: 13, padding: '8px 10px',
          border: '1px solid #d8d8d4', borderRadius: 8, outline: 'none',
          background: '#fff', color: '#1a1a1a', fontFamily: 'inherit',
          marginBottom: 8,
        }}
      />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
        {SUGGESTIONS.map(s => (
          <button
            key={s}
            onClick={() => commit(s)}
            disabled={parsing}
            style={{
              fontSize: 11, color: '#666', background: 'transparent',
              border: '1px solid #e2e0da', borderRadius: 999,
              padding: '3px 10px', cursor: parsing ? 'default' : 'pointer',
              fontFamily: 'inherit', opacity: parsing ? 0.5 : 1,
            }}
            onMouseEnter={e => { if (!parsing) e.currentTarget.style.background = '#f5f4f1' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
          >
            {s}
          </button>
        ))}
      </div>

      {parsing && (
        <div style={{ fontSize: 11, color: '#8a8a86', padding: '2px 0' }}>
          Parsing…
        </div>
      )}
      {error && !parsing && (
        <div style={{ fontSize: 11, color: '#8a5a30', background: '#fdf5eb', border: '1px solid #f0d89a', borderRadius: 6, padding: '5px 8px', marginBottom: 8, lineHeight: 1.4 }}>
          {error}
        </div>
      )}

      {showPicker && (
        <div style={{ borderTop: '1px solid #f0efe9', paddingTop: 10, marginTop: 4 }}>
          <div style={{ fontSize: 11, color: '#8a8a86', marginBottom: 6 }}>
            Or pick manually
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <input
              type="date"
              value={dateValue}
              min={defaultDateStr()}
              onChange={e => setDateValue(e.target.value)}
              style={pickerInputStyle}
            />
            <input
              type="time"
              value={timeValue}
              onChange={e => setTimeValue(e.target.value)}
              style={pickerInputStyle}
            />
          </div>
          <button
            onClick={commitPicker}
            style={{
              width: '100%', fontSize: 13, fontWeight: 500, color: '#fff',
              background: '#1a1a1a', border: 'none', borderRadius: 8,
              padding: '8px 12px', cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            Set reminder
          </button>
        </div>
      )}

      {currentRemindAt && (
        <button
          onClick={() => { onClear(); onClose() }}
          style={{
            marginTop: 10, fontSize: 11, color: '#8a8a86', background: 'none',
            border: 'none', cursor: 'pointer', fontFamily: 'inherit',
            padding: '2px 0',
          }}
        >
          Clear reminder
        </button>
      )}
    </div>
  )
}

const pickerInputStyle: React.CSSProperties = {
  flex: 1, minWidth: 0, fontSize: 12, padding: '6px 8px',
  border: '1px solid #d8d8d4', borderRadius: 6, outline: 'none',
  background: '#fff', color: '#1a1a1a', fontFamily: 'inherit',
}

function defaultDateStr(): string {
  const d = new Date()
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function defaultTimeStr(): string {
  const d = new Date(Date.now() + 60 * 60 * 1000)  // +1h from now, sensible default
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
