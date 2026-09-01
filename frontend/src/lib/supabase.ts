import { createClient } from '@supabase/supabase-js'

/**
 * Supabase is the identity provider for the whole app. Sign-in mints the JWT
 * that `backend-node` verifies on every request via `supabase.auth.getUser`,
 * so these two variables are not optional — without them nothing authenticates.
 */
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  // Failing loudly here beats a stream of opaque 401s from the API later.
  throw new Error(
    'Missing VITE_SUPABASE_URL and/or VITE_SUPABASE_ANON_KEY. Copy .env.example to .env and fill them in.',
  )
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
