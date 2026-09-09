// One row in the open-loops review queue. Reused across the queue view; the
// styling is a straight lift from the (now-removed) ExtractionsPreview in
// Settings, with tick/cross action buttons added so this is an actionable
// card rather than a read-only preview.

import { formatDueDate, type OpenLoop, type OpenLoopType } from '../lib/openloops'

const TEXT = '#1a1a1a'
const MUTED = '#888'

interface Props {
  loop: OpenLoop
  onAccept: (loop: OpenLoop) => void
  onReject: (loop: OpenLoop) => void
}

export function OpenLoopCard({ loop, onAccept, onReject }: Props) {
  return (
    <div style={{
      padding: '14px 16px', background: '#fff', border: '1px solid #e8e8e4',
      borderRadius: 10, display: 'flex', gap: 14, alignItems: 'flex-start',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={typeBadgeStyle(loop.type)}>{loop.type}</span>
          {loop.due_at && (
            <span style={{ fontSize: 11, color: '#7a7a76' }}>
              due {formatDueDate(loop.due_at)}
            </span>
          )}
        </div>
        <div style={{ fontSize: 15, color: TEXT, marginBottom: 4, lineHeight: 1.4, fontWeight: 500 }}>
          {loop.summary}
        </div>
        <div style={{ fontSize: 12, color: MUTED, marginBottom: loop.quoted_clause ? 6 : 0 }}>
          {loop.sender_name || loop.sender_email}
          {loop.sender_name && ` <${loop.sender_email}>`}
        </div>
        {loop.quoted_clause && (
          <div style={{
            fontSize: 12, color: '#5a5a56', fontStyle: 'italic',
            borderLeft: '2px solid #d8d8d4', paddingLeft: 8, marginTop: 4, lineHeight: 1.5,
          }}>
            “{loop.quoted_clause}”
          </div>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
        <button
          onClick={() => onAccept(loop)}
          title="Accept — turn into an item"
          style={actionButtonStyle('accept')}
          onMouseEnter={e => { e.currentTarget.style.background = '#e0efe4'; e.currentTarget.style.color = '#1e6b3a' }}
          onMouseLeave={e => { e.currentTarget.style.background = '#eef5f0'; e.currentTarget.style.color = '#2d8a4e' }}
        >✓</button>
        <button
          onClick={() => onReject(loop)}
          title="Reject — dismiss without saving"
          style={actionButtonStyle('reject')}
          onMouseEnter={e => { e.currentTarget.style.background = '#f5f4f1'; e.currentTarget.style.color = '#666' }}
          onMouseLeave={e => { e.currentTarget.style.background = '#f9f8f5'; e.currentTarget.style.color = '#999' }}
        >✕</button>
      </div>
    </div>
  )
}

function typeBadgeStyle(t: OpenLoopType): React.CSSProperties {
  // Distinct palette per type. Events get a warm purple — chosen because it's
  // the only one visually removed from action-and-money palette (blue/green/
  // amber for promise/pending/bill), which reinforces that events are about
  // time-and-place, not owed work.
  const colors: Record<OpenLoopType, { bg: string; fg: string }> = {
    promise: { bg: '#eef2fa', fg: '#3a5aa8' },
    pending: { bg: '#eef5f0', fg: '#2d8a4e' },
    bill:    { bg: '#fdf5eb', fg: '#8a5a30' },
    event:   { bg: '#f4eff8', fg: '#6a3ea0' },
  }
  const c = colors[t]
  return {
    fontSize: 10, fontWeight: 600, color: c.fg, background: c.bg,
    padding: '2px 8px', borderRadius: 999, letterSpacing: '0.03em',
    textTransform: 'uppercase',
  }
}

function actionButtonStyle(kind: 'accept' | 'reject'): React.CSSProperties {
  const accept = kind === 'accept'
  return {
    width: 28, height: 28, borderRadius: 6, border: 'none',
    background: accept ? '#eef5f0' : '#f9f8f5',
    color: accept ? '#2d8a4e' : '#999',
    cursor: 'pointer', fontSize: 15, fontWeight: 600,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: 'inherit', padding: 0,
    transition: 'background 0.12s, color 0.12s',
  }
}
