import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
}

async function fetchTitle(url: string): Promise<string> {
  const domain = (() => {
    try { return new URL(url).hostname.replace('www.', '') } catch { return url }
  })()

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Later-bot/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    })

    if (!res.ok) return domain

    // Read only first 50KB to avoid large payloads
    const reader = res.body?.getReader()
    if (!reader) return domain
    let html = ''
    let bytes = 0
    while (bytes < 50_000) {
      const { done, value } = await reader.read()
      if (done) break
      html += new TextDecoder().decode(value)
      bytes += value?.length ?? 0
    }
    reader.cancel()

    // og:title (both attribute orders)
    const ogMatch =
      html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)
    if (ogMatch) return decodeHtmlEntities(ogMatch[1].trim())

    // twitter:title
    const twMatch =
      html.match(/<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:title["']/i)
    if (twMatch) return decodeHtmlEntities(twMatch[1].trim())

    // <title>
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
    if (titleMatch) return decodeHtmlEntities(titleMatch[1].trim())

    // URL slug as last resort
    try {
      const pathname = new URL(url).pathname
      const slug = pathname.split('/').filter(Boolean).pop()
      if (slug) return slug.replace(/[-_]/g, ' ').replace(/\.\w+$/, '')
    } catch { /* ignore */ }

    return domain
  } catch {
    return domain
  }
}

Deno.serve(async (req) => {
  const { id, url } = await req.json()

  const title = await fetchTitle(url)

  const prompt = `You are a link classifier for a minimal save-for-later app.

Given a URL and page title, return a JSON object with exactly these fields:

{
  "category": one of ["Articles", "Cooking", "Travel", "Shopping", "Videos", "Research", "News", "Other"],
  "read_time_minutes": integer or null (only for text content like articles/recipes — null for products, flights, videos)
}

Rules:
- Articles: blog posts, essays, long-form writing, opinion pieces
- Cooking: recipes, food blogs, cooking guides
- Travel: flights, hotels, destinations, itineraries
- Shopping: products, stores, wishlists
- Videos: YouTube, Vimeo, streaming content
- Research: documentation, papers, how-to guides, references
- News: news articles, current events
- Other: anything that doesn't fit clearly
- read_time_minutes: estimate based on typical article/recipe length. Return null for non-text content.
- Return only valid JSON, no explanation.

URL: ${url}
Title: ${title}`

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  const aiData = await response.json()
  const text = aiData.content?.[0]?.text ?? '{}'

  let classification = { category: 'Other', read_time_minutes: null }
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) classification = { ...classification, ...JSON.parse(jsonMatch[0]) }
  } catch { /* use defaults */ }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  await supabase.from('links').update({
    title,
    category: classification.category,
    read_time_minutes: classification.read_time_minutes,
    ai_processed: true,
  }).eq('id', id)

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
