// Later — categorisation + title-generation edge endpoint.
//
// Three POST routes:
//   /classify  → body { text, existing_categories?, category_descriptions? } → { decision, category, description?, reason }
//   /title     → body { text }                                               → { title }
//   /subscribe → body { email }                                              → { ok: true }
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

// The categorizer respects the user's taxonomy as a strict allowlist. It never
// silently invents a category — the only way a new category enters the
// sidebar is via explicit user confirmation of a `suggest_new` verdict on the
// client. `assign` and `suggest_existing` MUST return a name that exactly
// matches one of the user's categories; the server post-validates this and
// downgrades any hallucinated name to `none`.
//
// Output shape is enforced via Anthropic tool-use with `tool_choice: {type: "tool"}`.
// This means the model MUST call the classify tool with our exact schema; we no
// longer parse free-form text and hope for valid JSON. Previously ~5-10% of
// Haiku calls returned prose and were dropped to `none`.
const CLASSIFY_PROMPT = (
  existingBlock: string,
  hasExisting: boolean,
  text: string,
) => `You are Later's categorizer. Classify a single item into one of the user's existing categories, or flag it for the user's review. You NEVER invent a category and assign it silently — invention only happens via the "suggest_new" path, which the user must confirm.

${existingBlock}

DECISION RULES (in strict priority order):
1. "assign": Highly confident (≥90%) the item belongs in one of the user's existing categories. The item must fit either (a) the category's description if one is provided, or (b) the plain reading of the category's name if no description. Use this only for obvious, unambiguous fits.
2. "suggest_existing": An existing category is a plausible fit but not obvious enough to auto-assign. The user will confirm or reject via a chip.
3. "suggest_new": NO existing category is a plausible fit — even loosely. Propose a new category (1-3 words, Title Case, no punctuation) and a one-sentence description.
4. "none": The text has no semantic content (empty, one or two characters, pure gibberish). Rare.

HOW TO INTERPRET CATEGORIES:
- If a category HAS a description, the description is AUTHORITATIVE. The category's scope is exactly what the description says — not what its name might imply. An item only fits if the description clearly covers it. If the description enumerates specific domains (e.g. "reading blogs, articles, recipes, health bookings, gym"), an item outside those domains does NOT fit, even if it feels vaguely related to the name. Prefer "suggest_new" in that case.
- If a category has NO description, interpret the name generously: "Personal" covers non-work life admin (appointments, family, errands, hobbies); "Work" covers job-related tasks; "Shopping" covers buying things; "Home" covers household matters. In this case, prefer "suggest_existing" for plausible fits.
- Never stretch a described category to fit an item that clearly falls outside its stated scope. Better to propose a new category the user can reject than to force a bad fit.

HARD CONSTRAINTS:
- For "assign" and "suggest_existing", \`category\` MUST be an EXACT verbatim copy of one of the strings in the user's category list above — same casing, same words, no added subcategory, no punctuation changes. Before finalizing, RE-READ the user's category list and confirm your \`category\` string appears there character-for-character. If it doesn't, you must use "suggest_new" with the correct name instead.
- NEVER return "Other", "Misc", "Uncategorized", or any generic placeholder as a category name.

NAMING CONVENTIONS for "suggest_new":
- Prefer plain, everyday consumer names over business or technical jargon. Examples of good names: Shopping, Home, Travel, Health, Errands, Reading, Watching, Learning, Cooking, Fitness. Examples to AVOID: Procurement, Acquisitions, Consumption, Operations, Consumables, Miscellaneous.
- Use the singular or standard form users would say in conversation. "Shopping" not "Purchases"; "Travel" not "Trips"; "Home" not "Household Management".
- Even if the user's other categories use jargon (e.g. "Company Ops"), don't mirror that tone for personal-life items — those get plain names.

DOMAIN ROUTING (HIGHEST PRIORITY — overrides the description-authoritative rule above):
The item types listed below have SO strong an association with their named bucket that they route there even when another category's description would technically cover them. A broad Work - Ops description like "anything I need to do for the company" does NOT capture a flight booking — flights go to Travel. Same for shopping, health, home, etc. When in doubt for these domains, prefer suggest_new for the domain-named bucket over assigning to a topically-adjacent existing one.



  SHOPPING (physical goods you buy): electronics, appliances, phones, clothes, furniture, groceries.
    "Order a microwave" / "Buy a new phone" / "Order running shoes" → Shopping (or suggest_new Shopping)
    "Get groceries" / "Buy milk" → Shopping - Groceries (or Shopping if no sub-cat)
    Household-maintenance ("Fix the leaking tap", "Pay water bill") is NOT shopping — those are Home.

  TRAVEL (getting somewhere, being somewhere for a trip): flights, hotels, Airbnbs, itineraries, packing lists tied to a trip, visas.
    "Book flights to Tokyo" / "Reserve hotel in Lisbon" / "Plan Kyoto itinerary" → Travel
    "Buy suitcases" → Shopping - Travel (if that sub-cat exists) or Shopping

  HOME (household matters, bills tied to a residence): rent, council tax, utilities, repairs, cleaner.
    "Pay council tax" / "Pay water bill" / "Fix the leaking tap" → Home

  HEALTH (medical, fitness, wellness appointments and tasks): doctor visits, prescriptions, dentist, gym plans.
    "Dentist appointment" / "Book GP" / "Refill prescription" → Health

  ENTERTAINMENT (things to watch, listen to, play): shows, films, podcasts, games.
    "Watch The Bear" / "Finish Baldur's Gate" → Entertainment

  FINANCE (personal-finance obligations not tied to a residence): credit cards, subscriptions, taxes on income, loans.
    "Pay off credit card" / "Renew Netflix" → Finance - Bills (or Finance)

  WORK (professional life; when the item is clearly job-related, prefer the most specific Work sub-cat that exists):
    Interviews, hiring → Work - Hiring
    OKRs, planning, ops rituals → Work - Ops
    Reading for learning → Work - Learning
    Code review, engineering → Work - Engineering
    Posts, launches, campaigns → Work - Marketing

  PERSONAL is for family, close relationships, and personal appointments that don't fit any other bucket. It is NOT a catch-all for anything vaguely personal-life. "Call mom", "Anniversary dinner reservation" → Personal. "Order a microwave" or "Book flights to Tokyo" do NOT belong here.

If none of the domain buckets above already exist as a category, use suggest_new to propose the correct one — DO NOT stretch Personal, Home, or any topically-adjacent category to fit.
${hasExisting ? '' : '\nNOTE: The user has no categories yet. Use "suggest_new" for real items and "none" for empty/gibberish input.'}

ITEM:
${text}
`

