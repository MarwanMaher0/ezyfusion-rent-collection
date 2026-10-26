-- R56 (bonus): realtime tenant portal — publish payment and gateway-bill changes.
-- D73: realtime postgres_changes are filtered by RLS for the subscriber's JWT
-- (the existing payments_select / gateway_bills_select policies), so tenants only
-- receive rows of their own leases and staff only rows of their org; no new grants
-- or policies are added, and anon still has no table privileges.
alter publication supabase_realtime add table public.payments, public.gateway_bills;
