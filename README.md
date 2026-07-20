<img width="1415" height="651" alt="Screenshot 2026-07-20 at 16 26 16" src="https://github.com/user-attachments/assets/b9369b3f-22b3-46a7-9bd2-f0539372a7dd" />

# Later

A macOS menu-bar app for saving links you want to come back to — articles, videos, tweets, notes, whatever. An LLM sorts each one into a category, so your library grows in a shape that actually makes sense to you.

Everything stays on your Mac. No account, no sync.

`platform: macOS 10.15+` · `license: MIT` · `built with: Tauri 2 · Rust · React 19 · Tailwind · Cloudflare Workers`

---

## Download

Grab the latest DMG from [**trylater.in**](https://trylater.in). Requires macOS 10.15 or later.

## What it does

- **Tray icon.** Click the menu-bar icon to open a small popup with your recent saves.
- **Quick save from anywhere.** Hit `⌘⇧L` and a Spotlight-style bar drops down — paste a link, press Enter, done.
- **Auto-categorized.** The link's title and description are sent to a Claude model, which picks a category from the ones you've already created. It doesn't invent new categories or force everything into a fixed list.
- **Full library window.** Browse everything by category or date, search across titles and notes.
- **Local storage.** Your library lives on your Mac.

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

Cut a signed release (bundles the app, builds a DMG, publishes to GitHub Releases for the auto-updater):

```bash
npm run release
```

## Project layout

```
src/               React + TypeScript frontend
  App.tsx          the library window
  PopupApp.tsx     the menu-bar popup
  components/      HomePage, LibraryPage, SpotlightBar, TrayPopup, SaveModal, …
src-tauri/         Rust core (Tauri backend)
  src/lib.rs       tray, global shortcut, windows, AI proxy commands
worker/            Cloudflare Worker — relays classify/title calls to Anthropic
                   so the API key stays out of the shipped binary
landing/           marketing site (trylater.in)
scripts/release.sh signed build + DMG + GitHub release
```

## How the AI classification works

The Rust core exposes two Tauri commands — `classify_item` and `generate_title` — that POST to a small Cloudflare Worker. The Worker calls Anthropic's API with the site's title, description, and your existing category list, and returns the chosen category (or a short generated title). Classifying against *your* categories, not a fixed taxonomy, is the whole point.

## License

[MIT](./LICENSE)
