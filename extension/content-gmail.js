// Later — Gmail content script.
//
// On Cmd+Shift+L (routed via the background service worker), read the
// currently-open email's subject, sender, thread + message IDs from Gmail's
// DOM and hand off to the Later Tauri app via a later:// deep link.
//
// Known DOM anchors we rely on (obfuscation-resistant, but not immortal):
//   - h2.hP                       → thread subject header
//   - .gD                         → top open message's sender (name attr +
//                                   email attr on the same element)
//   - [data-legacy-message-id]    → per-message stable ID
//   - location.hash /inbox/<id>   → thread ID
//   - location.pathname /mail/u/N/→ Google account index
//
// If Gmail redesigns any of these away, we fall back gracefully: save with
// whatever we DID find and warn the user via toast. Preferable to silently
// dropping the save.

;(function () {
  const LOG = '[Later ext]'
  const SAVED_KEY = 'later:savedThreadIds'
  const savedIds = new Set()

  chrome.storage.local.get(SAVED_KEY, r => {
    for (const id of r[SAVED_KEY] || []) savedIds.add(id)
    scanInbox()
  })

  function markSaved(threadId) {
    if (!threadId || savedIds.has(threadId)) return
    savedIds.add(threadId)
    chrome.storage.local.set({ [SAVED_KEY]: [...savedIds] })
    scanInbox()
  }

  function scanInbox() {
    let missing = 0
    for (const row of document.querySelectorAll('tr.zA')) {
      const id = row.querySelector('[data-legacy-thread-id]')?.getAttribute('data-legacy-thread-id')
      if (!id || !savedIds.has(id)) continue
      if (row.querySelector('.later-saved-badge')) continue
      const star = row.querySelector('.T-KT')
      if (!star) { missing++; continue }
      star.parentElement.insertBefore(makeBadge(), star.nextSibling)
    }
    if (missing) console.warn(LOG, `star anchor (.T-KT) missing on ${missing} row(s) — Gmail redesign?`)
  }

  const BADGE_ICON_URL = chrome.runtime.getURL('icons/later-badge.png')

  function makeBadge() {
    const span = document.createElement('span')
    span.className = 'later-saved-badge'
    span.title = 'Saved to Later'
    span.style.cssText = 'display:inline-flex;align-items:center;margin-left:4px;vertical-align:middle;flex-shrink:0'
    const img = document.createElement('img')
    img.src = BADGE_ICON_URL
    img.width = 20
    img.height = 20
    img.alt = ''
    img.style.cssText = 'opacity:0.45;filter:grayscale(1)'
    span.appendChild(img)
    return span
  }

  let scanTimer = null
  new MutationObserver(() => {
    if (scanTimer) return
    scanTimer = setTimeout(() => { scanTimer = null; scanInbox() }, 150)
  }).observe(document.body, { childList: true, subtree: true })

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'later:save-current') return
    try {
      const ok = trySave()
      sendResponse({ ok })
    } catch (e) {
      console.warn(LOG, 'save failed:', e)
      showToast('Couldn\'t save — try reloading Gmail')
      sendResponse({ ok: false, error: String(e) })
    }
    // No async work — safe to return false, but returning true keeps the
    // channel open in case we ever add async extraction later.
    return true
  })

  function trySave() {
    const data = extractEmail()
    if (!data) return false  // extractEmail already toasted the reason

    const params = new URLSearchParams({
      title: data.subject || 'Untitled email',
      sender: data.senderName || '',
      senderEmail: data.senderEmail || '',
      threadId: data.threadId,
      messageId: data.messageId || '',
      gmailUrl: data.gmailUrl,
    })
    const deepLink = `later://save?${params.toString()}`
    console.log(LOG, 'handing off →', deepLink)

    // Hidden iframe pattern: appending an iframe whose src is a custom-scheme
    // URL triggers the OS handler without navigating the top-level page.
    // Chrome shows an "Open in Later?" prompt on first use; the user can
    // check "Always allow" and subsequent triggers pass through instantly.
    const iframe = document.createElement('iframe')
    iframe.style.display = 'none'
    iframe.src = deepLink
    document.body.appendChild(iframe)
    // Give the browser a beat to fire the handoff, then clean up.
    setTimeout(() => iframe.remove(), 200)

    markSaved(data.legacyThreadId || data.threadId)
    const shortSubject = truncate(data.subject || 'this email', 44)
    showToast(`Saved to Later — ${shortSubject}`)
    return true
  }

  function extractEmail() {
    // -------- Thread ID (from URL hash) --------
    // Conversation view URLs look like:
    //   https://mail.google.com/mail/u/0/#inbox/FMfcgzGxRnjSHXXX
    //   https://mail.google.com/mail/u/1/#label/foo/FMfcgz...
    // We take the last hash segment. Sanity-check the length so labels like
    // "inbox" or "sent" don't get treated as thread IDs (list-view case).
    const hashPath = location.hash.replace(/^#/, '').split('?')[0]
    const segments = hashPath.split('/').filter(Boolean)
    const lastSeg = segments[segments.length - 1] || ''
    const isThreadIdShaped = /^[A-Za-z0-9_-]{12,}$/.test(lastSeg)
    if (!isThreadIdShaped) {
      console.log(LOG, 'no thread ID in URL — list view, not conversation:', location.hash)
      showToast('Open an email first, then Cmd+Shift+L')
      return null
    }
    const threadId = lastSeg

    // -------- Account index (u/0 vs u/1) --------
    // Preserving this in the deep link means clicking the saved item later
    // opens Gmail in the SAME Google account the user was viewing — critical
    // for multi-account users.
    const acctMatch = location.pathname.match(/\/mail\/u\/(\d+)\//)
    const accountIndex = acctMatch ? acctMatch[1] : '0'
    const gmailUrl = `https://mail.google.com/mail/u/${accountIndex}/#inbox/${threadId}`

    // -------- Subject (h2.hP) --------
    // Stable across every Gmail redesign since ~2019. If it goes missing we
    // still save with a fallback title — the user shouldn't lose the save
    // just because Google shipped a UI refactor overnight.
    const subjectEl = document.querySelector('h2.hP')
    const subject = subjectEl?.textContent?.trim() || ''
    if (!subjectEl) {
      console.warn(LOG, 'subject element (h2.hP) not found — Gmail redesign?')
    }

    // -------- Sender (.gD) --------
    // On the top open message, `.gD` carries `name` (display name) and `email`
    // attributes. Query returns the first match — that's the topmost message
    // of an open thread. If reading pane / list-only view, .gD may be absent.
    const senderEl = document.querySelector('.gD')
    const senderName = (senderEl?.getAttribute('name') || senderEl?.textContent || '').trim()
    const senderEmail = (senderEl?.getAttribute('email') || '').trim()
    if (!senderEl) {
      console.warn(LOG, 'sender element (.gD) not found — reading pane / redesign?')
    }

    // -------- Message ID --------
    // Every message DOM row has data-legacy-message-id. First match = top of
    // thread. Fine as a best-effort v1 identifier — we don't strictly need it
    // for the save to work, but it's cheap to capture for later features.
    const msgEl = document.querySelector('[data-legacy-message-id]')
    const messageId = msgEl?.getAttribute('data-legacy-message-id') || ''

    // Hex form of the thread ID, as exposed on inbox row DOM. Different string
    // from the URL-hash encoding but same underlying thread — needed so the
    // inbox indicator can match rows to what we've saved.
    const legacyThreadId = document.querySelector('[data-legacy-thread-id]')?.getAttribute('data-legacy-thread-id') || ''

    console.log(LOG, 'extracted:', { subject, senderName, senderEmail, threadId, legacyThreadId, messageId, accountIndex })
    return { subject, senderName, senderEmail, threadId, legacyThreadId, messageId, accountIndex, gmailUrl }
  }

  // -------- Toast --------
  // Single reusable fixed-position element. Reset the fade timer on each
  // trigger so rapid Cmd+Shift+L presses don't leave a stale toast on screen.

  let toastEl = null
  let toastTimer = null

  function showToast(text) {
    if (!toastEl) {
      toastEl = document.createElement('div')
      Object.assign(toastEl.style, {
        position: 'fixed',
        bottom: '24px',
        right: '24px',
        zIndex: '2147483647',
        background: '#1a1a1a',
        color: '#fff',
        padding: '10px 14px',
        borderRadius: '10px',
        fontSize: '13px',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        boxShadow: '0 6px 24px rgba(0,0,0,0.25)',
        opacity: '0',
        transform: 'translateY(8px)',
        transition: 'opacity 160ms ease, transform 160ms ease',
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        maxWidth: '360px',
      })
      // Envelope + red "M" stroke — matches the icon the Mac app renders on
      // Gmail-sourced items, so the toast previews what will appear in Later.
      toastEl.innerHTML =
        '<svg width="18" height="14" viewBox="0 0 20 16" fill="none" aria-hidden="true">' +
          '<rect x="0.75" y="0.75" width="18.5" height="14.5" rx="2.5" fill="#fff"/>' +
          '<path d="M2 3.5L10 9L18 3.5" stroke="#ea4335" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
        '</svg>' +
        '<span class="later-toast-text"></span>'
      document.body.appendChild(toastEl)
    }
    toastEl.querySelector('.later-toast-text').textContent = text
    // Force a reflow so the transition fires from opacity:0 on first show.
    requestAnimationFrame(() => {
      toastEl.style.opacity = '1'
      toastEl.style.transform = 'translateY(0)'
    })
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      toastEl.style.opacity = '0'
      toastEl.style.transform = 'translateY(8px)'
    }, 2200)
  }

  function truncate(s, n) {
    return s.length <= n ? s : s.slice(0, n - 1) + '…'
  }
})()
