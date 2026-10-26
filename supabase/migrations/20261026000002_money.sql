-- T4: money functions (R19-R30, R34, R35). Every money write is one plpgsql function in schema
-- private, called by server code through Prisma as the owner (D8). None is reachable through
-- PostgREST: private is not an exposed schema and execute is revoked from public/anon/authenticated.
-- Errors use fixed SQLSTATEs (P0400 validation, P0404 not found, P0409 conflict, P0422 business
-- rule); the message becomes the API body { "error": message }, so it never names another org's data.

-- ---------------------------------------------------------------------------------------------
-- allocate_payment: fill the lease's unpaid invoices with this payment (R26). Caller holds the
-- lease lock (D7), so the unpaid amounts read here cannot change underneath us.
-- ---------------------------------------------------------------------------------------------
create or replace function private.allocate_payment(p_payment_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_pay record;
  v_remaining bigint;
  v_inv record;
  v_take bigint;
begin
  select p.id, p.org_id, p.lease_id, p.amount_sen, p.unapplied_sen, p.status
    into v_pay
    from public.payments p
   where p.id = p_payment_id;
  if not found then
    raise exception using errcode = 'P0404', message = 'Payment not found';
  end if;
  if v_pay.status <> 'approved' then
    raise exception using errcode = 'P0409', message = 'Payment is not approved';
  end if;

  -- R28: only the not-yet-allocated part is distributed, so a second call allocates nothing
  -- (a payment approved twice is allocated once, even if a caller slipped past the status check).
  select v_pay.amount_sen - coalesce(sum(a.amount_sen), 0)
    into v_remaining
    from public.payment_allocations a
   where a.payment_id = p_payment_id;

  if v_remaining <= 0 then
    return;
  end if;

  -- R26: due date, then deposit before rent (false sorts first), then period index; id breaks ties
  -- deterministically. Not-yet-due invoices are included (advance payments).
  for v_inv in
    select i.id,
           i.amount_sen - coalesce((select sum(a.amount_sen)
                                      from public.payment_allocations a
                                     where a.invoice_id = i.id), 0) as unpaid
      from public.invoices i
     where i.lease_id = v_pay.lease_id
     order by i.due_date, (i.kind = 'rent'), i.period_index nulls first, i.id
  loop
    exit when v_remaining <= 0;
    -- R46: skips fully paid invoices and 0-sen rent invoices, so no allocation row is ever 0 sen.
    continue when v_inv.unpaid <= 0;
    v_take := least(v_inv.unpaid, v_remaining);
    insert into public.payment_allocations (org_id, lease_id, payment_id, invoice_id, amount_sen)
    values (v_pay.org_id, v_pay.lease_id, v_pay.id, v_inv.id, v_take);
    v_remaining := v_remaining - v_take;
  end loop;

  -- R26: leftover after every invoice is full stays on the payment. Manual payments are capped,
  -- so for them this is 0 and the row is not touched (keeps the D12 status trigger out of it).
  if v_remaining <> v_pay.unapplied_sen then
    update public.payments p
       set unapplied_sen = v_remaining
     where p.id = p_payment_id;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- record_payment (R19-R22, D9): manual cash / bank transfer payment.
-- ---------------------------------------------------------------------------------------------
create or replace function private.record_payment(
  p_actor_id uuid,
  p_lease_id uuid,
  p_amount_sen bigint,
  p_method text,
  p_received_at timestamptz,
  p_slip_path text,
  p_idempotency_key uuid
)
returns table(id uuid, status text, replayed boolean)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_lease record;
  v_role text;
  v_existing record;
  v_status text;
  v_cap bigint;
  v_id uuid;
begin
  -- D7: the cap is computed after the lease lock; READ COMMITTED gives each statement a fresh snapshot after the wait
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode = 'P0409', message = 'Unsupported isolation level';
  end if;

  -- D7: lease lock first; concurrent recordings on one lease queue here, so the cap below is
  -- computed against everything committed before us (R28).
  select l.id, l.org_id
    into v_lease
    from public.leases l
   where l.id = p_lease_id
     for update;
  if not found then
    raise exception using errcode = 'P0404', message = 'Lease not found';
  end if;

  select m.role
    into v_role
    from public.memberships m
   where m.user_id = p_actor_id
     and m.org_id = v_lease.org_id
     and m.role in ('manager', 'staff');
  if v_role is null then
    -- R38/D15: same message as a missing lease, never reveal that it exists in another org.
    raise exception using errcode = 'P0404', message = 'Lease not found';
  end if;

  -- D9: replay check before validation, so a retry of an accepted request returns the original
  -- even if the payment has since been approved/rejected/voided or the cap is now used up.
  if p_idempotency_key is not null then
    select p.id, p.status, p.lease_id, p.amount_sen, p.method, p.received_at, p.slip_path
      into v_existing
      from public.payments p
     where p.org_id = v_lease.org_id
       and p.idempotency_key = p_idempotency_key;
    if found then
      if v_existing.lease_id = p_lease_id
         and v_existing.amount_sen = p_amount_sen
         and v_existing.method = p_method
         and v_existing.received_at = p_received_at
         and v_existing.slip_path is not distinct from p_slip_path then
        return query select v_existing.id, v_existing.status, true;
        return;
      end if;
      raise exception using errcode = 'P0409', message = 'Idempotency key reused with a different payload';
    end if;
  end if;

  if p_method is null or p_method not in ('cash', 'bank_transfer') then
    raise exception using errcode = 'P0400', message = 'Invalid payment method';
  end if;
  if p_amount_sen is null or p_amount_sen <= 0 then
    raise exception using errcode = 'P0400', message = 'Amount must be a positive number of sen';
  end if;
  if p_received_at is null then
    raise exception using errcode = 'P0400', message = 'Received time is required';
  end if;
  if p_method = 'cash' and p_slip_path is not null then
    raise exception using errcode = 'P0400', message = 'A cash payment cannot have a slip';
  end if;
  if p_method = 'bank_transfer' then
    -- R44/D22: the slip must be an uploaded object in this lease's org folder; a path in another
    -- org's folder gets the same message as a missing file.
    if p_slip_path is null
       or not exists (select 1
                        from storage.objects o
                       where o.bucket_id = 'payment-slips'
                         and o.name = p_slip_path
                         and split_part(o.name, '/', 1) = v_lease.org_id::text
                         and o.name like v_lease.org_id::text || '/%') then
      raise exception using errcode = 'P0400', message = 'Slip file not found';
    end if;
    -- D22: a slip already backing another payment is invalid input (400), not a state conflict.
    if exists (select 1 from public.payments p where p.slip_path = p_slip_path) then
      raise exception using errcode = 'P0400', message = 'Slip already used';
    end if;
  end if;

  -- R22/D13: cap = all invoices - all allocations - pending payments of this lease, read after
  -- the lock. Voided payments have no allocations left, rejected ones are not pending.
  select (select coalesce(sum(i.amount_sen), 0) from public.invoices i where i.lease_id = p_lease_id)
       - (select coalesce(sum(a.amount_sen), 0) from public.payment_allocations a where a.lease_id = p_lease_id)
       - (select coalesce(sum(p.amount_sen), 0) from public.payments p
           where p.lease_id = p_lease_id and p.status = 'pending_verification')
    into v_cap;
  if p_amount_sen > v_cap then
    raise exception using errcode = 'P0422', message = 'Payment exceeds the remaining balance';
  end if;

  -- R21: manager-recorded payments are approved immediately, staff ones wait for a manager.
  v_status := case when v_role = 'manager' then 'approved' else 'pending_verification' end;

  -- D9: ON CONFLICT DO NOTHING + re-select turns a race on (org_id, idempotency_key) or slip_path
  -- (another lease of the org, not serialized by our lease lock) into a replay / 409, never a 500.
  insert into public.payments as p
         (org_id, lease_id, amount_sen, method, status, received_at, slip_path,
          idempotency_key, recorded_by, decided_by, decided_at)
  values (v_lease.org_id, p_lease_id, p_amount_sen, p_method, v_status, p_received_at, p_slip_path,
          p_idempotency_key, p_actor_id,
          case when v_status = 'approved' then p_actor_id end,
          case when v_status = 'approved' then now() end)
  on conflict do nothing
  returning p.id into v_id;

  if v_id is null then
    if p_idempotency_key is not null then
      select p.id, p.status, p.lease_id, p.amount_sen, p.method, p.received_at, p.slip_path
        into v_existing
        from public.payments p
       where p.org_id = v_lease.org_id
         and p.idempotency_key = p_idempotency_key;
      if found then
        if v_existing.lease_id = p_lease_id
           and v_existing.amount_sen = p_amount_sen
           and v_existing.method = p_method
           and v_existing.received_at = p_received_at
           and v_existing.slip_path is not distinct from p_slip_path then
          return query select v_existing.id, v_existing.status, true;
          return;
        end if;
        raise exception using errcode = 'P0409', message = 'Idempotency key reused with a different payload';
      end if;
    end if;
    -- D22: the only other unique a manual payment can hit is slip_path (same answer as the pre-check).
    raise exception using errcode = 'P0400', message = 'Slip already used';
  end if;

  insert into public.audit_log (org_id, actor_id, action, entity_id, details)
  values (v_lease.org_id, p_actor_id, 'payment.recorded', v_id,
          jsonb_build_object('lease_id', p_lease_id, 'amount_sen', p_amount_sen,
                             'method', p_method, 'status', v_status, 'received_at', p_received_at));

  if v_status = 'approved' then
    perform private.allocate_payment(v_id);
    insert into public.audit_log (org_id, actor_id, action, entity_id, details)
    values (v_lease.org_id, p_actor_id, 'payment.approved', v_id,
            jsonb_build_object('lease_id', p_lease_id, 'amount_sen', p_amount_sen,
                               'allocated_sen', (select coalesce(sum(a.amount_sen), 0)
                                                   from public.payment_allocations a
                                                  where a.payment_id = v_id)));
  end if;

  return query select v_id, v_status, false;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Shared lock step for approve / reject / void (D7): read the payment's lease without a lock
-- (lease_id is immutable), lock the lease, then lock the payment and return it fresh.
-- ---------------------------------------------------------------------------------------------
create or replace function private.lock_payment_for_manager(p_actor_id uuid, p_payment_id uuid)
returns public.payments
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_lease_id uuid;
  v_org_id uuid;
  v_pay public.payments;
begin
  -- D7: the cap is computed after the lease lock; READ COMMITTED gives each statement a fresh snapshot after the wait
  -- (approve/reject/void call this helper first, so the guard covers all three).
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode = 'P0409', message = 'Unsupported isolation level';
  end if;

  select p.lease_id, p.org_id into v_lease_id, v_org_id
    from public.payments p
   where p.id = p_payment_id;
  if not found then
    raise exception using errcode = 'P0404', message = 'Payment not found';
  end if;

  -- D7: always lease before payment, the same order as record_payment, so no deadlock.
  perform 1 from public.leases l where l.id = v_lease_id for update;

  -- R1/R38: only a manager of the payment's org; anyone else gets the not-found message
  -- (the service already answered 403 for staff of the same org before calling us).
  if not exists (select 1 from public.memberships m
                  where m.user_id = p_actor_id and m.org_id = v_org_id and m.role = 'manager') then
    raise exception using errcode = 'P0404', message = 'Payment not found';
  end if;

  -- R28: re-read under the lock; a concurrent approve that committed first is visible now.
  select p.* into v_pay from public.payments p where p.id = p_payment_id for update;
  return v_pay;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- approve_payment (R23, R26, R28)
-- ---------------------------------------------------------------------------------------------
create or replace function private.approve_payment(p_actor_id uuid, p_payment_id uuid)
returns table(status text)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_pay public.payments;
  v_remaining bigint;
begin
  v_pay := private.lock_payment_for_manager(p_actor_id, p_payment_id);

  if v_pay.status <> 'pending_verification' then
    raise exception using errcode = 'P0409', message = 'Payment is not pending';
  end if;

  -- R23/D13: re-check against invoices - allocations at this moment (pending ones ignored);
  -- over it -> refuse and leave the payment pending (the exception rolls back nothing else).
  select (select coalesce(sum(i.amount_sen), 0) from public.invoices i where i.lease_id = v_pay.lease_id)
       - (select coalesce(sum(a.amount_sen), 0) from public.payment_allocations a where a.lease_id = v_pay.lease_id)
    into v_remaining;
  if v_pay.amount_sen > v_remaining then
    raise exception using errcode = 'P0422', message = 'Payment exceeds the remaining balance';
  end if;

  update public.payments p
     set status = 'approved', decided_by = p_actor_id, decided_at = now()
   where p.id = p_payment_id;

  perform private.allocate_payment(p_payment_id);

  insert into public.audit_log (org_id, actor_id, action, entity_id, details)
  values (v_pay.org_id, p_actor_id, 'payment.approved', p_payment_id,
          jsonb_build_object('lease_id', v_pay.lease_id, 'amount_sen', v_pay.amount_sen,
                             'allocated_sen', (select coalesce(sum(a.amount_sen), 0)
                                                 from public.payment_allocations a
                                                where a.payment_id = p_payment_id)));

  return query select 'approved'::text;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- reject_payment (R24)
-- ---------------------------------------------------------------------------------------------
create or replace function private.reject_payment(p_actor_id uuid, p_payment_id uuid, p_reason text)
returns table(status text)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_pay public.payments;
begin
  -- Error contract order: not found (404) before validation (400) before state (409).
  v_pay := private.lock_payment_for_manager(p_actor_id, p_payment_id);

  if p_reason is null or length(btrim(p_reason)) < 5 then
    raise exception using errcode = 'P0400', message = 'Reason must be at least 5 characters';
  end if;
  if v_pay.status <> 'pending_verification' then
    raise exception using errcode = 'P0409', message = 'Payment is not pending';
  end if;

  update public.payments p
     set status = 'rejected', reason = btrim(p_reason), decided_by = p_actor_id, decided_at = now()
   where p.id = p_payment_id;

  insert into public.audit_log (org_id, actor_id, action, entity_id, details)
  values (v_pay.org_id, p_actor_id, 'payment.rejected', p_payment_id,
          jsonb_build_object('lease_id', v_pay.lease_id, 'amount_sen', v_pay.amount_sen,
                             'reason', btrim(p_reason)));

  return query select 'rejected'::text;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- void_payment (R24, D14): removes only this payment's allocations; other payments untouched.
-- ---------------------------------------------------------------------------------------------
create or replace function private.void_payment(p_actor_id uuid, p_payment_id uuid, p_reason text)
returns table(status text)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_pay public.payments;
  v_released bigint;
begin
  v_pay := private.lock_payment_for_manager(p_actor_id, p_payment_id);

  if p_reason is null or length(btrim(p_reason)) < 5 then
    raise exception using errcode = 'P0400', message = 'Reason must be at least 5 characters';
  end if;
  if v_pay.status <> 'approved' then
    raise exception using errcode = 'P0409', message = 'Payment is not approved';
  end if;

  with d as (
    delete from public.payment_allocations a where a.payment_id = p_payment_id returning a.amount_sen
  )
  select coalesce(sum(d.amount_sen), 0) into v_released from d;

  -- D14: unapplied_sen of other payments is NOT re-applied to the reopened invoices.
  -- decided_by/decided_at keep the approver; the voider is recorded in audit_log.
  update public.payments p
     set status = 'voided', reason = btrim(p_reason)
   where p.id = p_payment_id;

  insert into public.audit_log (org_id, actor_id, action, entity_id, details)
  values (v_pay.org_id, p_actor_id, 'payment.voided', p_payment_id,
          jsonb_build_object('lease_id', v_pay.lease_id, 'amount_sen', v_pay.amount_sen,
                             'released_sen', v_released, 'reason', btrim(p_reason)));

  return query select 'voided'::text;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- create_gateway_bill (R30, D5): bill for what is due on or before today's Malaysia date.
-- ---------------------------------------------------------------------------------------------
create or replace function private.create_gateway_bill(
  p_actor_id uuid,
  p_lease_id uuid,
  p_as_of timestamptz default now()
)
returns table(id uuid, amount_sen bigint)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_lease record;
  v_today date;
  v_due bigint;
  v_id uuid;
begin
  -- D7: the cap is computed after the lease lock; READ COMMITTED gives each statement a fresh snapshot after the wait
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode = 'P0409', message = 'Unsupported isolation level';
  end if;

  -- D7: lease lock so the due amount is computed against committed allocations.
  select l.id, l.org_id, l.tenant_id
    into v_lease
    from public.leases l
   where l.id = p_lease_id
     for update;
  if not found then
    raise exception using errcode = 'P0404', message = 'Lease not found';
  end if;

  -- R1/R37: only the lease's own tenant (tenants.user_id), never another tenant or org.
  if not exists (select 1 from public.tenants t
                  where t.id = v_lease.tenant_id
                    and t.org_id = v_lease.org_id
                    and t.user_id = p_actor_id) then
    raise exception using errcode = 'P0404', message = 'Lease not found';
  end if;

  -- D5: "today" is the Malaysia calendar date of p_as_of, never the server's zone.
  v_today := (p_as_of at time zone 'Asia/Kuala_Lumpur')::date;

  -- R30/D13: unpaid amounts of invoices due on or before today; pending manual payments ignored.
  select coalesce(sum(greatest(i.amount_sen - coalesce((select sum(a.amount_sen)
                                                          from public.payment_allocations a
                                                         where a.invoice_id = i.id), 0), 0)), 0)
    into v_due
    from public.invoices i
   where i.lease_id = p_lease_id
     and i.due_date <= v_today;

  if v_due <= 0 then
    raise exception using errcode = 'P0422', message = 'Nothing is due';
  end if;

  -- R30: bill id = gen_random_uuid() column default (122 random bits, not guessable).
  insert into public.gateway_bills as b (org_id, lease_id, amount_sen, status, created_by)
  values (v_lease.org_id, p_lease_id, v_due, 'pending', p_actor_id)
  returning b.id into v_id;

  insert into public.audit_log (org_id, actor_id, action, entity_id, details)
  values (v_lease.org_id, p_actor_id, 'gateway_bill.created', v_id,
          jsonb_build_object('lease_id', p_lease_id, 'amount_sen', v_due, 'as_of_date', v_today));

  return query select v_id, v_due;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- apply_gateway_callback (R34, R35, D10, D11): the bill state machine.
-- ---------------------------------------------------------------------------------------------
create or replace function private.apply_gateway_callback(
  p_bill_id uuid,
  p_paid boolean,
  p_paid_amount_sen bigint,
  p_paid_at timestamptz,
  p_transaction_id text,
  p_transaction_status text
)
returns table(outcome text, payment_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_bill record;
  v_payment_id uuid;
begin
  -- D7: the cap is computed after the lease lock; READ COMMITTED gives each statement a fresh snapshot after the wait
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode = 'P0409', message = 'Unsupported isolation level';
  end if;

  -- D7/D10: bill lock first; simultaneous deliveries of one callback queue here, and the second
  -- one sees status = 'paid' and returns 'duplicate' (R35: at most one payment per bill).
  select b.id, b.org_id, b.lease_id, b.amount_sen, b.status
    into v_bill
    from public.gateway_bills b
   where b.id = p_bill_id
     for update;
  if not found then
    raise exception using errcode = 'P0404', message = 'Unknown bill';
  end if;

  if p_paid is null then
    raise exception using errcode = 'P0400', message = 'paid is required';
  end if;

  -- D11/R34: amount is compared with the bill's stored amount, whatever the bill's state.
  if p_paid and p_paid_amount_sen is distinct from v_bill.amount_sen then
    raise exception using errcode = 'P0422', message = 'Paid amount does not match the bill';
  end if;

  if p_paid then
    if v_bill.status = 'paid' then
      select p.id into v_payment_id from public.payments p where p.gateway_bill_id = p_bill_id;
      return query select 'duplicate'::text, v_payment_id;
      return;
    end if;
    if p_paid_at is null then
      raise exception using errcode = 'P0400', message = 'paid_at is required';
    end if;

    -- D7: bill -> lease, the only path that takes a bill lock, so the order is never inverted.
    perform 1 from public.leases l where l.id = v_bill.lease_id for update;

    update public.gateway_bills b
       set status = 'paid', paid_at = p_paid_at, transaction_id = p_transaction_id,
           transaction_status = p_transaction_status, updated_at = now()
     where b.id = p_bill_id;

    -- R35: UNIQUE (gateway_bill_id) backs up the lock; on conflict we return the existing one.
    insert into public.payments as p
           (org_id, lease_id, amount_sen, method, status, received_at, gateway_bill_id, decided_at)
    values (v_bill.org_id, v_bill.lease_id, v_bill.amount_sen, 'online', 'approved', p_paid_at,
            p_bill_id, now())
    on conflict do nothing
    returning p.id into v_payment_id;

    if v_payment_id is null then
      select p.id into v_payment_id from public.payments p where p.gateway_bill_id = p_bill_id;
      return query select 'duplicate'::text, v_payment_id;
      return;
    end if;

    -- R26: allocate like any approval; what the invoices cannot absorb becomes unapplied_sen
    -- (captured money is never refused).
    perform private.allocate_payment(v_payment_id);

    insert into public.audit_log (org_id, actor_id, action, entity_id, details)
    values (v_bill.org_id, null, 'gateway_bill.paid', p_bill_id,
            jsonb_build_object('lease_id', v_bill.lease_id, 'payment_id', v_payment_id,
                               'amount_sen', v_bill.amount_sen, 'transaction_id', p_transaction_id,
                               'transaction_status', p_transaction_status, 'paid_at', p_paid_at));

    -- R25: every approval is audited; a gateway payment is approved by the system (actor null).
    insert into public.audit_log (org_id, actor_id, action, entity_id, details)
    values (v_bill.org_id, null, 'payment.approved', v_payment_id,
            jsonb_build_object('source', 'gateway', 'bill_id', p_bill_id));

    return query select 'paid'::text, v_payment_id;
    return;
  end if;

  -- paid = false: only a pending bill moves (to failed); failed stays failed, paid never goes back.
  if v_bill.status = 'pending' then
    update public.gateway_bills b
       set status = 'failed', transaction_id = p_transaction_id,
           transaction_status = p_transaction_status, updated_at = now()
     where b.id = p_bill_id;

    insert into public.audit_log (org_id, actor_id, action, entity_id, details)
    values (v_bill.org_id, null, 'gateway_bill.failed', p_bill_id,
            jsonb_build_object('lease_id', v_bill.lease_id, 'transaction_id', p_transaction_id,
                               'transaction_status', p_transaction_status));

    return query select 'failed'::text, null::uuid;
    return;
  end if;

  return query select 'ignored'::text, null::uuid;
end;
$$;

-- D8: owner-only. Not callable by anon/authenticated even if the private schema were exposed.
revoke execute on function private.allocate_payment(uuid) from public, anon, authenticated;
revoke execute on function private.record_payment(uuid, uuid, bigint, text, timestamptz, text, uuid) from public, anon, authenticated;
revoke execute on function private.lock_payment_for_manager(uuid, uuid) from public, anon, authenticated;
revoke execute on function private.approve_payment(uuid, uuid) from public, anon, authenticated;
revoke execute on function private.reject_payment(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function private.void_payment(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function private.create_gateway_bill(uuid, uuid, timestamptz) from public, anon, authenticated;
revoke execute on function private.apply_gateway_callback(uuid, boolean, bigint, timestamptz, text, text) from public, anon, authenticated;
