import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? ''
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? ''

export const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseAnonKey || 'placeholder'
)

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
}
