// Later — LinkedIn content script.
//
// Two ways to save (right-click will be removed after button is confirmed):
//   1. Right-click a post → "Save to Later" (context menu from the SW)
//   2. Click the Later bookmark button injected into each post's action row
//
// LinkedIn no longer exposes post URNs anywhere in the DOM, so we identify
// saved posts by `${authorProfileHref}::${textSnippet.slice(0,100)}`. Not
// URN-strong; collisions only if the same author reposts identical text.

;(function () {
  const LOG = '[Later ext / linkedin]'
  const SAVED_KEY = 'later:savedLinkedInPosts'
  const BTN_CLASS = 'later-save-btn'
  const savedPosts = new Set()

  console.log(LOG, 'content script loaded on', location.href, '[build-marker: button-injector-v1]')

  chrome.storage.local.get(SAVED_KEY, r => {
    for (const k of r[SAVED_KEY] || []) savedPosts.add(k)
    console.log(LOG, 'storage loaded,', savedPosts.size, 'saved posts')
    scheduleScan()
  })

  // ---------- right-click flow ----------

  let lastRightClickedPost = null
  document.addEventListener('contextmenu', e => { lastRightClickedPost = findPostAt(e) }, true)

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'later:save-context-post') return
    try {
      const ok = doSave(lastRightClickedPost)
      sendResponse({ ok })
    } catch (e) {
      console.warn(LOG, 'save failed:', e)
      showToast('Couldn\'t save — right-click a post first')
      sendResponse({ ok: false, error: String(e) })
    }
    return true
  })

  function findPostAt(e) {
    const target = e.target instanceof Element ? e.target : null
    if (!target) return null
    const article = target.closest('[role="article"]')
    if (article) return article
    let el = target
    for (let d = 0; el && d < 20; d++) {
      if (el.querySelector?.('a[href*="/in/"]') && (el.textContent?.length ?? 0) > 50) return el
      el = el.parentElement
    }
    return null
  }

  // ---------- shared save routine ----------

  function doSave(post) {
    if (!post) { showToast('Right-click on a post first'); return false }
    const { author, text } = extractPost(post)
    if (!author && !text) { showToast('Couldn\'t read this post — LinkedIn redesign?'); return false }

    const title = truncate(text || author || 'LinkedIn post', 40)
    const params = new URLSearchParams({ kind: 'linkedin', title, author })
    const iframe = document.createElement('iframe')
    iframe.style.display = 'none'
    iframe.src = `later://save?${params.toString()}`
    document.body.appendChild(iframe)
    setTimeout(() => iframe.remove(), 200)

    const id = identityOf(post)
    if (id && !savedPosts.has(id)) {
      savedPosts.add(id)
      chrome.storage.local.set({ [SAVED_KEY]: [...savedPosts] })
    }
    scheduleScan()
    showToast(`Saved to Later — ${truncate(author || 'LinkedIn post', 40)}`)
    return true
  }

  function extractPost(post) {
    // Multiple /in/ anchors per post — one wraps the profile photo (no text),
    // the other holds the visible name. Pick the first with a useful signal.
    const links = [...post.querySelectorAll('a[href*="/in/"]')]
    const profileLink = links.find(a => (a.getAttribute('aria-label') || a.textContent || '').trim()) || null
    const aria = profileLink?.getAttribute('aria-label') || ''
    const ariaMatch = aria.match(/^(?:View\s+)?(.+?)(?:['’]s\s+profile)?$/i)
    let author = ariaMatch?.[1]?.trim() || ''
    if (!author) {
      const raw = (profileLink?.textContent || '').replace(/\s+/g, ' ').trim()
      author = raw.split(/\s+•\s+/)[0].split(/\n/)[0].trim()
    }
    const textEl = post.querySelector('[data-testid="expandable-text-box"]')
    const text = (textEl?.textContent || '').trim().replace(/\s+/g, ' ')
    console.log(LOG, 'extractPost:', {
      hasProfileLink: !!profileLink,
      aria: aria.slice(0, 60),
      rawText: profileLink?.textContent?.slice(0, 60),
      author,
      textLen: text.length,
    })
    return { author, text }
  }

  function identityOf(post) {
    // componentkey is LinkedIn's SDUI reconciliation key — stable per post
    // across renders in a session. Preferred over content hashing.
    const ck = post.getAttribute('componentkey')
    if (ck) return ck
    const { author, text } = extractPost(post)
    if (!author && !text) return null
    const href = post.querySelector('a[href*="/in/"]')?.getAttribute('href')?.split('?')[0] || ''
    return `${href}::${text.slice(0, 100)}`
  }

  // ---------- injected button ----------

  function findActionRow(post) {
    // Send + Comment uniquely identify the action row (summary row has count
    // buttons but no Send). aria-labels are confirmed present in SDUI.
    const send = post.querySelector('[aria-label="Send"]')
    if (!send) return null
    let el = send
    for (let d = 0; el && d < 12; d++) {
      if (el.querySelector('[aria-label="Comment"]')) return el
      el = el.parentElement
    }
    return null
  }

  function bookmarkSVG(saved) {
    const fill = saved ? '#2d8a4e' : '#666'
    const op = saved ? '1' : '0.55'
    return `<svg width="20" height="20" viewBox="0 0 24 24" fill="${fill}" opacity="${op}" aria-hidden="true">`
      + `<path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"/></svg>`
  }

  function paintButton(btn, saved) {
    btn.dataset.saved = saved ? '1' : '0'
    btn.title = saved ? 'Saved to Later' : 'Save to Later'
    btn.setAttribute('aria-label', btn.title)
    btn.innerHTML = bookmarkSVG(saved)
  }

  function makeButton(post, saved, peer) {
    // Shallow-clone a peer action button so we inherit LinkedIn's flex/padding
    // classes (obfuscated + unnamed) and sit inline with them cleanly.
    const btn = peer.cloneNode(false)
    btn.removeAttribute('id')
    btn.className = (peer.className ? peer.className + ' ' : '') + BTN_CLASS
    btn.style.cssText = ''
    paintButton(btn, saved)
    btn.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation()
      doSave(post)
      paintButton(btn, true)
    })
    return btn
  }

  let scanRan = false
  function scanFeed() {
    const mainFeed = document.querySelector('[data-testid="mainFeed"]')
    const posts = (mainFeed || document).querySelectorAll('[role="listitem"]')
    if (!scanRan) {
      scanRan = true
      console.log(LOG, 'first-scan diagnostic:', {
        mainFeedContainer: !!mainFeed,
        listItems: posts.length,
        listItemsGlobal: document.querySelectorAll('[role="listitem"]').length,
        componentKeys: document.querySelectorAll('[componentkey]').length,
        buttons: document.querySelectorAll('button').length,
        roleButtons: document.querySelectorAll('[role="button"]').length,
        anyAriaLike: document.querySelectorAll('[aria-label*="ike" i]').length,
        anyAriaComment: document.querySelectorAll('[aria-label*="omment" i]').length,
        profileLinks: document.querySelectorAll('a[href*="/in/"]').length,
      })
    }
    let injected = 0, skipped = 0
    for (const post of posts) {
      const row = findActionRow(post)
      if (!row) { skipped++; continue }
      const id = identityOf(post)
      const saved = id ? savedPosts.has(id) : false
      const existing = row.querySelector('.' + BTN_CLASS)
      if (existing) {
        if ((existing.dataset.saved === '1') !== saved) paintButton(existing, saved)
        continue
      }
      const peer = row.querySelector('[aria-label="Send"]')
        || row.querySelector('button:not(.' + BTN_CLASS + '), [role="button"]:not(.' + BTN_CLASS + ')')
      if (!peer) { skipped++; continue }
      row.appendChild(makeButton(post, saved, peer))
      injected++
    }
    console.log(LOG, `scan: ${posts.length} posts, ${injected} newly injected, ${skipped} skipped`)
  }

  let scanTimer = null
  let scheduleScanCallCount = 0
  function scheduleScan() {
    scheduleScanCallCount++
    if (scheduleScanCallCount <= 3) console.log(LOG, 'scheduleScan #' + scheduleScanCallCount, 'timerActive:', !!scanTimer)
    if (scanTimer) return
    scanTimer = setTimeout(() => {
      scanTimer = null
      console.log(LOG, 'timer fired → scanFeed()')
      try { scanFeed() } catch (e) { console.error(LOG, 'scanFeed threw:', e) }
    }, 150)
  }
  new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true })

  // ---------- toast ----------

  let toastEl = null
  let toastTimer = null
  function showToast(text) {
    if (!toastEl) {
      toastEl = document.createElement('div')
      Object.assign(toastEl.style, {
        position: 'fixed', bottom: '24px', right: '24px', zIndex: '2147483647',
        background: '#1a1a1a', color: '#fff', padding: '10px 14px', borderRadius: '10px',
        fontSize: '13px', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        boxShadow: '0 6px 24px rgba(0,0,0,0.25)', opacity: '0', transform: 'translateY(8px)',
        transition: 'opacity 160ms ease, transform 160ms ease',
        pointerEvents: 'none', maxWidth: '360px',
      })
      document.body.appendChild(toastEl)
    }
    toastEl.textContent = text
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

  function truncate(s, n) { return s.length <= n ? s : s.slice(0, n - 1) + '…' }
})()
