import 'server-only'

// R41: entry point for Next code; the build fails if a client component imports it.
export { createAdminClient } from './admin-client'
