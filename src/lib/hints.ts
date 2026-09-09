// Tracks how many times the user has invoked the Cmd+K global shortcut.
// The vault window shows a subtle hint pill until this count reaches
// CMD_K_HINT_THRESHOLD, at which point the user is assumed to have muscle
// memory and we stop nagging. Counter is persisted in localStorage so it
// survives app restarts.

const K_CMDK_USAGE = 'later:cmdK_usage_count'

// Chosen at 7 (middle of the 5–10 range the spec called out). Rationale:
// 5 felt too early — many users would still be occasionally forgetting the
// binding. 10 felt too long — most people have keyboard shortcuts committed
// by the 5th–7th use for something they touch daily. 7 is a sweet spot; easy
// to change by editing this constant.
export const CMD_K_HINT_THRESHOLD = 7

export function loadCmdKUsageCount(): number {
  try {
    const raw = localStorage.getItem(K_CMDK_USAGE)
    const n = raw ? parseInt(raw, 10) : 0
    return Number.isFinite(n) && n >= 0 ? n : 0
  } catch { return 0 }
}

export function incrementCmdKUsageCount(): number {
  const next = loadCmdKUsageCount() + 1
  try { localStorage.setItem(K_CMDK_USAGE, String(next)) } catch { }
  return next
}

export function isCmdKHintVisible(): boolean {
  return loadCmdKUsageCount() < CMD_K_HINT_THRESHOLD
}
