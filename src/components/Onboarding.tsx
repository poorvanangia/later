import { useState } from 'react'
import { loadUserProfile, saveUserProfile } from '../lib/profile'

type Step = 'howto' | 'profile' | 'email'

const CREAM = '#fafaf9'
const TEXT = '#1a1a1a'
const ACCENT = '#2d8a4e'
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
  const [profileText, setProfileText] = useState(() => loadUserProfile().text)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [thanks, setThanks] = useState(false)

  const finish = async () => { await markDone(); onDone() }

  // Save profile text (guaranteed non-empty because Continue is disabled on
  // empty input), then advance.
  const saveProfileAndNext = () => {
    const trimmed = profileText.trim()
    if (trimmed) saveUserProfile(trimmed)
    setStep('email')
  }
  // Skip without saving — user opted out. Nothing goes into localStorage.
  const skipProfile = () => setStep('email')

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

  const stepIndex = step === 'howto' ? 0 : step === 'profile' ? 1 : 2

  return (
    <div style={{
      position: 'fixed', inset: 0, background: CREAM,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 100, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    }}>
      <div style={{
        width: '100%', maxWidth: 480, padding: '40px 32px',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
      }}>
        {step === 'howto' && <HowTo onNext={() => setStep('profile')} />}
        {step === 'profile' && (
          <ProfileCard
            text={profileText}
            setText={setProfileText}
            onNext={saveProfileAndNext}
            onSkip={skipProfile}
          />
        )}
        {step === 'email' && (
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
        <StepDots active={stepIndex} total={3} />
      </div>
    </div>
  )
}

function StepDots({ active, total }: { active: number; total: number }) {
  return (
    <div style={{ display: 'flex', gap: 6, marginTop: 22 }}>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          style={{
            width: i === active ? 18 : 6, height: 6, borderRadius: 3,
            background: i === active ? TEXT : '#d8d8d4',
            transition: 'all 0.2s',
          }}
        />
      ))}
    </div>
  )
}

function HowTo({ onNext }: { onNext: () => void }) {
  return (
    <>
      <span style={{ fontSize: 34, fontWeight: 900, color: TEXT, fontFamily: "'Playfair Display', serif", letterSpacing: '-1px', marginBottom: 6 }}>
        Later<span style={{ color: ACCENT }}>.</span>
      </span>
      <span style={{ fontSize: 14, color: MUTED_SOFT, marginBottom: 28, textAlign: 'center' }}>
        Save anything. Find it when it matters.
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18, width: '100%', marginBottom: 24 }}>
        <Row chip="⌘ K" title="Quick save from anywhere" body="Links, notes, tasks — press ⌘K from any app on your Mac." />
        <Row chip="Menu bar" title="See your recent saves" body="Click the Later icon in your menu bar (top right) anytime." />
        <Row chip="This vault" title="Everything, organised" body="AI sorts your saves into categories automatically." />
      </div>
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

// Prefill starter phrases per role. Deliberately short and end with " — " so
// the caret lands in a natural continuation point ("Founder at a startup —│"),
// nudging the user toward finishing the sentence rather than staring at an
// empty box. Text goes into the textarea unedited; nothing is submitted until
// the user hits Continue.
const ROLE_PREFILLS: { label: string; prefill: string }[] = [
  { label: 'Founder',    prefill: 'Founder at a startup — focused on ' },
  { label: 'Engineer',   prefill: 'Software engineer at ' },
  { label: 'Marketer',   prefill: 'Marketer at ' },
  { label: 'Ops/People', prefill: 'Operations / People at ' },
]

