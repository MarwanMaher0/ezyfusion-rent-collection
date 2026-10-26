-- Hardening after the T-panel review (D50, D51). New migration so 0001/0002 stay as applied.

-- D50: slips are read only through the server's 60-second signed URL built from payments.slip_path;
-- with a SELECT policy a staff member could mint a long-lived signed URL with their own token.
-- Supersedes D34. The INSERT policy (payment_slips_insert) stays so staff/manager can upload.
drop policy if exists payment_slips_select on storage.objects;

-- D51: the app never writes through service_role (all writes are Prisma as postgres -> private
-- functions), so a leaked secret key cannot write any public row through the Data API. SELECT stays.
revoke insert, update, delete, truncate on all tables in schema public from service_role;

-- D51: tables created later by postgres (migrations) do not get the write grants back.
alter default privileges for role postgres in schema public
  revoke insert, update, delete, truncate on tables from service_role;
