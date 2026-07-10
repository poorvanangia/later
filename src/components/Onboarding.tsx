import { useState } from 'react'

type Step = 'howto' | 'email'

const CREAM = '#fafaf9'
const TEXT = '#1a1a1a'
const ACCENT = '#a10808'
const MUTED = '#999'
const MUTED_SOFT = '#aaa'
const CHIP_BG = '#f0f0ec'
const CHIP_BORDER = '#e0e0dc'

async function markDone() {
  try {
    localStorage.setItem('later:onboardingComplete', '1')
    localStorage.setItem('later:welcomeDone', '1')
  } catch { }
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('finalize_first_launch')
  } catch (e) {
    console.warn('[later/popup] finalize_first_launch failed', e)
  }
}

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>('howto')
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [thanks, setThanks] = useState(false)

  const finish = async () => { await markDone(); onDone() }

  const submit = async () => {
    const trimmed = email.trim()
    if (!trimmed) { await finish(); return }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError('That email doesn\'t look right — check it or skip.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('submit_email', { email: trimmed })
      setThanks(true)
      setTimeout(finish, 900)
    } catch (e) {
      setSubmitting(false)
      setError('Couldn\'t send that. Try again or skip.')
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: CREAM,
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '28px 24px 22px', zIndex: 100, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    }}>
      {step === 'howto' ? <HowTo onNext={() => setStep('email')} /> : (
        <EmailCard
          email={email}
          setEmail={setEmail}
          submitting={submitting}
          thanks={thanks}
          error={error}
          onSubmit={submit}
          onSkip={finish}
        />
      )}
    </div>
  )
}

function HowTo({ onNext }: { onNext: () => void }) {
  return (
    <>
      <span style={{ fontSize: 34, fontWeight: 600, color: TEXT, fontFamily: "'Fraunces', serif", letterSpacing: '-1px', marginBottom: 6 }}>
        Later<span style={{ color: ACCENT }}>.</span>
      </span>
      <span style={{ fontSize: 14, color: MUTED_SOFT, marginBottom: 28, textAlign: 'center' }}>
        Save anything. Find it when it matters.
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18, width: '100%', marginBottom: 24 }}>
        <Row chip="⌘ ⇧ L" title="Quick save from anywhere" body="Links, notes, tasks — press ⌘⇧L from any app on your Mac." />
        <Row chip="Menu bar" title="See your recent saves" body="Click the Later icon in your menu bar (top right) anytime." />
        <Row chip="This vault" title="Everything, organised" body="AI sorts your saves into categories automatically." />
      </div>
      <div style={{ flex: 1 }} />
      <button
        onClick={onNext}
        style={{
          fontSize: 15, fontWeight: 500, color: '#fff', background: TEXT,
          border: 'none', borderRadius: 10, padding: '12px 36px', cursor: 'pointer',
          fontFamily: 'inherit', width: '100%',
        }}
      >
        Next
      </button>
    </>
  )
}

function Row({ chip, title, body }: { chip: string; title: string; body: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
      <div style={{
        flexShrink: 0, width: 78, textAlign: 'center', fontSize: 12, fontWeight: 600,
        color: '#666', background: CHIP_BG, border: `1px solid ${CHIP_BORDER}`,
        borderRadius: 7, padding: '6px 8px',
      }}>{chip}</div>
      <div>
        <div style={{ fontSize: 14, fontWeight: 500, color: TEXT, marginBottom: 2 }}>{title}</div>
        <div style={{ fontSize: 12, color: MUTED, lineHeight: 1.5 }}>{body}</div>
      </div>
    </div>
  )
}

function EmailCard({
  email, setEmail, submitting, thanks, error, onSubmit, onSkip,
}: {
  email: string
  setEmail: (v: string) => void
  submitting: boolean
  thanks: boolean
  error: string | null
  onSubmit: () => void
  onSkip: () => void
}) {
  return (
    <>
      <span style={{ fontSize: 34, fontWeight: 600, color: TEXT, fontFamily: "'Fraunces', serif", letterSpacing: '-1px', marginBottom: 20 }}>
        Later<span style={{ color: ACCENT }}>.</span>
      </span>
      <div style={{ fontSize: 15, color: TEXT, textAlign: 'center', lineHeight: 1.5, marginBottom: 8 }}>
        Hi, I'm Poorva — I built Later.
      </div>
      <div style={{ fontSize: 13, color: MUTED, textAlign: 'center', lineHeight: 1.5, marginBottom: 24, maxWidth: 320 }}>
        Drop your email if you want to have a say in what I build next.
      </div>
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !submitting) onSubmit() }}
        placeholder="you@somewhere.com"
        autoFocus
        disabled={submitting || thanks}
        style={{
          width: '100%', fontSize: 14, padding: '11px 14px', borderRadius: 9,
          border: `1px solid ${CHIP_BORDER}`, background: '#fff', color: TEXT,
          fontFamily: 'inherit', outline: 'none', marginBottom: 12,
        }}
      />
      {error && (
        <div style={{ fontSize: 12, color: ACCENT, marginBottom: 10, textAlign: 'center', width: '100%' }}>
          {error}
        </div>
      )}
      <div style={{ flex: 1 }} />
      {thanks ? (
        <div style={{ fontSize: 14, color: TEXT, textAlign: 'center', padding: '12px 0' }}>
          Thanks — I'll be in touch.
        </div>
      ) : (
        <>
          <button
            onClick={onSubmit}
            disabled={submitting}
            style={{
              fontSize: 15, fontWeight: 500, color: '#fff',
              background: submitting ? '#555' : TEXT,
              border: 'none', borderRadius: 10, padding: '12px 36px',
              cursor: submitting ? 'default' : 'pointer',
              fontFamily: 'inherit', width: '100%', marginBottom: 10,
            }}
          >
            {submitting ? 'Sending…' : 'Submit'}
          </button>
          <button
            onClick={onSkip}
            disabled={submitting}
            style={{
              fontSize: 13, color: MUTED, background: 'none', border: 'none',
              cursor: submitting ? 'default' : 'pointer', textDecoration: 'underline',
              fontFamily: 'inherit', padding: '4px 8px',
            }}
          >
            Skip
          </button>
        </>
      )}
    </>
  )
}