function ProfileCard({
  text, setText, onNext, onSkip,
}: {
  text: string
  setText: (v: string) => void
  onNext: () => void
  onSkip: () => void
}) {
  const canContinue = text.trim().length > 0

  const applyPrefill = (prefill: string) => {
    // If the field is empty or matches a prior prefill exactly, replace it.
    // Otherwise leave the user's text alone — they've started writing.
    const current = text.trim()
    const isPriorPrefill = ROLE_PREFILLS.some(p => p.prefill.trim() === current)
    if (!current || isPriorPrefill) {
      setText(prefill)
    } else {
      setText(prefill)
    }
    // Focus and place caret at end so the user can start typing immediately.
    setTimeout(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('textarea[data-later-profile]')
      if (ta) { ta.focus(); ta.setSelectionRange(prefill.length, prefill.length) }
    }, 0)
  }

  return (
    <>
      <span style={{ fontSize: 34, fontWeight: 900, color: TEXT, fontFamily: "'Playfair Display', serif", letterSpacing: '-1px', marginBottom: 12 }}>
        Later<span style={{ color: ACCENT }}>.</span>
      </span>
      <div style={{ fontSize: 16, fontWeight: 500, color: TEXT, textAlign: 'center', lineHeight: 1.4, marginBottom: 8 }}>
        Who are you?
      </div>
      <div style={{ fontSize: 13, color: MUTED, textAlign: 'center', lineHeight: 1.5, marginBottom: 18, maxWidth: 360 }}>
        A few lines about your role, company, and what you focus on — Later uses this to sort your saves more intelligently.
      </div>

      {/* Role prefill chips — optional shortcut into writing. Muted styling so
          they read as helpers, not required choices. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center', marginBottom: 14, maxWidth: 380 }}>
        {ROLE_PREFILLS.map(({ label, prefill }) => (
          <button
            key={label}
            onClick={() => applyPrefill(prefill)}
            style={{
              fontSize: 12, color: '#666', background: 'transparent',
              border: `1px solid ${CHIP_BORDER}`, borderRadius: 999,
              padding: '5px 12px', cursor: 'pointer', fontFamily: 'inherit',
              transition: 'background 0.12s, border-color 0.12s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = CHIP_BG; e.currentTarget.style.borderColor = '#c8c8c4' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = CHIP_BORDER }}
          >
            {label}
          </button>
        ))}
      </div>

      <textarea
        data-later-profile=""
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canContinue) onNext() }}
        placeholder="e.g. Founder at an AI startup — hiring engineers, running GTM experiments, reading about company building."
        autoFocus
        rows={5}
        style={{
          width: '100%', fontSize: 13, padding: '11px 14px', borderRadius: 9,
          border: `1px solid ${CHIP_BORDER}`, background: '#fff', color: TEXT,
          fontFamily: 'inherit', outline: 'none', resize: 'none', lineHeight: 1.5,
          marginBottom: 14,
        }}
      />

      <button
        onClick={onNext}
        disabled={!canContinue}
        style={{
          fontSize: 15, fontWeight: 500,
          color: canContinue ? '#fff' : '#c8c8c4',
          background: canContinue ? TEXT : '#e8e8e4',
          border: 'none', borderRadius: 10, padding: '12px 36px',
          cursor: canContinue ? 'pointer' : 'not-allowed',
          fontFamily: 'inherit', width: '100%', marginBottom: 10,
          transition: 'background 0.15s, color 0.15s',
        }}
      >
        Continue
      </button>

      {/* Skip — demoted to a small text link. Reassurance about editing later
          is grouped with Skip specifically since that's what it's addressing. */}
      <button
        onClick={onSkip}
        style={{
          fontSize: 13, color: MUTED, background: 'none', border: 'none',
          cursor: 'pointer', fontFamily: 'inherit', padding: '2px 8px',
          textDecoration: 'underline',
        }}
      >
        Skip for now
      </button>
      <div style={{ fontSize: 11, color: MUTED_SOFT, textAlign: 'center', marginTop: 4 }}>
        You can change this anytime in Settings.
      </div>
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
      <span style={{ fontSize: 34, fontWeight: 900, color: TEXT, fontFamily: "'Playfair Display', serif", letterSpacing: '-1px', marginBottom: 20 }}>
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
