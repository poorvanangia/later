import { loadUserProfileText } from './profile'
import { saveCategoryDescription } from './classifier'

export type StarterCategory = { name: string; description: string }
type Classification = { decision: 'assign' | 'suggest_existing' | 'suggest_new' | 'none'; category: string; description?: string; reason?: string }
type StoredLink = { title?: string | null; note?: string | null; url?: string; category?: string | null; ai_processed?: boolean; pending_suggestion?: unknown; [key: string]: unknown }

const DEV_CATEGORY_CACHE = 'later:dev:starterCategoryCache'
const DEV_CLASSIFY_CACHE = 'later:dev:recategorizationCache'

function cacheKey(value: unknown): string {
  const text = JSON.stringify(value)
  let hash = 0
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0
  return String(hash)
}

function isStarterCategory(value: unknown): value is StarterCategory {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.name === 'string' && typeof item.description === 'string'
}

function isClassification(value: unknown): value is Classification {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return ['assign', 'suggest_existing', 'suggest_new', 'none'].includes(String(item.decision)) && typeof item.category === 'string'
}

function emitProgress(detail: { label: string; done: number; total: number | null }) {
  window.dispatchEvent(new CustomEvent('later:categorization-progress', { detail }))
}

export async function generateStarterCategories(profile: string): Promise<StarterCategory[]> {
  emitProgress({ label: 'Creating category suggestions…', done: 0, total: null })
  const key = cacheKey({ version: 1, profile: profile.trim() })
  if (import.meta.env.DEV) {
    try {
      const cache = JSON.parse(localStorage.getItem(DEV_CATEGORY_CACHE) ?? '{}')
      if (Array.isArray(cache[key])) {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('log_dev_cache_hit', { kind: 'starter categories', detail: '' })
        await new Promise(resolve => setTimeout(resolve, 350))
        emitProgress({ label: '', done: 1, total: 1 })
        return cache[key].filter(isStarterCategory)
      }
    } catch { }
  }
  const { invoke } = await import('@tauri-apps/api/core')
  let result: unknown
  try {
    result = await invoke<unknown>('generate_starter_categories', { profile })
  } catch (error) {
    emitProgress({ label: '', done: 1, total: 1 })
    throw error
  }
  if (!Array.isArray(result)) { emitProgress({ label: '', done: 1, total: 1 }); return [] }
  const categories = result.filter(isStarterCategory).map(item => ({ name: item.name.trim(), description: item.description.trim() })).filter(item => item.name)
  if (import.meta.env.DEV && categories.length) {
    try {
      const cache = JSON.parse(localStorage.getItem(DEV_CATEGORY_CACHE) ?? '{}')
      cache[key] = categories
      localStorage.setItem(DEV_CATEGORY_CACHE, JSON.stringify(cache))
    } catch { }
  }
  emitProgress({ label: '', done: 1, total: 1 })
  return categories
}

export const STARTER_CATEGORY_STATE_KEY = 'later:starterCategoriesState'

export type StarterCategoryState = 'not_started' | 'accepted' | 'skipped'

export function loadStarterCategoryState(): StarterCategoryState {
  try {
    const value = localStorage.getItem(STARTER_CATEGORY_STATE_KEY)
    return value === 'accepted' || value === 'skipped' ? value : 'not_started'
  } catch { return 'not_started' }
}

export function saveStarterCategoryState(state: Exclude<StarterCategoryState, 'not_started'>) {
  try { localStorage.setItem(STARTER_CATEGORY_STATE_KEY, state) } catch { }
}

export function applyStarterCategories(items: StarterCategory[]): void {
  let current: string[] = []
  try { current = JSON.parse(localStorage.getItem('later:categories') ?? '[]') } catch { }
  localStorage.setItem('later:categories', JSON.stringify([...new Set([...current, ...items.map(item => item.name)])]))
  items.forEach(item => saveCategoryDescription(item.name, item.description))
  saveStarterCategoryState('accepted')
  window.dispatchEvent(new Event('later:categories-updated'))
}

export async function categorizeExistingItems(options: { includeCategorized?: boolean } = {}): Promise<void> {
  let links: StoredLink[] = [], categories: string[] = [], descriptions: Record<string, string> = {}
  try {
    links = JSON.parse(localStorage.getItem('later:links') ?? '[]')
    categories = JSON.parse(localStorage.getItem('later:categories') ?? '[]')
    descriptions = JSON.parse(localStorage.getItem('later:category_descriptions') ?? '{}')
  } catch { return }
  const targets = links.filter(link => options.includeCategorized || !link.category)
  if (!targets.length || !categories.length) return
  targets.forEach(link => { link.ai_processed = false; link.pending_suggestion = null })
  localStorage.setItem('later:links', JSON.stringify(links))
  window.dispatchEvent(new Event('later:categories-updated'))
  const { invoke } = await import('@tauri-apps/api/core')
  let devCache: Record<string, unknown> = {}
  if (import.meta.env.DEV) try { devCache = JSON.parse(localStorage.getItem(DEV_CLASSIFY_CACHE) ?? '{}') } catch { }
  emitProgress({ label: 'Organising your saves…', done: 0, total: targets.length })
  for (const [index, link] of targets.entries()) {
    const text = link.note || link.title || link.url || ''
    try {
      const key = cacheKey({ version: 1, text, categories, descriptions, profile: loadUserProfileText() })
      const cached = devCache[key]
      const result = isClassification(cached) ? cached : await invoke<Classification>('classify_item', { text, existingCategories: categories, categoryDescriptions: descriptions, pendingNewNames: [], userProfile: loadUserProfileText() })
      if (import.meta.env.DEV && isClassification(cached)) {
        await invoke('log_dev_cache_hit', { kind: 'classification', detail: ` (text len: ${text.length})` })
        await new Promise(resolve => setTimeout(resolve, 120))
      }
      if (!isClassification(result)) throw new Error('Invalid classification response')
      if (import.meta.env.DEV && !isClassification(cached)) { devCache[key] = result; localStorage.setItem(DEV_CLASSIFY_CACHE, JSON.stringify(devCache)) }
      if (result?.decision === 'assign') link.category = result.category
      else if (result?.decision === 'suggest_existing') link.pending_suggestion = { kind: 'existing', category: result.category, reason: result.reason }
      else if (result?.decision === 'suggest_new') link.pending_suggestion = { kind: 'new', category: result.category, description: result.description || '', reason: result.reason }
      link.ai_processed = true
    } catch { /* leave item available for normal retry */ }
    emitProgress({ label: 'Organising your saves…', done: index + 1, total: targets.length })
  }
  localStorage.setItem('later:links', JSON.stringify(links))
  window.dispatchEvent(new Event('later:categories-updated'))
}
