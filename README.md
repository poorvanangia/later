<img width="1415" height="651" alt="Screenshot 2026-07-20 at 16 26 16" src="https://github.com/user-attachments/assets/b9369b3f-22b3-46a7-9bd2-f0539372a7dd" />

# Later

A macOS menu-bar app for saving links you want to come back to — articles, videos, tweets, notes, whatever. An LLM sorts each one into a category, so your library grows in a shape that actually makes sense to you.

Your library stays on your Mac. No account or cloud library sync; AI features send relevant content to a Cloudflare Worker and Anthropic.

`platform: macOS 10.15+` · `license: MIT` · `built with: Tauri 2 · Rust · React 19 · Tailwind · Cloudflare Workers`

---

## Download

Grab the latest DMG from [**trylater.in**](https://trylater.in). Requires macOS 10.15 or later.

## What it does

- **Tray icon.** Click the menu-bar icon to open a small popup with your recent saves.
- **Quick save from anywhere.** Hit `⌘⇧L` and a Spotlight-style bar drops down — paste a link, press Enter, done.
- **AI categorization.** Claude assigns confident matches to existing categories and suggests uncertain matches or new categories for your approval.
- **Full library window.** Browse everything by category or date, search across titles and notes.
- **Reminders.** Set a reminder on a saved item and receive a desktop popup.
- **Local storage.** Your library lives in localStorage on your Mac.

## Why I built it

I kept sending links to myself in Slack and writing things in Apple Notes then never finding them again. Bookmark folders got out of hand. Read-it-later apps made me pick from a fixed set of tags that never quite fit. Later is the version I wanted: fast, local, and smart enough to file things the way I already think about them. It's like apple notes, but smarter.

## Build from source

Prerequisites: macOS 10.15+, a Rust toolchain, and Node.js.

```bash
npm install
npm run tauri:dev     # build and launch the app
```

Build a distributable macOS app:

```bash
npm run tauri:build
```

## App structure

The app has three main layers:

| Layer | Location | Responsibility |
|---|---|---|
| Frontend | `src/` | React + TypeScript UI, app state, and local persistence. |
| Desktop core | `src-tauri/` | Rust + Tauri windows, menu-bar icon, shortcuts, reminder scheduling, update support, and commands called by the UI. |
| Cloud API | `worker/` | Cloudflare Worker for AI categorization, title generation, reminder parsing, and other AI requests. Keeps the Anthropic API key out of the app. |

**Save flow:** React saves an item locally → Rust calls the Worker for AI processing → the Worker calls Anthropic → React applies the result. Some features, such as reminder parsing, call the Worker directly.

**Storage:** Saved items and categories live in localStorage. Tauri events keep the app's windows synchronized when data changes.

**Gmail:** Authentication and inbox syncing have been removed. The Open Loops feature has also been removed. Items previously accepted into the library remain available.

## How AI classification works

The frontend sends item context and the user's categories through Rust commands to the Worker. Claude returns an existing category, a suggestion requiring approval, or no match. New categories require user confirmation. Title generation follows the same Rust → Worker → Anthropic path.

## Validation

```bash
npm run build        # Type-check and build the frontend
npm run tauri:dev    # Launch the desktop app
```

The `npm run release` entry currently references a missing `scripts/release.sh`; use `npm run tauri:build` for desktop builds.

## License

[MIT](./LICENSE)
