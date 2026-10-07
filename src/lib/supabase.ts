import { createClient } from '@supabase/supabase-js'
import { detectAuthCallback } from './authLink'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const isSupabaseConfigured = Boolean(url && key)

// Public anon key only; RLS is the authorization boundary.
export const supabase = isSupabaseConfigured ? createClient(url!, key!, { auth: { detectSessionInUrl: detectAuthCallback } }) : null
