-- T4 smoke test for the private money functions. Runs in one transaction that ROLLS BACK.
-- Usage (from ./app): bash ../scripts/with-db.sh psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -v ON_ERROR_STOP=1 -f supabase/tests/money_smoke.sql
-- Every expectation that fails raises 'FAIL ...', which stops psql with a non-zero exit.
\set ON_ERROR_STOP 1
begin;

create temp table smoke_ids (k text primary key, v uuid) on commit drop;

do $$
declare
  c_org  uuid := 'a0000000-0000-4000-8000-000000000001';
  c_org2 uuid := 'a0000000-0000-4000-8000-000000000002';
  c_mgr  uuid := 'b0000000-0000-4000-8000-000000000001';
  c_stf  uuid := 'b0000000-0000-4000-8000-000000000002';
  c_tusr uuid := 'b0000000-0000-4000-8000-000000000003';
  c_mgr2 uuid := 'b0000000-0000-4000-8000-000000000004';
  c_unit uuid := 'c0000000-0000-4000-8000-000000000001';
  c_ten  uuid := 'd0000000-0000-4000-8000-000000000001';
  c_lease uuid := 'e0000000-0000-4000-8000-000000000001';
  u uuid;
begin
  foreach u in array array[c_mgr, c_stf, c_tusr, c_mgr2] loop
    insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
    values ('00000000-0000-0000-0000-000000000000', u, 'authenticated', 'authenticated',
            u::text || '@smoke.test', now(), now());
  end loop;

  insert into public.organizations (id, name) values (c_org, 'Smoke Org'), (c_org2, 'Other Org');
  insert into public.memberships (user_id, org_id, role)
  values (c_mgr, c_org, 'manager'), (c_stf, c_org, 'staff'), (c_mgr2, c_org2, 'manager');
  insert into public.units (id, org_id, name) values (c_unit, c_org, 'S-1');
  insert into public.tenants (id, org_id, user_id, full_name, email)
  values (c_ten, c_org, c_tusr, 'Smoke Tenant', 'tenant@smoke.test');
  insert into public.leases (id, org_id, unit_id, tenant_id, start_date, end_date, monthly_rent_sen, deposit_sen)
  values (c_lease, c_org, c_unit, c_ten, '2026-01-31', '2026-07-15', 150000, 300000);
  -- Aisyah's schedule (brief R15): deposit + 6 periods, last one prorated to 77419. Total 1127419.
  insert into public.invoices (org_id, lease_id, kind, period_index, period_start, period_end, due_date, amount_sen) values
    (c_org, c_lease, 'deposit', null, null, null, '2026-01-31', 300000),
    (c_org, c_lease, 'rent', 0, '2026-01-31', '2026-02-27', '2026-01-31', 150000),
    (c_org, c_lease, 'rent', 1, '2026-02-28', '2026-03-30', '2026-02-28', 150000),
    (c_org, c_lease, 'rent', 2, '2026-03-31', '2026-04-29', '2026-03-31', 150000),
    (c_org, c_lease, 'rent', 3, '2026-04-30', '2026-05-30', '2026-04-30', 150000),
    (c_org, c_lease, 'rent', 4, '2026-05-31', '2026-06-29', '2026-05-31', 150000),
    (c_org, c_lease, 'rent', 5, '2026-06-30', '2026-07-15', '2026-06-30', 77419),
    -- 0-sen rent invoice (a prorated period can round to 0): allowed, and allocation must skip it.
    (c_org, c_lease, 'rent', 6, '2026-07-15', '2026-07-15', '2026-07-15', 0);
  insert into storage.objects (bucket_id, name) values
    ('payment-slips', c_org::text || '/' || c_lease::text || '/slip1.png'),
    ('payment-slips', c_org2::text || '/x/foreign.png');
  raise notice 'setup: org, lease (total 1127419 sen, 7 invoices), manager, staff, tenant user, slips';
end $$;

