-- T1 schema: tables, constraints, triggers, RLS helpers, RLS policies, grants, storage bucket + policies.
-- Source of truth for the DB (R47); prisma/schema.prisma is pulled from it.

-- ---------------------------------------------------------------------------
-- 0. Extensions, schema, privilege lockdown (before any object exists)
-- ---------------------------------------------------------------------------
create extension if not exists btree_gist with schema extensions; -- D16: uuid "=" inside a gist EXCLUDE

create schema if not exists private;

-- R42: nothing we create in public is reachable by anon/authenticated unless granted below.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema private revoke all on tables from anon, authenticated;
alter default privileges in schema private revoke all on sequences from anon, authenticated;
alter default privileges in schema private revoke all on functions from anon, authenticated;
alter default privileges in schema private revoke execute on functions from public;
-- R42: the per-schema form above cannot remove the global PUBLIC execute default (Postgres grants it
-- unless the role-wide default is revoked), so revoke it for the migration owner as well.
alter default privileges for role postgres revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) > 0),
  created_at timestamptz not null default now()
);

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  -- D17: unique(user_id) = a staff member or manager belongs to exactly one organization (R2).
  user_id uuid not null unique references auth.users (id) on delete cascade,
  org_id uuid not null references public.organizations (id),
  role text not null check (role in ('manager', 'staff')),
  created_at timestamptz not null default now()
);
create index memberships_org_id_idx on public.memberships (org_id);

create table public.units (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  name text not null check (char_length(btrim(name)) > 0),
  created_at timestamptz not null default now(),
  unique (org_id, name),
  unique (org_id, id) -- composite FK target: a lease can only point at a unit of its own org (R39)
);

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  -- D17: tenant role comes from tenants.user_id, never user_metadata (R37).
  user_id uuid null references auth.users (id) on delete set null,
  full_name text not null check (char_length(btrim(full_name)) > 0),
  email text not null,
  phone text null check (phone ~ '^\+?[0-9][0-9 -]{5,19}$'),
  created_at timestamptz not null default now(),
  unique (org_id, user_id),
  unique (org_id, id)
);
create index tenants_user_id_idx on public.tenants (user_id); -- RLS: user_id = auth.uid()

create table public.leases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  unit_id uuid not null,
  tenant_id uuid not null,
  start_date date not null,
  end_date date not null,
  monthly_rent_sen bigint not null check (monthly_rent_sen > 0), -- D3: bigint sen
  deposit_sen bigint not null check (deposit_sen >= 0),
  currency char(3) not null default 'MYR' check (currency = 'MYR'), -- D3: single currency
  created_by uuid null,
  created_at timestamptz not null default now(),
  check (end_date >= start_date),
  foreign key (org_id, unit_id) references public.units (org_id, id),
  foreign key (org_id, tenant_id) references public.tenants (org_id, id),
  unique (org_id, id),
  unique (id, org_id),
  -- D16: same-unit leases never overlap, both dates inclusive, race-proof (23P01 -> 409) (R46).
  constraint leases_no_overlap exclude using gist (
    unit_id with =,
    daterange(start_date, end_date, '[]') with &&
  )
);
create index leases_org_unit_idx on public.leases (org_id, unit_id);
create index leases_org_tenant_idx on public.leases (org_id, tenant_id);
create index leases_tenant_id_idx on public.leases (tenant_id);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  lease_id uuid not null,
  kind text not null check (kind in ('deposit', 'rent')),
  period_index int null,
  period_start date null,
  period_end date null,
  due_date date not null,
  -- R46: lease creation stores exactly generateSchedule's invoices, and a tiny last rent period can
  -- round to 0 sen; a deposit invoice exists only when the deposit is > 0.
  amount_sen bigint not null check (amount_sen > 0 or (kind = 'rent' and amount_sen = 0)),
  currency char(3) not null default 'MYR' check (currency = 'MYR'),
  created_at timestamptz not null default now(),
  -- R12/R14: deposit has no period; a rent invoice has one, due on its anchor (period start).
  check (
    (kind = 'deposit' and period_index is null and period_start is null and period_end is null)
    or (kind = 'rent' and period_index is not null and period_start is not null and period_end is not null
        and period_index >= 0 and period_end >= period_start and due_date = period_start)
  ),
  foreign key (org_id, lease_id) references public.leases (org_id, id) on delete restrict,
  -- R12/R16: deposit rows have period_index null, so NULLS NOT DISTINCT = at most one deposit per lease
  -- and one rent invoice per period index (a partial unique on lease_id would make Prisma model lease 1:1).
  constraint invoices_lease_period_index_key unique nulls not distinct (lease_id, period_index),
  unique (org_id, lease_id, period_start), -- kit rule: invoice generation idempotent per period
  unique (org_id, id),
  unique (lease_id, id) -- target for payment_allocations: invoice and payment on the same lease
);
create index invoices_org_lease_idx on public.invoices (org_id, lease_id);

