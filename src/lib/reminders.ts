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