// Tool schema forced on the model via tool_choice. The `input_schema` is what
// makes the API guarantee shape-conformant output — no free-form JSON parsing
// on our end.
const CLASSIFY_TOOL = {
  name: 'record_classification',
  description: 'Record the categorization decision for the item.',
  input_schema: {
    type: 'object',
    properties: {
      decision: {
        type: 'string',
        enum: ['assign', 'suggest_existing', 'suggest_new', 'none'],
        description: 'The categorization verdict.',
      },
      category: {
        type: 'string',
        description: 'For assign/suggest_existing: the EXACT existing category name. For suggest_new: the proposed new category name (1-3 words, Title Case). For none: empty string.',
      },
      description: {
        type: 'string',
        description: 'For suggest_new only: a one-sentence description of what belongs in this new category. Empty string for other decisions.',
      },
      reason: {
        type: 'string',
        description: 'A short phrase (max 15 words) explaining the choice.',
      },
    },
    required: ['decision', 'category', 'description', 'reason'],
  },
} as const

const TITLE_PROMPT = (text: string) => `Summarize the following note as a short title (max 10 words, no quotes, no trailing punctuation). Reply with ONLY the title.

Note: ${text}`

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-haiku-4-5-20251001'
// Reasoning model for the second-pass /reclassify endpoint. Sonnet 4.6
// baseline (no extended thinking) — meaningfully smarter than Haiku on
// borderline categorization decisions while still ~2-3s per call. Extended
// thinking was tried but pushed latency to 10-15s, which was unusable for a
// menu-bar app's chip-flip UX. The classify prompt already lays out the
// decision rules explicitly, so a thinking scratchpad added little.
const REASONING_MODEL = 'claude-sonnet-4-6'

