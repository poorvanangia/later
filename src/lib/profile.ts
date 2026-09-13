// User profile — a free-text description of who the user is and what they do.
// Captured during onboarding, editable in Settings → About you.
// Injected into every classifier call so decisions are informed by the user's
// context rather than generic guesses.
//
// Stored as a small object rather than a bare string so settings
// can extend the shape (e.g. add a `role_tags: string[]` or
// `preferred_categories: string[]` field) without a migration.

const K_PROFILE = 'later:user_profile'

export interface UserProfile {
  text: string
  updatedAt: string
}

const EMPTY_PROFILE: UserProfile = { text: '', updatedAt: '' }

export function loadUserProfile(): UserProfile {
  try {
    const raw = localStorage.getItem(K_PROFILE)
    if (!raw) return EMPTY_PROFILE
    const parsed = JSON.parse(raw) as Partial<UserProfile>
    return {
      text: typeof parsed.text === 'string' ? parsed.text : '',
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    }
  } catch { return EMPTY_PROFILE }
}

export function saveUserProfile(text: string): UserProfile {
  const next: UserProfile = {
    text: text.trim(),
    updatedAt: new Date().toISOString(),
  }
  try { localStorage.setItem(K_PROFILE, JSON.stringify(next)) } catch { /* Settings verifies persistence before showing success. */ }
  return next
}

// Convenience for classifier callers — returns just the text (empty string if
// no profile has been saved). Kept separate from loadUserProfile so callers
// that only need the text don't have to deconstruct the object.
export function loadUserProfileText(): string {
  return loadUserProfile().text
}

// Kept separate from AI profile text: email is not classifier context.
const K_EMAIL = 'later:user_email'

export function loadUserEmail(): string {
  try { return localStorage.getItem(K_EMAIL) ?? '' } catch { return '' }
}

export function saveUserEmail(email: string): void {
  localStorage.setItem(K_EMAIL, email.trim())
}
