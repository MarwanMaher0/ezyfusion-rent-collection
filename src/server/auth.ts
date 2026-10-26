import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js'
import { unauthorized } from '@/lib/errors'
import { createClient as createCookieClient, publishableKey, supabaseUrl } from '@/lib/supabase/server'

const BEARER_RE = /^Bearer\s+(\S+)\s*$/i

let tokenClient: SupabaseClient | undefined

// Stateless client used only to validate a caller-supplied access token with the Auth server.
function getTokenClient(): SupabaseClient {
  tokenClient ??= createSupabaseClient(supabaseUrl(), publishableKey(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  return tokenClient
}

// R37/R40: identity comes from auth.getUser() (verified by the Auth server), never getSession().
// A Bearer header, when present, is the only credential considered: an invalid token is a 401 even if
// a session cookie is also sent.
export async function getUserId(req?: Request): Promise<string | null> {
  const header = req?.headers.get('authorization')
  const bearer = header ? BEARER_RE.exec(header) : null
  if (bearer) {
    const { data, error } = await getTokenClient().auth.getUser(bearer[1])
    return error || !data.user ? null : data.user.id
  }
  const supabase = await createCookieClient()
  const { data, error } = await supabase.auth.getUser()
  return error || !data.user ? null : data.user.id
}

export async function requireUserId(req?: Request): Promise<string> {
  const userId = await getUserId(req)
  if (!userId) throw unauthorized('Unauthorized')
  return userId
}