interface ClassifyBody {
  text?: string
  existing_categories?: string[]
  category_descriptions?: Record<string, string>
  // Currently-pending suggest_new category names from prior classifications
  // that the user hasn't accepted or rejected yet. The classifier is
  // instructed to reuse one of these names for the current item if it fits
  // the same theme, so we don't proliferate near-duplicates like "Shopping"
  // and "Procurement" for two purchase items.
  pending_new_names?: string[]
  // Free-text description of the user (role, company, focus areas) captured
  // during onboarding. Used to bias interpretation of ambiguous items — e.g.
  // "meeting with Tom" reads as Hiring for a founder-recruiter but Personal
  // for a therapist. Empty string when the user skipped the profile step.
  user_profile?: string
}
interface TitleBody { text?: string }

type Decision = 'assign' | 'suggest_existing' | 'suggest_new' | 'none'
interface ClassifyResult {
  decision: Decision
  category: string
  description: string
  reason: string
}

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
      if (url.pathname === '/reclassify') return await handleReclassify(request, env)
      if (url.pathname === '/title') return await handleTitle(request, env)
      if (url.pathname === '/subscribe') return await handleSubscribe(request, env)
      if (url.pathname === '/parse_reminder') return await handleParseReminder(request, env)
      return json({ error: 'not found' }, 404)
    } catch (e) {
      console.error('handler threw:', e)
      return json({ error: 'internal_error' }, 500)
    }
  },
}

// Natural-language reminder parser. Client sends the user's phrase plus the
// current time in the user's local timezone so we don't have to guess "9am"
// relative to a UTC clock. Returns an ISO datetime or null; the client shows
// a manual picker if the model can't parse it confidently.
interface ParseReminderBody {
  text?: string
  now_iso?: string
  timezone?: string
}
interface ParseReminderResult {
  parsed: string | null   // ISO datetime or null
  reason: string
}

const PARSE_REMINDER_TOOL = {
  name: 'record_reminder_time',
  description: 'Record the parsed reminder time from a user\'s natural-language phrase.',
  input_schema: {
    type: 'object',
    properties: {
      parsed: {
        type: 'string',
        description: 'ISO 8601 datetime in the user\'s local timezone (e.g. "2026-09-09T09:00:00-07:00"). Empty string if the phrase cannot be confidently parsed as a specific time.',
      },
      reason: {
        type: 'string',
        description: 'One short phrase describing your interpretation, e.g. "tomorrow morning" → "9am next calendar day".',
      },
    },
    required: ['parsed', 'reason'],
  },
} as const

