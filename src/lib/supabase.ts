import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? ''
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? ''

export const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseAnonKey || 'placeholder'
)

// Provenance for items created from external sources (currently Gmail, via the
// browser extension's later://save deep link). Kept as a small discriminated
// union so a new source just adds a `kind` — the LinkRow itself doesn't grow a
// source-specific field set. Mirrors the shape defined in App.tsx.
export type LinkSourceRef =
  | { kind: 'gmail'; thread_id: string; message_id: string; url: string }
  | { kind: 'linkedin'; post_urn: string; url: string }

export type LinkRow = {
  id: string
  user_id: string
  url: string
  title: string | null
  note: string | null
  category: string | null
  label: string | null
  read_time_minutes: number | null
  intent: 'read' | 'act' | null
  is_done: boolean
  ai_processed: boolean
  created_at: string
  source_ref?: LinkSourceRef | null
}
