import { useState } from 'react'
import { loadUserProfile, saveUserProfile, loadUserEmail, saveUserEmail } from '../lib/profile'

export function SettingsPage() {
  const [savedText, setSavedText] = useState(() => loadUserProfile().text)
  const [text, setText] = useState(savedText)
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle')
  const hasChanges = text.trim() !== savedText

  const save = () => {
    if (!hasChanges) return
    const saved = saveUserProfile(text)
    const persisted = loadUserProfile()
    if (persisted.text !== saved.text || persisted.updatedAt !== saved.updatedAt) {
      setStatus('error')
      return
    }
    setSavedText(saved.text)
    setText(saved.text)
    setStatus('saved')
  }

  const cancel = () => {
    setText(savedText)
    setStatus('idle')
  }

  return (
    <div style={{ flex: 1, padding: '48px 56px 24px', overflowY: 'auto', background: '#fafaf9' }}>
      <h1 style={{ fontSize: 28, fontWeight: 600, color: '#1a1a1a', letterSpacing: '-0.5px', marginBottom: 24, lineHeight: 1.2 }}>
        Settings
      </h1>
      <section aria-labelledby="profile-heading" style={{ maxWidth: 640, background: '#fff', border: '1px solid #e8e8e4', borderRadius: 12, padding: 24 }}>
        <h2 id="profile-heading" style={{ fontSize: 17, fontWeight: 600, color: '#1a1a1a', margin: '0 0 8px' }}>About you</h2>
        <p id="profile-description" style={{ fontSize: 13, color: '#777', lineHeight: 1.6, margin: '0 0 20px' }}>
          Your role, interests, and what you focus on. Later uses this context to help categorize new saves.
        </p>
        <form onSubmit={event => { event.preventDefault(); save() }}>
          <label htmlFor="profile-text" style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#1a1a1a', marginBottom: 8 }}>Who are you?</label>
          <textarea
            id="profile-text"
            aria-describedby="profile-description profile-hint"
            value={text}
            onChange={event => { setText(event.target.value); setStatus('idle') }}
            onKeyDown={event => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                event.stopPropagation()
                save()
              }
            }}
            placeholder="e.g. Founder at an AI startup — hiring engineers, running GTM experiments, reading about company building."
            rows={6}
            style={{ display: 'block', boxSizing: 'border-box', width: '100%', minHeight: 140, resize: 'vertical', padding: '12px 14px', border: '1px solid #deded8', borderRadius: 8, fontFamily: 'inherit', fontSize: 13, lineHeight: 1.6, color: '#1a1a1a', background: '#fafaf9' }}
          />
          <p id="profile-hint" style={{ fontSize: 12, color: '#888', lineHeight: 1.5, margin: '8px 0 20px' }}>
            Optional. Clear the text and save to remove your profile. Existing tasks stay as they are.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <button type="submit" disabled={!hasChanges} style={{ padding: '9px 16px', border: 'none', borderRadius: 7, background: hasChanges ? '#1a1a1a' : '#eeede9', color: hasChanges ? '#fff' : '#999', fontSize: 13, fontWeight: 500, fontFamily: 'inherit', cursor: hasChanges ? 'pointer' : 'default' }}>
              Save changes
            </button>
            {hasChanges && <button type="button" onClick={cancel} style={{ padding: '9px 4px', border: 'none', background: 'transparent', color: '#666', fontSize: 13, fontFamily: 'inherit', cursor: 'pointer' }}>Cancel</button>}
            <span role="status" style={{ fontSize: 12, color: status === 'error' ? '#a33a2b' : '#2d8a4e' }}>
              {status === 'saved' ? 'Saved' : status === 'error' ? 'Couldn’t save your profile. Please try again.' : ''}
            </span>
          </div>
        </form>
      </section>
      <EmailSettings />
    </div>
  )
}

function EmailSettings() {
  const [savedEmail, setSavedEmail] = useState(loadUserEmail)
  const [email, setEmail] = useState(savedEmail)
  const [status, setStatus] = useState('')
  const [error, setError] = useState(false)
  const hasChanges = email.trim() !== savedEmail

  return (
    <section aria-labelledby="email-heading" style={{ maxWidth: 640, marginTop: 20, background: '#fff', border: '1px solid #e8e8e4', borderRadius: 12, padding: 24 }}>
      <h2 id="email-heading" style={{ fontSize: 17, fontWeight: 600, color: '#1a1a1a', margin: '0 0 8px' }}>Email address</h2>
      <p id="email-description" style={{ fontSize: 13, color: '#777', lineHeight: 1.6, margin: '0 0 20px' }}>
        Your email saved on this Mac. Editing it here doesn’t change previous email subscriptions.
      </p>
      <form onSubmit={event => {
        event.preventDefault()
        if (!hasChanges) return
        if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
          setError(true)
          setStatus('Enter a valid email address.')
          return
        }
        try {
          saveUserEmail(email)
          setSavedEmail(email.trim())
          setEmail(email.trim())
          setError(false)
          setStatus('Saved')
        } catch {
          setError(true)
          setStatus('Couldn’t save your email. Please try again.')
        }
      }}>
        <label htmlFor="settings-email" style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#1a1a1a', marginBottom: 8 }}>Email</label>
        <input
          id="settings-email"
          type="email"
          autoComplete="email"
          maxLength={320}
          aria-describedby="email-description email-hint"
          value={email}
          onChange={event => { setEmail(event.target.value); setStatus(''); setError(false) }}
          placeholder="you@example.com"
          style={{ boxSizing: 'border-box', width: '100%', padding: '12px 14px', border: '1px solid #deded8', borderRadius: 8, fontFamily: 'inherit', fontSize: 13, color: '#1a1a1a', background: '#fafaf9' }}
        />
        <p id="email-hint" style={{ fontSize: 12, color: '#888', lineHeight: 1.5, margin: '8px 0 20px' }}>
          Optional. If your onboarding email isn’t shown, add it here. Clear and save to remove it from this Mac.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <button type="submit" disabled={!hasChanges} style={{ padding: '9px 16px', border: 'none', borderRadius: 7, background: hasChanges ? '#1a1a1a' : '#eeede9', color: hasChanges ? '#fff' : '#999', fontSize: 13, fontWeight: 500, fontFamily: 'inherit', cursor: hasChanges ? 'pointer' : 'default' }}>Save email</button>
          {hasChanges && <button type="button" onClick={() => { setEmail(savedEmail); setStatus(''); setError(false) }} style={{ padding: '9px 4px', border: 'none', background: 'transparent', color: '#666', fontSize: 13, fontFamily: 'inherit', cursor: 'pointer' }}>Cancel</button>}
          <span role="status" style={{ fontSize: 12, color: error ? '#a33a2b' : '#2d8a4e' }}>{status}</span>
        </div>
      </form>
    </section>
  )
}