create table public.gateway_bills (
  -- R30: gen_random_uuid() = 122 random bits, so bill ids cannot be guessed.
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  lease_id uuid not null,
  amount_sen bigint not null check (amount_sen > 0),
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed')),
  currency char(3) not null default 'MYR' check (currency = 'MYR'),
  created_by uuid null,
  transaction_id text null,
  transaction_status text null,
  paid_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'paid' or paid_at is not null),
  foreign key (org_id, lease_id) references public.leases (org_id, id) on delete restrict,
  unique (org_id, id),
  unique (lease_id, id)
);
create index gateway_bills_org_lease_idx on public.gateway_bills (org_id, lease_id);
create index gateway_bills_lease_id_idx on public.gateway_bills (lease_id);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  lease_id uuid not null,
  amount_sen bigint not null check (amount_sen > 0),
  unapplied_sen bigint not null default 0,
  method text not null check (method in ('cash', 'bank_transfer', 'online')),
  status text not null check (status in ('pending_verification', 'approved', 'rejected', 'voided')),
  received_at timestamptz not null,
  slip_path text null unique, -- D22: one slip file backs at most one payment
  gateway_bill_id uuid null unique, -- D10: "A bill creates at most one payment, ever." (R35)
  idempotency_key uuid null, -- D9: optional Idempotency-Key header
  currency char(3) not null default 'MYR' check (currency = 'MYR'),
  recorded_by uuid null,
  decided_by uuid null,
  decided_at timestamptz null,
  reason text null,
  created_at timestamptz not null default now(),
  check (unapplied_sen >= 0 and unapplied_sen <= amount_sen),
  -- R26: only online money can be left unapplied (manual payments are capped, R22/R23).
  check (method = 'online' or unapplied_sen = 0),
  check ((method = 'bank_transfer') = (slip_path is not null)), -- R20
  check ((method = 'online') = (gateway_bill_id is not null)),
  -- D22/R44: a slip lives in its own organization's folder <org_id>/...
  check (slip_path is null or split_part(slip_path, '/', 1) = org_id::text),
  -- R24: reject and void need a reason of at least 5 characters; coalesce because a NULL reason
  -- would make the CHECK evaluate to NULL, which passes.
  check (status not in ('rejected', 'voided') or coalesce(char_length(btrim(reason)), 0) >= 5),
  foreign key (org_id, lease_id) references public.leases (org_id, id) on delete restrict,
  foreign key (org_id, gateway_bill_id) references public.gateway_bills (org_id, id) on delete restrict,
  foreign key (lease_id, gateway_bill_id) references public.gateway_bills (lease_id, id) on delete restrict,
  -- gateway_bill_id is already unique; these two composite uniques are the exact FK column sets so the
  -- relations introspect as 1:1 in Prisma, and they double as the FK indexes.
  unique (org_id, gateway_bill_id),
  unique (lease_id, gateway_bill_id),
  unique (org_id, idempotency_key),
  unique (org_id, id),
  unique (lease_id, id)
);
create index payments_org_lease_idx on public.payments (org_id, lease_id);
create index payments_lease_status_idx on public.payments (lease_id, status);

create table public.payment_allocations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  lease_id uuid not null,
  payment_id uuid not null,
  invoice_id uuid not null,
  amount_sen bigint not null check (amount_sen > 0),
  created_at timestamptz not null default now(),
  -- lease_id in both FKs makes "payment and invoice belong to the same lease" a DB fact.
  foreign key (lease_id, payment_id) references public.payments (lease_id, id) on delete restrict,
  foreign key (lease_id, invoice_id) references public.invoices (lease_id, id) on delete restrict,
  foreign key (org_id, lease_id) references public.leases (org_id, id) on delete restrict,
  unique (payment_id, invoice_id)
);
create index payment_allocations_lease_payment_idx on public.payment_allocations (lease_id, payment_id);
create index payment_allocations_lease_invoice_idx on public.payment_allocations (lease_id, invoice_id);
create index payment_allocations_org_lease_idx on public.payment_allocations (org_id, lease_id);
create index payment_allocations_invoice_id_idx on public.payment_allocations (invoice_id);

