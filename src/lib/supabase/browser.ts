import { createBrowserClient } from '@supabase/ssr'

// Browser client: publishable key only (R41). NEXT_PUBLIC_* must be referenced literally to be inlined.
export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  if (!url || !key) throw new Error('Supabase URL or publishable key is not set')
  return createBrowserClient(url, key)
}
