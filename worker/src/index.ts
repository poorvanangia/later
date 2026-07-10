// Later — categorisation + title-generation edge endpoint.
//
// Three POST routes:
//   /classify  → body { text, existing_categories? } → { category }
//   /title     → body { text }                       → { title }
//   /subscribe → body { email }                      → { ok: true }
//
// All require:
//   Header "X-Later-Auth: <SHARED_SECRET env var>"
//   Rate limit: 120 requests / hour / IP (shared bucket across all routes)
//
// Env vars (set via `wrangler secret put`):
//   ANTHROPIC_API_KEY  — Anthropic API key
//   SHARED_SECRET      — Any random string; the Mac client embeds the same value
//
// KV bindings (see wrangler.toml):
//   SUBSCRIBERS        — key/value store for /subscribe email captures
//
// Cost/abuse notes: the shared secret is discoverable in the client binary
// (strings on the .app). It stops casual scraping, not a determined attacker.
// Real abuse mitigation is the per-IP rate limit + your Anthropic monthly cap.

export interface Env {
  ANTHROPIC_API_KEY: string
  SHARED_SECRET: string
  SUBSCRIBERS: KVNamespace
}

const CLASSIFY_PROMPT = (existingBlock: string, text: string) => `You are categorising a single item in a personal save-for-later app.

${existingBlock}

HARD RULES — follow these before anything else:
1. If one of the user's existing categories SEMANTICALLY fits, return it EXACTLY as written. This prevents near-duplicates like "Work - Ops" vs "Work - Operations". BUT — do not force a bad match just because an existing category is topically nearby. Example: if "Work - Finance" exists and the user adds "Pay council tax", that is NOT a fit (council tax is a household bill, not work) — invent the correct category ("Home") instead.
2. NEVER add a subcategory to Personal, Entertainment, Health, or Food. These stay at the top level unless there is a VERY strong reason.
3. ONLY add a subcategory to Work when the function is clear and specific. Allowed Work subcategories: Hiring, Ops, Legal, Finance, Marketing, Engineering, Learning.
4. Shopping ONLY gets a subcategory when it clearly matches Travel, Groceries, or Home. Otherwise it's just Shopping.
5. HOUSEHOLD BILLS (council tax, water, gas, electricity, broadband, TV licence, rent) go under "Home", NOT "Finance - Bills". "Finance - Bills" is reserved for personal finance obligations that aren't tied to a residence (credit cards, loans, subscriptions, taxes on income).
6. When you are not confident about a subcategory, DEFAULT TO THE TOP-LEVEL CATEGORY ONLY. Being broad and right beats being specific and wrong.
7. NEVER reply "Other", "Misc", "Uncategorised", or anything generic.
8. Reply with ONLY the category name. No quotes, no punctuation, no explanation.

Pinned examples — match this style exactly:
"Interview with Tom" → Work - Hiring
"Define team OKRs" → Work - Ops
"Read compliance requirements" → Work - Ops
"Read article on leadership" → Work - Learning
"Review pull request" → Work - Engineering
"Post on Instagram" → Work - Marketing
"Book flights to London" → Travel
"Buy suitcases" → Shopping - Travel
"Buy groceries" → Shopping - Groceries
"Get milk" → Shopping
"Pay council tax" → Home
"Council tax" → Home
"Pay water bill" → Home
"Pay gas bill" → Home
"Pay electricity bill" → Home
"Fix the leaking tap" → Home
"Pay off credit card" → Finance - Bills
"Renew Netflix subscription" → Finance - Bills
"Call mom" → Personal
"Anniversary dinner reservation" → Personal
"Watch The Bear" → Entertainment
"Dentist appointment" → Health
"Renew passport" → Admin
"Pick up dry cleaning" → Errands

Item: ${text}`

const TITLE_PROMPT = (text: string) => `Summarize the following note as a short title (max 10 words, no quotes, no trailing punctuation). Reply with ONLY the title.

Note: ${text}`

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-haiku-4-5-20251001'

interface ClassifyBody { text?: string; existing_categories?: string[] }
interface TitleBody { text?: string }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return corsPreflight()
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405)

    if (request.headers.get('X-Later-Auth') !== env.SHARED_SECRET) {
      return json({ error: 'unauthorized' }, 401)
    }

    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
    const rate = await checkRateLimit(ip)
    if (!rate.ok) {
      return json({ error: 'rate_limited', retry_after: rate.retryAfter }, 429, {
        'Retry-After': String(rate.retryAfter),
      })
    }

    const url = new URL(request.url)
    try {
      if (url.pathname === '/classify') return await handleClassify(request, env)
      if (url.pathname === '/title') return await handleTitle(request, env)
      if (url.pathname === '/subscribe') return await handleSubscribe(request, env)
      return json({ error: 'not found' }, 404)
    } catch (e) {
      console.error('handler threw:', e)
      return json({ error: 'internal_error' }, 500)
    }
  },
}