create table public.audit_log (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations (id),
  actor_id uuid null,
  action text not null,
  entity_id uuid null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_org_created_idx on public.audit_log (org_id, created_at);

-- ---------------------------------------------------------------------------
-- 2. Guard triggers (schema private)
-- ---------------------------------------------------------------------------
-- D19/R43: audit_log is append-only for every role, owner and service_role included.
create function private.audit_log_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'P0409', message = 'audit_log is append-only';
end $$;

create trigger audit_log_no_update_delete before update or delete on public.audit_log
  for each row execute function private.audit_log_append_only();
create trigger audit_log_no_truncate before truncate on public.audit_log
  for each statement execute function private.audit_log_append_only();
-- D19: ALWAYS = still fires under session_replication_role = replica.
alter table public.audit_log enable always trigger audit_log_no_update_delete;
alter table public.audit_log enable always trigger audit_log_no_truncate;

-- D12: payments are never deleted; only the decision columns change, along fixed status transitions.
create function private.payments_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op <> 'UPDATE' then
    raise exception using errcode = 'P0409', message = 'Payments are never deleted';
  end if;
  -- D12: compare the whole row minus the mutable keys, so any future column is immutable by default.
  if (to_jsonb(new) - array['status', 'decided_by', 'decided_at', 'reason', 'unapplied_sen'])
     is distinct from (to_jsonb(old) - array['status', 'decided_by', 'decided_at', 'reason', 'unapplied_sen']) then
    raise exception using errcode = 'P0409', message = 'Payment facts are immutable';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'pending_verification' and new.status in ('approved', 'rejected'))
       or (old.status = 'approved' and new.status = 'voided')) then
    raise exception using errcode = 'P0409', message = 'Payment status cannot change that way';
  end if;
  return new;
end $$;

create trigger payments_guard_row before update or delete on public.payments
  for each row execute function private.payments_guard();
create trigger payments_guard_truncate before truncate on public.payments
  for each statement execute function private.payments_guard();
alter table public.payments enable always trigger payments_guard_row;
alter table public.payments enable always trigger payments_guard_truncate;

-- Allocations are deleted by void (R24) but never edited in place.
create function private.payment_allocations_no_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'P0409', message = 'Allocations cannot be updated';
end $$;

create trigger payment_allocations_no_update before update on public.payment_allocations
  for each row execute function private.payment_allocations_no_update();

-- Generic guard: the columns named in the trigger arguments never change after insert.
create function private.forbid_column_changes() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_col text;
begin
  foreach v_col in array tg_argv loop
    if (to_jsonb(new) -> v_col) is distinct from (to_jsonb(old) -> v_col) then
      raise exception using errcode = 'P0409', message = format('%s.%s is immutable', tg_table_name, v_col);
    end if;
  end loop;
  return new;
end $$;

-- Lease terms and invoice amounts/dates are facts fixed at creation (R46: exactly generateSchedule's invoices).
create trigger leases_immutable before update on public.leases
  for each row execute function private.forbid_column_changes(
    'id', 'org_id', 'unit_id', 'tenant_id', 'start_date', 'end_date', 'monthly_rent_sen', 'deposit_sen', 'currency');
create trigger invoices_immutable before update on public.invoices
  for each row execute function private.forbid_column_changes(
    'id', 'org_id', 'lease_id', 'kind', 'period_index', 'period_start', 'period_end', 'due_date', 'amount_sen', 'currency');

-- R34: a bill's amount and lease never change and its status only moves forward ("a paid bill never goes back").
create function private.gateway_bills_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op <> 'UPDATE' then
    raise exception using errcode = 'P0409', message = 'Gateway bills are never deleted';
  end if;
  if (new.id, new.org_id, new.lease_id, new.amount_sen, new.currency, new.created_by, new.created_at)
     is distinct from (old.id, old.org_id, old.lease_id, old.amount_sen, old.currency, old.created_by, old.created_at) then
    raise exception using errcode = 'P0409', message = 'Gateway bill facts are immutable';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'pending' and new.status in ('paid', 'failed'))
       or (old.status = 'failed' and new.status = 'paid')) then
    raise exception using errcode = 'P0409', message = 'Gateway bill status cannot go back';
  end if;
  -- R34: a paid bill never goes back, so its payment facts are frozen too.
  if old.status = 'paid'
     and (new.paid_at, new.transaction_id, new.transaction_status)
         is distinct from (old.paid_at, old.transaction_id, old.transaction_status) then
    raise exception using errcode = 'P0409', message = 'A paid gateway bill cannot change';
  end if;
  return new;
end $$;

create trigger gateway_bills_guard_row before update or delete on public.gateway_bills
  for each row execute function private.gateway_bills_guard();
create trigger gateway_bills_guard_truncate before truncate on public.gateway_bills
  for each statement execute function private.gateway_bills_guard();
-- D19: ALWAYS = still fires under session_replication_role = replica.
alter table public.gateway_bills enable always trigger gateway_bills_guard_row;
alter table public.gateway_bills enable always trigger gateway_bills_guard_truncate;

