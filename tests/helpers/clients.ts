import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env";

const noSession = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;

/** Data API / Storage as anon: publishable key, no user token. */
export function anonClient(): SupabaseClient {
  return createClient(env.supabaseUrl, env.publishableKey, { auth: noSession });
}

/**
 * Data API / Storage as a signed-in user: publishable key + `Authorization: Bearer <accessToken>`.
 * supabase-js keeps an explicit Authorization header, so PostgREST, Storage and RPC all see the JWT.
 */
export function userClient(accessToken: string): SupabaseClient {
  return createClient(env.supabaseUrl, env.publishableKey, {
    auth: noSession,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/** Secret-key client (bypasses RLS). Test setup only: creating auth users, signed URLs, cleanup of storage. */
export function adminClient(): SupabaseClient {
  return createClient(env.supabaseUrl, env.secretKey, { auth: noSession });
}
