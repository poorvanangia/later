// Later — Chrome extension service worker.
//
// Listens for the Cmd+Shift+L shortcut and forwards it to the Gmail content
// script, which handles DOM extraction + deep-link handoff. This SW stays
// small on purpose: content scripts can't listen for chrome.commands
// directly, so the SW is just a router.
//
// If the shortcut is pressed on a non-Gmail tab we silently ignore it. Toast
// nagging on unrelated tabs would be more annoying than useful — LinkedIn,
// Slack Web, and friends will get their own content scripts later.

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'save-current') return

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id || !tab.url) return

  if (!tab.url.startsWith('https://mail.google.com/')) {
    console.log('[Later] save-current fired on non-Gmail tab, ignoring:', tab.url)
    return
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'later:save-current' })
  } catch (e) {
    console.warn('[Later] content script unreachable — did you reload the Gmail tab after install?', e)
  }
})

// LinkedIn right-click "Save to Later" — context menu is registered once per
// SW install/update and scoped to linkedin.com. The content script owns
// figuring out which post the user actually right-clicked (via its own
// capture-phase contextmenu listener); the SW just forwards the trigger.
const LINKEDIN_MENU_ID = 'later-save-linkedin-post'

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: LINKEDIN_MENU_ID,
    title: 'Save to Later',
    contexts: ['page', 'selection', 'link', 'image'],
    documentUrlPatterns: ['https://www.linkedin.com/*'],
  })
})

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== LINKEDIN_MENU_ID || !tab?.id) return
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'later:save-context-post' })
  } catch (e) {
    console.warn('[Later] LinkedIn content script unreachable — did you reload the tab after install?', e)
  }
})