do $$
declare
  c_org  uuid := 'a0000000-0000-4000-8000-000000000001';
  c_mgr  uuid := 'b0000000-0000-4000-8000-000000000001';
  c_stf  uuid := 'b0000000-0000-4000-8000-000000000002';
  c_tusr uuid := 'b0000000-0000-4000-8000-000000000003';
  c_mgr2 uuid := 'b0000000-0000-4000-8000-000000000004';
  c_lease uuid := 'e0000000-0000-4000-8000-000000000001';
  c_key  uuid := 'f0000000-0000-4000-8000-000000000001';
  v_slip text := 'a0000000-0000-4000-8000-000000000001/e0000000-0000-4000-8000-000000000001/slip1.png';
  r record;
  v_cash uuid; v_bank uuid; v_idem uuid; v_bill1 uuid; v_bill2 uuid; v_bill3 uuid; v_pay uuid;
  v_alloc text; v_n int; v_state text;
begin
  -- 1. manager cash RM4,000 -> approved, allocated deposit (300000) then period 0 (100000)
  select * into r from private.record_payment(c_mgr, c_lease, 400000, 'cash', '2026-01-31T10:00:00+08:00', null, null);
  v_cash := r.id;
  select string_agg(coalesce(i.kind || coalesce(i.period_index::text, ''), '') || '=' || a.amount_sen, ','
                    order by i.due_date, (i.kind = 'rent'), i.period_index nulls first)
    into v_alloc
    from public.payment_allocations a join public.invoices i on i.id = a.invoice_id
   where a.payment_id = v_cash;
  if r.status <> 'approved' or r.replayed or v_alloc <> 'deposit=300000,rent0=100000' then
    raise exception 'FAIL 1: % % %', r.status, r.replayed, v_alloc;
  end if;
  raise notice 'ok 1 manager cash 400000 -> % allocations [%]', r.status, v_alloc;

  -- 2. staff bank transfer with slip -> pending, nothing allocated
  select * into r from private.record_payment(c_stf, c_lease, 200000, 'bank_transfer', '2026-03-01T00:30:00+08:00', v_slip, null);
  v_bank := r.id;
  select count(*) into v_n from public.payment_allocations a where a.payment_id = v_bank;
  if r.status <> 'pending_verification' or v_n <> 0 then raise exception 'FAIL 2: % %', r.status, v_n; end if;
  raise notice 'ok 2 staff bank_transfer 200000 -> % (allocations %)', r.status, v_n;

  -- 2b. validation / visibility errors
  begin
    perform private.record_payment(c_stf, c_lease, 1000, 'bank_transfer', now(), c_org::text || '/missing.png', null);
    raise exception 'FAIL 2b: no error';
  exception when sqlstate 'P0400' then raise notice 'ok 2b missing slip -> P0400 %', sqlerrm; end;
  begin
    perform private.record_payment(c_stf, c_lease, 1000, 'bank_transfer', now(), 'a0000000-0000-4000-8000-000000000002/x/foreign.png', null);
    raise exception 'FAIL 2c: no error';
  exception when sqlstate 'P0400' then raise notice 'ok 2c slip in another org folder -> P0400 %', sqlerrm; end;
  begin
    perform private.record_payment(c_stf, c_lease, 1000, 'bank_transfer', now(), v_slip, null);
    raise exception 'FAIL 2d: no error';
  exception when sqlstate 'P0400' then raise notice 'ok 2d slip reused -> P0400 %', sqlerrm; end;
  begin
    perform private.record_payment(c_mgr, c_lease, 1000, 'cash', now(), v_slip, null);
    raise exception 'FAIL 2e: no error';
  exception when sqlstate 'P0400' then raise notice 'ok 2e cash with slip -> P0400 %', sqlerrm; end;
  begin
    perform private.record_payment(c_mgr, c_lease, 1000, 'online', now(), null, null);
    raise exception 'FAIL 2f: no error';
  exception when sqlstate 'P0400' then raise notice 'ok 2f method online -> P0400 %', sqlerrm; end;
  begin
    perform private.record_payment(c_mgr2, c_lease, 1000, 'cash', now(), null, null);
    raise exception 'FAIL 2g: no error';
  exception when sqlstate 'P0404' then raise notice 'ok 2g other org manager -> P0404 %', sqlerrm; end;
  begin
    perform private.record_payment(c_tusr, c_lease, 1000, 'cash', now(), null, null);
    raise exception 'FAIL 2h: no error';
  exception when sqlstate 'P0404' then raise notice 'ok 2h tenant records -> P0404 %', sqlerrm; end;

  -- 3. cap = 1127419 - 400000 allocated - 200000 pending = 527419
  begin
    perform private.record_payment(c_mgr, c_lease, 527420, 'cash', now(), null, null);
    raise exception 'FAIL 3: no error';
  exception when sqlstate 'P0422' then raise notice 'ok 3 cap: 527420 > 527419 -> P0422 %', sqlerrm; end;

  -- 4. approve the staff payment -> allocated period 0 (50000) then period 1 (150000)
  begin
    perform private.approve_payment(c_stf, v_bank);
    raise exception 'FAIL 4a: no error';
  exception when sqlstate 'P0404' then raise notice 'ok 4a staff approves -> P0404 %', sqlerrm; end;
  select * into r from private.approve_payment(c_mgr, v_bank);
  select string_agg(i.kind || coalesce(i.period_index::text, '') || '=' || a.amount_sen, ',' order by i.due_date, i.period_index)
    into v_alloc
    from public.payment_allocations a join public.invoices i on i.id = a.invoice_id where a.payment_id = v_bank;
  if r.status <> 'approved' or v_alloc <> 'rent0=50000,rent1=150000' then raise exception 'FAIL 4: % %', r.status, v_alloc; end if;
  raise notice 'ok 4 approve -> % allocations [%]', r.status, v_alloc;

  -- 5. approve twice -> P0409, allocations unchanged
  begin
    perform private.approve_payment(c_mgr, v_bank);
    raise exception 'FAIL 5: no error';
  exception when sqlstate 'P0409' then raise notice 'ok 5 second approve -> P0409 %', sqlerrm; end;
  select count(*) into v_n from public.payment_allocations a where a.payment_id = v_bank;
  if v_n <> 2 then raise exception 'FAIL 5b: % allocations', v_n; end if;

  -- 6. optional idempotency key (D9)
  select * into r from private.record_payment(c_mgr, c_lease, 1000, 'cash', '2026-03-02T09:00:00+08:00', null, c_key);
  v_idem := r.id;
  select * into r from private.record_payment(c_mgr, c_lease, 1000, 'cash', '2026-03-02T09:00:00+08:00', null, c_key);
  if r.id <> v_idem or not r.replayed then raise exception 'FAIL 6: % %', r.id, r.replayed; end if;
  select count(*) into v_n from public.payments p where p.idempotency_key = c_key;
  raise notice 'ok 6 same key + payload -> replayed=% same id=% rows=%', r.replayed, r.id = v_idem, v_n;
  begin
    perform private.record_payment(c_mgr, c_lease, 2000, 'cash', '2026-03-02T09:00:00+08:00', null, c_key);
    raise exception 'FAIL 6b: no error';
  exception when sqlstate 'P0409' then raise notice 'ok 6b same key, other amount -> P0409 %', sqlerrm; end;

  -- 7. void the manager cash payment: its allocations go, the staff payment's stay (D14)
  begin
    perform private.void_payment(c_mgr, v_cash, 'no');
    raise exception 'FAIL 7a: no error';
  exception when sqlstate 'P0400' then raise notice 'ok 7a short reason -> P0400 %', sqlerrm; end;
  begin
    perform private.reject_payment(c_mgr, v_cash, 'not pending');
    raise exception 'FAIL 7b: no error';
  exception when sqlstate 'P0409' then raise notice 'ok 7b reject approved -> P0409 %', sqlerrm; end;
  select * into r from private.void_payment(c_mgr, v_cash, 'Counted twice');
  select count(*) into v_n from public.payment_allocations a where a.payment_id = v_cash;
  select string_agg(i.kind || coalesce(i.period_index::text, '') || '=' || a.amount_sen, ',' order by i.due_date, i.period_index)
    into v_alloc
    from public.payment_allocations a join public.invoices i on i.id = a.invoice_id where a.payment_id = v_bank;
  if r.status <> 'voided' or v_n <> 0 or v_alloc <> 'rent0=50000,rent1=150000' then
    raise exception 'FAIL 7: % % %', r.status, v_n, v_alloc;
  end if;
  raise notice 'ok 7 void -> % (its allocations %; staff payment still [%])', r.status, v_n, v_alloc;
  begin
    perform private.void_payment(c_mgr, v_cash, 'Counted twice');
    raise exception 'FAIL 7c: no error';
  exception when sqlstate 'P0409' then raise notice 'ok 7c void twice -> P0409 %', sqlerrm; end;
  begin
    delete from public.payments p where p.id = v_cash;
    raise exception 'FAIL 7d: delete allowed';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'ok 7d delete payment blocked -> % %', sqlstate, sqlerrm;
  end;

  -- 8. gateway bills (D5): as of 2026-02-28T16:00Z = 2026-03-01 MYT -> deposit 300000 + p0 100000 + p1 0
  begin
    perform private.create_gateway_bill(c_mgr, c_lease, '2026-02-28T16:00:00Z');
    raise exception 'FAIL 8a: no error';
  exception when sqlstate 'P0404' then raise notice 'ok 8a manager creates bill -> P0404 %', sqlerrm; end;
  begin
    perform private.create_gateway_bill(c_tusr, c_lease, '2026-01-30T15:59:59Z');
    raise exception 'FAIL 8b: no error';
  exception when sqlstate 'P0422' then raise notice 'ok 8b as of 2026-01-30 23:59:59 MYT -> P0422 %', sqlerrm; end;
  select * into r from private.create_gateway_bill(c_tusr, c_lease, '2026-02-28T16:00:00Z');
  v_bill1 := r.id;
  if r.amount_sen <> 400000 then raise exception 'FAIL 8: amount %', r.amount_sen; end if;
  raise notice 'ok 8 bill1 amount_sen=%', r.amount_sen;
  select * into r from private.create_gateway_bill(c_tusr, c_lease, '2026-02-28T16:00:00Z');
  v_bill2 := r.id;
  select * into r from private.create_gateway_bill(c_tusr, c_lease, '2026-02-28T16:00:00Z');
  v_bill3 := r.id;

  -- 9. callbacks
  begin
    perform private.apply_gateway_callback(gen_random_uuid(), true, 400000, now(), 'TX-0', 'completed');
    raise exception 'FAIL 9a: no error';
  exception when sqlstate 'P0404' then raise notice 'ok 9a unknown bill -> P0404 %', sqlerrm; end;
  begin
    perform private.apply_gateway_callback(v_bill1, true, 399999, now(), 'TX-1', 'completed');
    raise exception 'FAIL 9b: no error';
  exception when sqlstate 'P0422' then raise notice 'ok 9b amount mismatch -> P0422 %', sqlerrm; end;
  select * into r from private.apply_gateway_callback(v_bill1, true, 400000, '2026-03-01T00:30:12+08:00', 'TX-1', 'completed');
  v_pay := r.payment_id;
  if r.outcome <> 'paid' or v_pay is null then raise exception 'FAIL 9c: %', r.outcome; end if;
  raise notice 'ok 9c callback paid -> % payment %', r.outcome, v_pay is not null;
  select count(*) into v_n from public.audit_log l
   where l.action = 'payment.approved' and l.entity_id = v_pay and l.actor_id is null
     and l.details ->> 'source' = 'gateway' and l.details ->> 'bill_id' = v_bill1::text;
  if v_n <> 1 then raise exception 'FAIL 9c2: payment.approved audit rows %', v_n; end if;
  raise notice 'ok 9c2 gateway payment.approved audited (actor null, source gateway)';
  begin
    update public.gateway_bills b set transaction_id = 'TX-forged' where b.id = v_bill1;
    raise exception 'FAIL 9c3: no error';
  exception when sqlstate 'P0409' then raise notice 'ok 9c3 paid bill transaction_id frozen -> P0409 %', sqlerrm; end;
  select * into r from private.apply_gateway_callback(v_bill1, true, 400000, '2026-03-01T00:30:12+08:00', 'TX-1', 'completed');
  select count(*) into v_n from public.payments p where p.gateway_bill_id = v_bill1;
  if r.outcome <> 'duplicate' or r.payment_id <> v_pay or v_n <> 1 then raise exception 'FAIL 9d: % %', r.outcome, v_n; end if;
  raise notice 'ok 9d callback paid again -> % same payment=% payments for bill=%', r.outcome, r.payment_id = v_pay, v_n;
  select * into r from private.apply_gateway_callback(v_bill1, false, 400000, now(), 'TX-1b', 'failed');
  select b.status into v_state from public.gateway_bills b where b.id = v_bill1;
  if r.outcome <> 'ignored' or v_state <> 'paid' then raise exception 'FAIL 9e: % %', r.outcome, v_state; end if;
  raise notice 'ok 9e paid=false on paid bill -> % (bill still %)', r.outcome, v_state;
  select * into r from private.apply_gateway_callback(v_bill2, false, null, null, 'TX-2', 'failed');
  if r.outcome <> 'failed' then raise exception 'FAIL 9f: %', r.outcome; end if;
  select * into r from private.apply_gateway_callback(v_bill2, false, null, null, 'TX-2', 'failed');
  if r.outcome <> 'ignored' then raise exception 'FAIL 9g: %', r.outcome; end if;
  raise notice 'ok 9f/9g paid=false on pending -> failed, again -> %', r.outcome;
  select * into r from private.apply_gateway_callback(v_bill2, true, 400000, '2026-03-02T10:00:00+08:00', 'TX-2b', 'completed');
  if r.outcome <> 'paid' then raise exception 'FAIL 9h: %', r.outcome; end if;
  raise notice 'ok 9h failed bill then paid=true -> %', r.outcome;
  -- remaining before bill3 = 1127419 - (200000 + 1000 + 400000 + 400000) = 126419 -> unapplied 273581
  select * into r from private.apply_gateway_callback(v_bill3, true, 400000, '2026-03-03T10:00:00+08:00', 'TX-3', 'completed');
  select p.unapplied_sen::int into v_n from public.payments p where p.id = r.payment_id;
  if v_n <> 273581 then raise exception 'FAIL 9i: unapplied %', v_n; end if;
  raise notice 'ok 9i online overpayment -> unapplied_sen=%', v_n;
  select (select sum(i.amount_sen) from public.invoices i where i.lease_id = c_lease)
       - (select sum(a.amount_sen) from public.payment_allocations a where a.lease_id = c_lease)
    into v_n;
  if v_n <> 0 then raise exception 'FAIL 9j: remaining %', v_n; end if;
  raise notice 'ok 9j lease remaining balance = %', v_n;
  select count(*) into v_n from public.payment_allocations a
    join public.invoices i on i.id = a.invoice_id
   where a.lease_id = c_lease and i.amount_sen = 0;
  if v_n <> 0 then raise exception 'FAIL 9j2: allocations on the 0-sen invoice %', v_n; end if;
  raise notice 'ok 9j2 no allocation on the 0-sen rent invoice';
  begin
    insert into public.invoices (org_id, lease_id, kind, due_date, amount_sen)
    values (c_org, gen_random_uuid(), 'deposit', '2026-01-31', 0);
    raise exception 'FAIL 9j3: no error';
  exception when sqlstate '23514' then raise notice 'ok 9j3 0-sen deposit invoice -> 23514'; end;
  begin
    perform private.create_gateway_bill(c_tusr, c_lease, '2026-12-31T00:00:00Z');
    raise exception 'FAIL 9k: no error';
  exception when sqlstate 'P0422' then raise notice 'ok 9k all paid -> P0422 %', sqlerrm; end;

  -- 10. audit trail
  select string_agg(x.action || '=' || x.n, ', ' order by x.action) into v_alloc
    from (select l.action, count(*) as n from public.audit_log l where l.org_id = c_org group by l.action) x;
  raise notice 'ok 10 audit_log: %', v_alloc;
end $$;

rollback;
