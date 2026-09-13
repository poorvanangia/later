# Later — Gmail Save Extension

A Chrome extension that saves the currently-open Gmail email to the Later Mac app
with **Cmd+Shift+L**. No new tab, no context switch — a toast confirms the save
and the item shows up in Later's vault next time you look.

## How it works

```
Cmd+Shift+L  →  Chrome extension extracts subject/sender/thread from Gmail's DOM
             →  Opens `later://save?title=…&sender=…&threadId=…` (custom scheme)
             →  Later Mac app receives the deep link, saves as a normal item
                with a Gmail badge, runs it through the same AI categorizer
```

No backend. No auth. No polling. The Later Mac app must be installed (it's what
registers the `later://` URL scheme).

## Install (developer mode)

1. Build and run Later Mac app v0.1.14 or later, so `later://` is registered.
   (Verify: paste `later://save?title=test&threadId=abc123&gmailUrl=https://mail.google.com/`
   into a terminal — `open 'later://…'` — and confirm Later opens.)
2. In Chrome, go to `chrome://extensions/`
3. Toggle **Developer mode** (top right)
4. Click **Load unpacked** and select this `extension/` folder
5. Confirm the extension appears with a Later icon
6. Set the shortcut:
   - Go to `chrome://extensions/shortcuts`
   - Find "Later — Save from Gmail"
   - The suggested key is **Cmd+Shift+L**, but Chrome may not auto-assign it —
     click into the shortcut field and press Cmd+Shift+L manually if needed
7. Open Gmail (`mail.google.com`) and **reload the tab** (the content script
   only injects into pages loaded *after* install)

## Use

1. Open any email in Gmail (conversation view — not the list)
2. Press **Cmd+Shift+L**
3. A toast appears bottom-right: "Saved to Later — {subject}"
4. Check the Later vault — the item is there with a Gmail envelope icon and
   the format `[Sender Name] — [Subject]`

The first time you save, Chrome shows an **"Open in Later?"** prompt. Check
"Always allow" so subsequent saves are silent.

## Scope (v1)

- **Conversation view only.** If you press the shortcut on the inbox list,
  the toast says "Open an email first". List-view multi-select save comes
  alongside LinkedIn's multi-item feed problem.
- **Chrome only.** Safari support is a separate build (different extension API).
- **Gmail only.** Slack Web / LinkedIn come after Gmail is proven out.

## Known risks & failure modes

We intentionally lean on Gmail's stable-ish CSS anchors (`h2.hP`, `.gD`,
`data-legacy-message-id`). These have held since roughly 2019, but Google
occasionally rebuilds Gmail's UI. Failure modes:

- **`h2.hP` missing** → subject is empty → item saved as "Untitled email".
  A console warning fires. Reproduce the trigger and check DevTools if you
  see this — the class name has probably changed.
- **`.gD` missing** (usually reading-pane / list-only view) → sender info is
  empty → item shows just the subject. Non-fatal; the item still saves.
- **Multi-account** (`u/0` vs `u/1` etc.) → the `accountIndex` from
  `/mail/u/N/` is baked into the deep link, so clicking the saved item later
  opens Gmail in the same account. If you switch accounts *between saving and
  clicking*, Gmail may prompt to switch back.

If the extension stops finding elements after a Gmail redesign, open DevTools
on an open email, run:

```js
document.querySelector('h2.hP')?.textContent
document.querySelector('.gD')?.getAttribute('email')
```

If either returns null, the anchor has drifted — update the selectors in
`content-gmail.js` and reload the extension.

## Files

- `manifest.json` — MV3 manifest, declares the Gmail host permission and the
  `save-current` command bound to Cmd+Shift+L.
- `background.js` — service worker. Receives the command, forwards a message
  to the active Gmail tab's content script.
- `content-gmail.js` — content script. Extracts DOM, builds the `later://save`
  URL, triggers the deep link via a hidden iframe, shows the toast.

## Manual test checklist

- [ ] Open a Gmail email, press Cmd+Shift+L → toast appears
- [ ] Item shows up in Later with Gmail badge + "Sender — Subject" title
- [ ] Clicking the item opens the correct Gmail thread (same account)
- [ ] AI classifier assigns a category (or suggests one) same as any other item
- [ ] Press Cmd+Shift+L on the Gmail inbox (list view) → toast says "Open an email first"
- [ ] Press Cmd+Shift+L on a non-Gmail tab → nothing happens (silent no-op)
- [ ] Multi-account: view mail in `u/1`, save, click the saved item in Later →
      opens in `u/1`, not `u/0`