async function handleParseReminder(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as ParseReminderBody
  const text = (body.text ?? '').trim()
  if (!text) return json({ error: 'text required' }, 400)
  const nowIso = typeof body.now_iso === 'string' ? body.now_iso : ''
  const tz = typeof body.timezone === 'string' ? body.timezone : 'UTC'

  const prompt = `You are Later's reminder time parser. Convert a natural-language phrase into a specific datetime.

CONTEXT:
- Current time (user's local time): ${nowIso || 'unknown'}
- User's timezone: ${tz}

USER'S PHRASE:
${text}

RULES:
1. Return an ISO 8601 datetime in the user's local timezone (with offset, e.g. "2026-09-09T09:00:00-07:00").
2. The parsed time MUST be strictly in the future relative to the current time. If the user names a specific calendar date (e.g. "Sept 8", "the 8th", "8th sep") and that exact calendar date is TODAY or later at the specified time, use that literal date — do NOT hop to a future week just because a weekday name is included. If the specified time on that literal date is already in the past, THEN advance to the next reasonable occurrence.
3. When the phrase is vague ("morning" → 9am, "afternoon" → 2pm, "evening" → 7pm, "tonight" → 8pm) use the standard defaults.
4. "in N hours/minutes/days" is relative to the current time.
5. "tomorrow" without a specific time defaults to 9am next calendar day.
6. Weekday names alone ("next Monday", "Friday") mean the next occurrence of that weekday; combined with a date ("Tuesday Sept 8") the date is authoritative — trust the numeric date, use the weekday as confirmation only.
7. If the phrase cannot be confidently parsed as a specific time (too vague, empty, gibberish), return an empty string for \`parsed\` and explain why in \`reason\`.

Invoke the record_reminder_time tool with your answer.
`

  const toolResult = await callAnthropicWithTool(env.ANTHROPIC_API_KEY, prompt, PARSE_REMINDER_TOOL as unknown as typeof CLASSIFY_TOOL)
  if (!toolResult) {
    return json({ parsed: null, reason: 'parse_failed' } as ParseReminderResult)
  }
  const raw = (toolResult as unknown as { parsed?: string; reason?: string })
  const parsedRaw = typeof raw.parsed === 'string' ? raw.parsed.trim() : ''
  const reason = typeof raw.reason === 'string' ? raw.reason.trim().slice(0, 200) : ''

  if (!parsedRaw) {
    return json({ parsed: null, reason: reason || 'no_confident_parse' } as ParseReminderResult)
  }
  // Validate it parses as a real date and is in the future.
  const dt = new Date(parsedRaw)
  if (isNaN(dt.getTime())) {
    return json({ parsed: null, reason: 'invalid_iso' } as ParseReminderResult)
  }
  if (nowIso) {
    const now = new Date(nowIso)
    if (!isNaN(now.getTime()) && dt.getTime() <= now.getTime()) {
      return json({ parsed: null, reason: 'parsed_time_in_past' } as ParseReminderResult)
    }
  }
  return json({ parsed: dt.toISOString(), reason } as ParseReminderResult)
}

// Second-pass reclassify — Sonnet 4.6 for items Haiku wasn't confident about.
// Same request/response contract as /classify, same tool schema, same
// validation. The client only calls this after seeing a non-`assign` verdict,
// so ~90% of items skip this path.
//
// Prompt strategy: SHORTER than the first-pass prompt. Sonnet doesn't need
// the full DOMAIN ROUTING rulebook that guides Haiku — it's a strong model
// that can reason about domain fit from the item text + category list alone.
// Cutting the prompt roughly in half shaves ~1-2s off the reasoning latency.
async function handleReclassify(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as ClassifyBody
  const text = (body.text ?? '').trim()
  if (!text) return json({ error: 'text required' }, 400)

  const cats = Array.isArray(body.existing_categories)
    ? body.existing_categories.filter((c): c is string => typeof c === 'string' && c.length > 0)
    : []
  const descs = (body.category_descriptions && typeof body.category_descriptions === 'object')
    ? body.category_descriptions
    : {}

  const catList = cats.length === 0
    ? '(the user has no categories yet)'
    : cats.map(c => {
        const d = descs[c]
        return d ? `- ${c} — ${d}` : `- ${c}`
      }).join('\n')

  const pendingNames = Array.isArray(body.pending_new_names)
    ? body.pending_new_names.filter((n): n is string => typeof n === 'string' && n.length > 0)
    : []
  const pendingLine = pendingNames.length === 0
    ? ''
    : `\nPending new-category proposals from earlier items: ${pendingNames.map(n => `"${n}"`).join(', ')}. Reuse one of these names (with decision suggest_new) if this item fits the same theme.`

  const profileText = typeof body.user_profile === 'string' ? body.user_profile.trim().slice(0, 1000) : ''
  const profileLine = profileText.length === 0
    ? ''
    : `\nAbout the user (for tilting close calls, not overriding clear fits): ${profileText}`

  const prompt = RECLASSIFY_PROMPT(catList, pendingLine, profileLine, text)
  const toolResult = await callAnthropicReasoning(env.ANTHROPIC_API_KEY, prompt, CLASSIFY_TOOL)

  const validated = validateClassify(toolResult, cats)
  return json(validated)
}

