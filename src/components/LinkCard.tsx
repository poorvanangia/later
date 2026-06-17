import type { LinkRow } from '../lib/supabase'

const CATEGORY_COLORS: Record<string, string> = {
  Read: '#4f7fe8',
  Watch: '#e05c5c',
  Cook: '#e07f2a',
  Shop: '#7b5ea7',
  Book: '#3aaa7a',
  Research: '#5a8a9f',
  Misc: '#999',
}

type Props = {
  link: LinkRow
  onDone: (id: string) => void
}

export function LinkCard({ link, onDone }: Props) {
  const color = CATEGORY_COLORS[link.category ?? ''] ?? '#999'

  const metaText = () => {
    if (!link.ai_processed) return null
    const parts: string[] = []
    if (link.category) parts.push(link.category)
    if (link.intent === 'read' && link.read_time_minutes) {
      parts.push(`${link.read_time_minutes} min read`)
    } else if (link.intent === 'act') {
      parts.push('To act on')
    }
    return parts.join(' · ')
  }

  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        background: '#fff',
        border: '1px solid #ebebeb',
        borderRadius: 12,
        padding: '18px 20px',
        cursor: 'pointer',
        transition: 'border-color 0.15s',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        gap: 12,
        opacity: link.is_done ? 0.45 : 1,
        textDecoration: 'none',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = '#d0d0d0')}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = '#ebebeb')}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 16,
            fontWeight: 500,
            color: '#1a1a1a',
            lineHeight: '1.4',
            marginBottom: 6,
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
          }}
        >
          {link.label || link.title || link.url}
        </div>

        {!link.ai_processed ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div className="shimmer" style={{ width: 60, height: 12 }} />
            <div className="shimmer" style={{ width: 80, height: 12 }} />
          </div>
        ) : (
          <div style={{ fontSize: 13, color: '#aaa', display: 'flex', alignItems: 'center', gap: 6 }}>
            {link.category && (
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  background: color,
                  display: 'inline-block',
                  flexShrink: 0,
                }}
              />
            )}
            {metaText()}
          </div>
        )}
      </div>

      <button
        onClick={(e) => {
          e.stopPropagation()
          onDone(link.id)
        }}
        title="Mark as done"
        style={{
          flexShrink: 0,
          width: 28,
          height: 28,
          borderRadius: '50%',
          border: '1.5px solid #e8e8e6',
          background: 'none',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#ccc',
          fontSize: 13,
          transition: 'all 0.15s',
          marginTop: 1,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = '#1a1a1a'
          e.currentTarget.style.color = '#1a1a1a'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = '#e8e8e6'
          e.currentTarget.style.color = '#ccc'
        }}
      >
        ✓
      </button>
    </a>
  )
}
