// The open-loops review queue — top-level view for triaging Gmail-extracted
// commitments. Cards render via OpenLoopCard; the queue itself is a straight
// projection of lib/openloops.ts's `loadOpenQueue`.
//
// Data is passed in as props so App.tsx owns the subscription to
// later://state-changed — the queue shares state with the sidebar count and
// the Home banner, and one owner keeps them in lockstep.

import type { OpenLoop } from '../lib/openloops'
import { loadClosedCount } from '../lib/openloops'
import { OpenLoopCard } from './OpenLoopCard'

const CREAM = '#fafaf9'
const TEXT = '#1a1a1a'
const MUTED = '#888'

interface Props {
  loops: OpenLoop[]
  onAccept: (loop: OpenLoop) => void
  onReject: (loop: OpenLoop) => void
}

export function OpenLoopsPage({ loops, onAccept, onReject }: Props) {
  const open = loops.filter(l => l.status === 'open')
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
  const closed = loadClosedCount()

  return (
    <div style={{ flex: 1, padding: '48px 56px 24px', overflowY: 'auto', background: CREAM }}>
      <h1 style={{ fontSize: 28, fontWeight: 600, color: TEXT, letterSpacing: '-0.5px', marginBottom: 6, lineHeight: 1.2 }}>
        Open loops
      </h1>
      <div style={{ fontSize: 13, color: MUTED, marginBottom: 24 }}>
        {open.length} open · {closed} closed
      </div>
      <div style={{ maxWidth: 720 }}>
        {open.length === 0 ? (
          <EmptyState />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {open.map(l => (
              <OpenLoopCard key={l.id} loop={l} onAccept={onAccept} onReject={onReject} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function EmptyState() {
  return (
    <div style={{
      padding: '48px 32px', background: '#fff',
      border: '1px dashed #e0dfd9', borderRadius: 12,
      textAlign: 'center',
    }}>
      <div style={{ fontSize: 16, color: TEXT, marginBottom: 6, fontWeight: 500 }}>
        Nothing waiting on you.
      </div>
      <div style={{ fontSize: 13, color: MUTED, lineHeight: 1.5 }}>
        All caught up.
      </div>
    </div>
  )
}
