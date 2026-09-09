// Custom floating reminder popup — matches the visual reference:
//   ┌────────────────────────────┐
//   │      tiny reminder         │  ← bold title, centered
//   │   <the item's text here>   │  ← body message, centered
//   │────────────────────────────│  ← thin horizontal divider
//   │  Okay    │    Got it!      │  ← blue plain-text buttons, split
//   └────────────────────────────┘
//
// Warm cream card with soft frosted-glass backdrop. Fully rounded corners on
// all four sides — window itself is transparent so the pixels outside the
// card's border-radius render as invisible.
//
// Persistence: this popup writes fired_at and acknowledged_at directly to
// localStorage. Tauri v2 webviews under the same tauri://localhost origin
// share localStorage with the library window, so state updates land even
// if the library isn't currently mounted. See lib/reminders.ts::patchLinkFields.

import { useEffect } from 'react'
import { patchLinkFields } from './lib/reminders'

const params = new URLSearchParams(window.location.search)
const linkId = params.get('id') ?? ''
const bodyText = params.get('text') ?? ''

const IOS_BLUE = '#007aff'
const CARD_RADIUS = 16

export function ReminderPopup() {
  // Mark the reminder as presented as soon as the popup appears. If the user
  // ignores it and the app quits, we still won't re-fire on next boot.
  useEffect(() => {
    if (!linkId) return
    void patchLinkFields(linkId, { fired_at: new Date().toISOString() })
  }, [])

  const ackAndInvoke = async (cmd: 'close_reminder_window' | 'open_item_from_reminder') => {
    // Persist acknowledged_at BEFORE closing the window — otherwise the
    // webview may already be dead by the time the localStorage write lands,
    // depending on how fast Tauri tears it down.
    if (linkId) {
      await patchLinkFields(linkId, { acknowledged_at: new Date().toISOString() })
    }
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke(cmd, { linkId })
    } catch (e) {
      console.error(cmd, 'failed', e)
    }
  }
  const onOkay = () => { void ackAndInvoke('close_reminder_window') }
  const onView = () => { void ackAndInvoke('open_item_from_reminder') }

  return (
    <div
      style={{
        // Card fills the webview edge-to-edge — with the OS window shadow
        // disabled on the Rust side and no CSS blur-shadow here, there's
        // nothing to clip. Border-radius follows the webview shape directly.
        width: '100vw',
        height: '100vh',
        boxSizing: 'border-box',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: CARD_RADIUS,
          overflow: 'hidden',
          background: 'rgba(238, 232, 220, 0.94)',
          backdropFilter: 'blur(30px) saturate(150%)',
          WebkitBackdropFilter: 'blur(30px) saturate(150%)',
          // Just a hairline for definition — no blurred shadow that could
          // clip at the window boundary and paint that gray halo.
          boxShadow: '0 0 0 0.5px rgba(0, 0, 0, 0.08)',
          color: '#2b2b2b',
        }}
      >
        {/* Message area */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            padding: '12px 14px 10px',
            textAlign: 'center',
          }}
        >
          <div
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: '#2b2b2b',
              marginBottom: 5,
              letterSpacing: '-0.1px',
            }}
          >
            tiny reminder
          </div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 400,
              color: '#3a3a3a',
              lineHeight: 1.35,
              maxWidth: '100%',
              wordBreak: 'break-word',
            }}
          >
            {bodyText || 'Time to look at this.'}
          </div>
        </div>

        {/* Horizontal divider */}
        <div style={{ height: 0.5, background: 'rgba(0, 0, 0, 0.14)' }} />

        {/* Button row — two equal columns split by a thin vertical divider */}
        <div style={{ display: 'flex', height: 36, alignItems: 'stretch' }}>
          <button
            onClick={onOkay}
            style={{
              flex: 1,
              border: 'none',
              background: 'transparent',
              color: IOS_BLUE,
              fontSize: 12,
              fontFamily: 'inherit',
              cursor: 'pointer',
              padding: 0,
              // Round only the bottom-left corner so the button's hover fill
              // curves with the card at the bottom edge.
              borderBottomLeftRadius: CARD_RADIUS,
              transition: 'background 0.1s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.05)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
          >
            Okay
          </button>
          <div style={{ width: 0.5, background: 'rgba(0, 0, 0, 0.14)' }} />
          <button
            onClick={onView}
            style={{
              flex: 1,
              border: 'none',
              background: 'transparent',
              color: IOS_BLUE,
              fontSize: 12,
              fontFamily: 'inherit',
              cursor: 'pointer',
              padding: 0,
              borderBottomRightRadius: CARD_RADIUS,
              transition: 'background 0.1s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,0,0,0.05)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
          >
            View
          </button>
        </div>
      </div>
    </div>
  )
}