const RECLASSIFY_PROMPT = (catList: string, pendingLine: string, profileLine: string, text: string) => `You are Later's second-pass categorizer. The first pass (Haiku) was unsure. Decide again with more care.

USER'S CATEGORIES (STRICT ALLOWLIST — assign/suggest_existing must return one of these EXACTLY):
${catList}
${pendingLine}${profileLine}

DECIDE (in strict priority order):
1. "assign" — highly confident (≥90%) this belongs in one of the existing categories above. Category name MUST be verbatim from the list.
2. "suggest_existing" — an existing category is plausible but not obvious. Pick the closest name verbatim.
3. "suggest_new" — no existing category fits. Propose a new plain, everyday name (1-3 words, Title Case: "Shopping", "Travel", "Health") + a one-sentence description. NEVER stretch Personal / Home / Work to fit a domain that doesn't match — buying goods → Shopping, trips/flights → Travel, medical → Health.
4. "none" — no semantic content (empty, gibberish).

If a category has a description, the description is authoritative — the category only fits items that match the description, not the name's loose reading.

ITEM: ${text}
`

async function handleClassify(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as ClassifyBody
  const text = (body.text ?? '').trim()
  if (!text) return json({ error: 'text required' }, 400)

  const cats = Array.isArray(body.existing_categories)
    ? body.existing_categories.filter((c): c is string => typeof c === 'string' && c.length > 0)
    : []
  const descs = (body.category_descriptions && typeof body.category_descriptions === 'object')
    ? body.category_descriptions
    : {}

  const existingBlock = cats.length === 0
    ? 'USER\'S CATEGORIES: (none yet — the user hasn\'t created any categories)'
    : `USER'S CATEGORIES (STRICT ALLOWLIST — assign/suggest_existing must return one of these EXACTLY):\n${cats.map(c => {
        const d = descs[c]
        return d ? `- ${c} — ${d}` : `- ${c}`
      }).join('\n')}`

  const pendingNames = Array.isArray(body.pending_new_names)
    ? body.pending_new_names.filter((n): n is string => typeof n === 'string' && n.length > 0)
    : []
  const pendingBlock = pendingNames.length === 0
    ? ''
    : `\n\nPENDING NEW-CATEGORY PROPOSALS (already suggested for earlier items, awaiting the user's confirmation): ${pendingNames.map(n => `"${n}"`).join(', ')}\nIf this item fits the same theme as one of these pending names, REUSE that exact name in \`category\` (still with decision "suggest_new"). Only invent a genuinely new name when this item's theme is distinct from all pending ones.`

  const profileText = typeof body.user_profile === 'string' ? body.user_profile.trim().slice(0, 1000) : ''
  const profileBlock = profileText.length === 0
    ? ''
    : `\n\nABOUT THE USER (self-described — use this to bias interpretation of ambiguous items):\n${profileText}\nThis context is a PRIOR, not a constraint: it should tilt close calls (e.g. "meeting with Tom" → Hiring for a founder-recruiter, Personal for a therapist) but should never override an item that clearly fits an existing category.`

  const prompt = CLASSIFY_PROMPT(existingBlock + pendingBlock + profileBlock, cats.length > 0, text)
  const toolResult = await callAnthropicWithTool(env.ANTHROPIC_API_KEY, prompt, CLASSIFY_TOOL)

  const validated = validateClassify(toolResult, cats)
  return json(validated)
}

