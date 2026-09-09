import type { PendingSuggestion } from '../lib/classifier'

type Props = {
  suggestion: PendingSuggestion
  onAccept: () => void
  onReject: () => void
}

// Small always-visible chip that replaces the standard category button while
// the classifier is unsure. Three variants:
//  - kind: 'reasoning' — placeholder while the second-pass (Sonnet + thinking)
//    call is in flight. No ✓/✗; shows a pulsing "Thinking…" label.
//  - kind: 'existing' — a plausible existing category the model is not
//    confident about. ✓ applies it, ✗ leaves the item uncategorized.
//  - kind: 'new' — a proposed brand-new category with an AI-drafted
//    description. ✓ adds it to the sidebar with that description; ✗ discards.
export function PendingSuggestionChip({ suggestion, onAccept, onReject }: Props) {
  if (suggestion.kind === 'reasoning') {
    return <ThinkingChip fallback={suggestion.fallbackCategory} />
  }

  const label = suggestion.category
  const reasonSuffix = suggestion.reason ? `\n\nWhy: ${suggestion.reason}` : ''
  const tooltip = suggestion.kind === 'new'
    ? `Suggested new category — ${suggestion.description || 'confirm to add to sidebar'}${reasonSuffix}`
    : `Suggested category — confirm or reject${reasonSuffix}`

  return (
    <div
      title={tooltip}
      onMouseDown={e => e.stopPropagation()}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
        background: '#f5f4f1',
        border: '1px solid #e2e0da',
        borderRadius: 999,
        padding: '3px 10px 3px 12px',
        fontSize: 13,
        color: '#3a3a3a',
        fontFamily: 'inherit',
        fontWeight: 500,
        maxWidth: 240,
        overflow: 'hidden',
        boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
      }}
    >
      <span
        style={{
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          maxWidth: 160,
        }}
      >
        {label}
      </span>
      <button
        onClick={e => { e.preventDefault(); e.stopPropagation(); onAccept() }}
        aria-label={`Accept ${label}`}
        title="Accept"
        style={chipBtnStyle('#4a8f5c')}
      >
        ✓
      </button>
      <button
        onClick={e => { e.preventDefault(); e.stopPropagation(); onReject() }}
        aria-label={`Reject ${label}`}
        title="Reject"
        style={chipBtnStyle('#8a8a86')}
      >
        ✕
      </button>
    </div>
  )
}

function ThinkingChip({ fallback }: { fallback: string }) {
  return (
    <div
      title={`Thinking harder about "${fallback}"…\n\nA reasoning model is double-checking the category.`}
      onMouseDown={e => e.stopPropagation()}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        flexShrink: 0,
        background: '#f5f4f1',
        border: '1px solid #e2e0da',
        borderRadius: 999,
        padding: '3px 12px',
        fontSize: 13,
        color: '#8a8a86',
        fontFamily: 'inherit',
        fontWeight: 500,
        boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
      }}
    >
      <span
        style={{
          display: 'inline-block',
          width: 10, height: 10, borderRadius: '50%',
          border: '2px solid #d8d8d4',
          borderTopColor: '#8a8a86',
          animation: 'later-spin 0.9s linear infinite',
        }}
      />
      <span>Thinking…</span>
      <style>{`@keyframes later-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}

function chipBtnStyle(color: string): React.CSSProperties {
  return {
    width: 18, height: 18,
    borderRadius: '50%',
    border: 'none',
    background: 'transparent',
    color,
    fontSize: 13,
    lineHeight: '18px',
    padding: 0,
    cursor: 'pointer',
    fontFamily: 'inherit',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  }
}