-- ---------------------------------------------------------------------------
-- 3. RLS helpers (SECURITY DEFINER so policies never recurse through RLS; search_path '' against hijacking)
-- ---------------------------------------------------------------------------
create function private.is_org_member(p_org uuid, p_roles text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = p_org and m.user_id = (select auth.uid()) and m.role = any (p_roles)
  )
$$;

create function private.is_lease_tenant(p_lease uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.leases l
    join public.tenants t on t.org_id = l.org_id and t.id = l.tenant_id
    where l.id = p_lease and t.user_id = (select auth.uid())
  )
$$;

create function private.is_tenant_org(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.tenants t where t.org_id = p_org and t.user_id = (select auth.uid())
  )
$$;

-- D22/R44: first folder of the object path must be an org where the caller is manager or staff.
-- Compared as text so a garbage folder name returns false instead of raising a uuid cast error.
create function private.can_upload_slip(p_object_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.user_id = (select auth.uid())
      and m.role in ('manager', 'staff')
      and m.org_id::text = (storage.foldername(p_object_name))[1]
  )
$$;

-- ---------------------------------------------------------------------------
-- 4. Row level security (R42 Data API matrix). SELECT only, plus tenant phone update.
-- ---------------------------------------------------------------------------
alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.units enable row level security;
alter table public.tenants enable row level security;
alter table public.leases enable row level security;
alter table public.invoices enable row level security;
alter table public.gateway_bills enable row level security;
alter table public.payments enable row level security;
alter table public.payment_allocations enable row level security;
alter table public.audit_log enable row level security;

create policy organizations_select on public.organizations for select to authenticated
  using (private.is_org_member(id, array['manager', 'staff']) or private.is_tenant_org(id));

create policy memberships_select on public.memberships for select to authenticated
  using (private.is_org_member(org_id, array['manager', 'staff']));

create policy units_select on public.units for select to authenticated
  using (
    private.is_org_member(org_id, array['manager', 'staff'])
    or exists (
      select 1 from public.leases l
      where l.org_id = units.org_id and l.unit_id = units.id and private.is_lease_tenant(l.id)
    )
  );

create policy tenants_select on public.tenants for select to authenticated
  using (private.is_org_member(org_id, array['manager', 'staff']) or user_id = (select auth.uid()));

-- R42: tenant updates only their own phone (column grant below limits the columns; WITH CHECK keeps the row theirs).
create policy tenants_update_own_phone on public.tenants for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy leases_select on public.leases for select to authenticated
  using (private.is_org_member(org_id, array['manager', 'staff']) or private.is_lease_tenant(id));

create policy invoices_select on public.invoices for select to authenticated
  using (private.is_org_member(org_id, array['manager', 'staff']) or private.is_lease_tenant(lease_id));

create policy gateway_bills_select on public.gateway_bills for select to authenticated
  using (private.is_org_member(org_id, array['manager', 'staff']) or private.is_lease_tenant(lease_id));

create policy payments_select on public.payments for select to authenticated
  using (private.is_org_member(org_id, array['manager', 'staff']) or private.is_lease_tenant(lease_id));

create policy payment_allocations_select on public.payment_allocations for select to authenticated
  using (private.is_org_member(org_id, array['manager', 'staff']) or private.is_lease_tenant(lease_id));

create policy audit_log_select on public.audit_log for select to authenticated
  using (private.is_org_member(org_id, array['manager']));

-- ---------------------------------------------------------------------------
-- 5. Grants (after every object exists)
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;

grant select on public.organizations, public.memberships, public.units, public.tenants, public.leases,
  public.invoices, public.gateway_bills, public.payments, public.payment_allocations, public.audit_log
  to authenticated;
grant update (phone) on public.tenants to authenticated;

-- Policies (and Storage's RLS) call these helpers as the authenticated role; nothing else in private is callable.
grant usage on schema private to authenticated;
grant execute on function private.is_org_member(uuid, text[]) to authenticated;
grant execute on function private.is_lease_tenant(uuid) to authenticated;
grant execute on function private.is_tenant_org(uuid) to authenticated;
grant execute on function private.can_upload_slip(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Storage: private slip bucket + object policies (R20, R44, D22)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('payment-slips', 'payment-slips', false, 5242880, '{image/jpeg,image/png,application/pdf}')
on conflict (id) do nothing;

-- Staff/manager of the org in the first folder may upload and read; no update/delete/list for anyone else.
create policy payment_slips_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'payment-slips' and private.can_upload_slip(name));

create policy payment_slips_select on storage.objects for select to authenticated
  using (bucket_id = 'payment-slips' and private.can_upload_slip(name));