// Enforce the response invariants server-side so the client can trust the
// shape. Any deviation from the allowlist for assign/suggest_existing is
// downgraded to `none` rather than silently invented — the client falls back to
// Uncategorized on `none`.
function validateClassify(p: Partial<ClassifyResult> | null, cats: string[]): ClassifyResult {
  const fallback: ClassifyResult = { decision: 'none', category: '', description: '', reason: 'parse_failed' }
  if (!p) return fallback

  const decision = p.decision as Decision | undefined
  const category = typeof p.category === 'string' ? p.category.trim() : ''
  const description = typeof p.description === 'string' ? p.description.trim() : ''
  const reason = typeof p.reason === 'string' ? p.reason.trim().slice(0, 200) : ''

  const generic = /^(other|misc|miscellaneous|uncategori[sz]ed|general|unknown|n\/a)$/i

  if (decision === 'none') {
    return { decision: 'none', category: '', description: '', reason: reason || 'no_content' }
  }

  if (decision === 'assign' || decision === 'suggest_existing') {
    if (!category) {
      return { decision: 'none', category: '', description: '', reason: 'empty_category' }
    }
    // Model claimed an existing category but the name isn't in the allowlist.
    // Rather than dropping to `none` (which shows no chip and no signal to the
    // user), promote to `suggest_new` — the model is effectively proposing
    // this as a new category. The user can accept or reject.
    if (!cats.includes(category)) {
      // Take just the first phrase before punctuation — Sonnet sometimes
      // returns a whole sentence instead of a category name. Cap to 4 words.
      const firstClause = category.split(/[.!?,;:—-]/)[0].trim()
      const words = firstClause.split(/\s+/).slice(0, 4).join(' ')
      if (!words) return { decision: 'none', category: '', description: '', reason: 'hallucinated_unrecoverable' }
      return { decision: 'suggest_new', category: words, description: description.slice(0, 240), reason: `${reason || ''} [promoted_from_hallucinated_existing]`.trim() }
    }
    return { decision, category, description: '', reason }
  }

  if (decision === 'suggest_new') {
    if (!category || generic.test(category)) {
      return { decision: 'none', category: '', description: '', reason: 'invalid_new_category' }
    }
    // Reject anything that already exists — model should have picked existing instead.
    if (cats.includes(category)) {
      return { decision: 'suggest_existing', category, description: '', reason: 'promoted_from_suggest_new' }
    }
    // Cap 3 words, strip trailing punctuation. Anything wilder is probably a hallucination.
    const cleaned = category.replace(/[.!?,;:]+$/, '').trim()
    if (cleaned.split(/\s+/).length > 4) {
      return { decision: 'none', category: '', description: '', reason: 'new_category_too_long' }
    }
    return { decision: 'suggest_new', category: cleaned, description: description.slice(0, 240), reason }
  }

  return fallback
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

// Sonnet 4.6 baseline (no extended thinking) with forced tool call. Same
// deterministic shape as the Haiku classify call, just a smarter model.
async function callAnthropicReasoning(
  apiKey: string,
  prompt: string,
  tool: typeof CLASSIFY_TOOL,
): Promise<Partial<ClassifyResult> | null> {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: REASONING_MODEL,
      max_tokens: 512,
      temperature: 0,
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>')
    console.error(`anthropic reasoning ${res.status}: ${text}`)
    throw new Error(`anthropic reasoning ${res.status}`)
  }
  const j = await res.json() as { content?: Array<{ type?: string; name?: string; input?: unknown }> }
  const toolUse = j.content?.find(c => c.type === 'tool_use' && c.name === tool.name)
  if (!toolUse || typeof toolUse.input !== 'object' || toolUse.input === null) {
    console.error('reasoning: no tool_use block in response:', JSON.stringify(j))
    return null
  }
  return toolUse.input as Partial<ClassifyResult>
}

// Forces a specific tool call. The model MUST emit a tool_use block whose
// `input` conforms to the tool's input_schema — no free-form text. This
// eliminates the parse_failed path entirely for classification.
async function callAnthropicWithTool(
  apiKey: string,
  prompt: string,
  tool: typeof CLASSIFY_TOOL,
): Promise<Partial<ClassifyResult> | null> {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 512,
      // temperature=0 for repeatable classification. Same item + same
      // categories should always produce the same verdict. Default (1.0)
      // was causing sibling items ("Order a TV" vs "Order a microwave") to
      // land in different buckets across runs.
      temperature: 0,
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>')
    console.error(`anthropic ${res.status}: ${text}`)
    throw new Error(`anthropic ${res.status}`)
  }
  const j = await res.json() as { content?: Array<{ type?: string; name?: string; input?: unknown }> }
  const toolUse = j.content?.find(c => c.type === 'tool_use' && c.name === tool.name)
  if (!toolUse || typeof toolUse.input !== 'object' || toolUse.input === null) {
    console.error('no tool_use block in response:', JSON.stringify(j))
    return null
  }
  return toolUse.input as Partial<ClassifyResult>
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
