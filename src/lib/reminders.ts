// Reminders — parses NL via the worker, schedules a Rust-side tokio task
// that fires a macOS notification when the time hits, and re-schedules
// pending reminders on app boot so restarts don't lose them.

export interface ParseReminderResponse {
  parsed: string | null   // ISO datetime or null when NL couldn't be parsed
  reason: string
}

// Build an ISO string in the user's local timezone (with offset), NOT UTC.
// Prevents the classic "9pm on Sep 8 PT becomes Sep 9 UTC and the LLM thinks
// today is tomorrow" bug.
function localIsoWithOffset(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0')
  const y = d.getFullYear()
  const M = pad(d.getMonth() + 1)
  const day = pad(d.getDate())
  const h = pad(d.getHours())
  const m = pad(d.getMinutes())
  const s = pad(d.getSeconds())
  const off = -d.getTimezoneOffset()  // minutes east of UTC
  const sign = off >= 0 ? '+' : '-'
  const oH = pad(Math.floor(Math.abs(off) / 60))
  const oM = pad(Math.abs(off) % 60)
  return `${y}-${M}-${day}T${h}:${m}:${s}${sign}${oH}:${oM}`
}

export async function parseReminderNL(text: string): Promise<ParseReminderResponse> {
  try {
    const now = new Date()
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    const res = await fetch('https://later-api.poorvanangia03.workers.dev/parse_reminder', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Later-Auth': 'c98175fec0af0ae02de9795fc7361132957c4163ceb3b403480c28dc5dc1e5b3',
      },
      body: JSON.stringify({
        text,
        now_iso: localIsoWithOffset(now),
        timezone: tz,
      }),
    })
    if (!res.ok) return { parsed: null, reason: `http_${res.status}` }
    return (await res.json()) as ParseReminderResponse
  } catch (e) {
    console.error('[later/reminders] parse failed', e)
    return { parsed: null, reason: 'network_error' }
  }
}

export async function scheduleReminderNative(linkId: string, title: string, remindAtIso: string): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('schedule_reminder', { linkId, title, remindAtIso })
  } catch (e) {
    console.error('[later/reminders] schedule failed', e)
  }
}

export async function cancelReminderNative(linkId: string): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('cancel_reminder', { linkId })
  } catch (e) {
    console.error('[later/reminders] cancel failed', e)
  }
}

// Human-friendly relative label, e.g. "in 2h", "in 3d", "12 Sep 9am".
export function formatReminderLabel(remindAtIso: string): string {
  const target = new Date(remindAtIso)
  if (isNaN(target.getTime())) return ''
  const now = new Date()
  const diffMs = target.getTime() - now.getTime()
  if (diffMs < 0) return 'past'
  const diffMin = Math.round(diffMs / 60000)
  if (diffMin < 60) return `in ${diffMin}m`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `in ${diffHr}h`
  const diffDay = Math.round(diffHr / 24)
  if (diffDay < 7) return `in ${diffDay}d`
  // > week: absolute date
  return target.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// Human-friendly "reminded X ago" for the acknowledged bell tooltip.
// Complements formatReminderLabel — same idea, past-facing.
export function formatAcknowledgedAgo(acknowledgedAtIso: string): string {
  const ack = new Date(acknowledgedAtIso)
  if (isNaN(ack.getTime())) return ''
  const diffMs = Date.now() - ack.getTime()
  if (diffMs < 0) return 'just now'
  const diffMin = Math.round(diffMs / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `reminded ${diffMin}m ago`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `reminded ${diffHr}h ago`
  const diffDay = Math.round(diffHr / 24)
  if (diffDay < 30) return `reminded ${diffDay}d ago`
  return `reminded on ${ack.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

// Reminder state machine. Derived purely from the three fields so it can
// never drift out of sync with them — the item list should ALWAYS render
// whatever this returns, no separate flag to maintain.
//
// State semantics:
//   'none'         — no reminder set; hide the bell (or show hover-only add affordance)
//   'upcoming'     — remind_at in the future and not yet acknowledged
//   'overdue'      — remind_at in the past and not yet acknowledged (safety net:
//                    stays visible even if the popup was missed)
//   'acknowledged' — user pressed Okay or View. Quiet trace with hover tooltip.
//
// Note: `fired_at` is intentionally NOT part of the state machine. It only
// gates whether the popup should re-fire — it doesn't change how the bell
// looks. An unacked past reminder is 'overdue' regardless of whether the
// popup happened to fire yet, so the item list acts as a true safety net.
export type ReminderState = 'none' | 'upcoming' | 'overdue' | 'acknowledged'

export interface ReminderFields {
  remind_at?: string | null
  acknowledged_at?: string | null
}

export function getReminderState(link: ReminderFields, now: number = Date.now()): ReminderState {
  if (!link.remind_at) return 'none'
  if (link.acknowledged_at) return 'acknowledged'
  const target = new Date(link.remind_at).getTime()
  if (isNaN(target)) return 'none'
  return target > now ? 'upcoming' : 'overdue'
}

// Directly mutate the persisted later:links entry for `linkId` — used by the
// reminder popup window, which needs to update state without going through
// App.tsx (the library window may not be mounted). Tauri v2 webviews on the
// same protocol share localStorage, so this is a single source of truth.
//
// Emits the same later://state-changed event App.tsx broadcasts after
// mutations, so any open windows re-render.
export async function patchLinkFields(linkId: string, patch: Record<string, unknown>): Promise<void> {
  try {
    const raw = localStorage.getItem('later:links') ?? '[]'
    const links: Array<Record<string, unknown>> = JSON.parse(raw)
    let changed = false
    for (const l of links) {
      if (l.id === linkId) {
        Object.assign(l, patch)
        changed = true
        break
      }
    }
    if (!changed) return
    localStorage.setItem('later:links', JSON.stringify(links))
    try {
      const { emit } = await import('@tauri-apps/api/event')
      await emit('later://state-changed')
    } catch { /* not inside Tauri (e.g. plain vite preview) — silent */ }
  } catch (e) {
    console.error('[later/reminders] patchLinkFields failed', e)
  }
}