async function handleClassify(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as ClassifyBody
  const text = (body.text ?? '').trim()
  if (!text) return json({ error: 'text required' }, 400)
  const cats = Array.isArray(body.existing_categories) ? body.existing_categories.filter(c => typeof c === 'string') : []
  const existingBlock = cats.length === 0
    ? "The user has no categories yet — invent the right one."
    : `The user's existing categories:\n${cats.map(c => `- ${c}`).join('\n')}`
  const prompt = CLASSIFY_PROMPT(existingBlock, text)
  const raw = await callAnthropic(env.ANTHROPIC_API_KEY, prompt, 30)
  // Reject sentence-shaped responses. The model sometimes refuses gibberish input
  // ("I don't have enough context to categorize...") and that would otherwise get
  // stored as the category string. A real category is 1-4 words, no sentence
  // punctuation, no apologetic phrases.
  const looksLikeSentence = raw.length > 40 || /[.!?]/.test(raw) || /\b(i don't|i can't|i need|unable|unclear|context)\b/i.test(raw)
  const category = looksLikeSentence ? '' : raw
  return json({ category })
}

interface SubscribeBody { email?: string }

async function handleSubscribe(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as SubscribeBody
  const raw = (body.email ?? '').trim()
  if (!raw) return json({ error: 'email required' }, 400)
  if (raw.length > 320) return json({ error: 'email too long' }, 400)
  const email = raw.toLowerCase()
  // Deliberately permissive — better to accept a wonky-looking address than to
  // reject a real one. Just enforces one @ with something on each side and a dot.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'invalid email' }, 400)
  }
  const record = JSON.stringify({
    email,
    source: 'first_launch',
    created_at: Math.floor(Date.now() / 1000),
  })
  await env.SUBSCRIBERS.put(`email:${email}`, record)
  return json({ ok: true })
}

async function handleTitle(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as TitleBody
  const text = (body.text ?? '').trim()
  if (!text) return json({ error: 'text required' }, 400)
  const raw = await callAnthropic(env.ANTHROPIC_API_KEY, TITLE_PROMPT(text), 40)
  // Match the Rust behaviour of stripping surrounding quotes.
  const title = raw.replace(/^"+|"+$/g, '').trim()
  return json({ title })
}

async function callAnthropic(apiKey: string, prompt: string, maxTokens: number): Promise<string> {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>')
    console.error(`anthropic ${res.status}: ${text}`)
    throw new Error(`anthropic ${res.status}`)
  }
  const j = await res.json() as { content?: Array<{ text?: string }> }
  return (j.content?.[0]?.text ?? '').trim()
}

// Sliding-hour rate limit using Cloudflare's per-colo cache. Not distributed
// (each colo has its own count), but perfectly adequate for a "stop accidental
// spam" bar. If the client rotates IPs the limit resets — that's the tradeoff
// for keeping the deploy KV-free.
const LIMIT = 120
const WINDOW_SECONDS = 3600

async function checkRateLimit(ip: string): Promise<{ ok: true } | { ok: false; retryAfter: number }> {
  // caches.default is a Cloudflare Workers extension not present in DOM's CacheStorage,
  // hence the cast — @cloudflare/workers-types adds it but TS picks the DOM shape first.
  const cache = (caches as unknown as { default: Cache }).default
  const key = new Request(`https://rl.local/${encodeURIComponent(ip)}`)
  const now = Math.floor(Date.now() / 1000)
  const cached = await cache.match(key)
  let count = 0
  let firstSeen = now
  if (cached) {
    const parsed = await cached.json().catch(() => null) as { count?: number; firstSeen?: number } | null
    if (parsed && typeof parsed.count === 'number' && typeof parsed.firstSeen === 'number') {
      if (now - parsed.firstSeen < WINDOW_SECONDS) {
        count = parsed.count
        firstSeen = parsed.firstSeen
      }
    }
  }
  if (count >= LIMIT) {
    return { ok: false, retryAfter: WINDOW_SECONDS - (now - firstSeen) }
  }
  const nextBody = JSON.stringify({ count: count + 1, firstSeen })
  const ttl = WINDOW_SECONDS - (now - firstSeen)
  await cache.put(key, new Response(nextBody, {
    headers: { 'Cache-Control': `max-age=${ttl}` },
  }))
  return { ok: true }
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, x-later-auth',
      ...extraHeaders,
    },
  })
}

function corsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type, x-later-auth',
      'access-control-max-age': '86400',
    },
  })
}
