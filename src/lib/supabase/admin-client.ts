import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// R41: the secret key is read only here, from a non-NEXT_PUBLIC_ variable, so Next never inlines it into a
// client bundle. This module has no 'server-only' marker so services also load under tsx (npm run seed)
// and vitest; UI/server components import it through ./admin.ts, which keeps the marker (D30).
let admin: SupabaseClient | undefined

export function createAdminClient(): SupabaseClient {
  if (admin) return admin
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const secret = process.env.SUPABASE_SECRET_KEY
  if (!url || !secret) throw new Error('Supabase URL or secret key is not set')
  admin = createClient(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  return admin
}
