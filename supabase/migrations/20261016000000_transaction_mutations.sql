-- Phase 11B: the single concurrency-safe UPDATE/DELETE path for transactions (online and offline replay).
--
-- apply_transaction_mutation is SECURITY INVOKER: the caller's RLS (can_manage_transaction) and column grants
-- still decide what may change. p_own_only additionally restricts to rows the caller created (offline replay
-- passes true; an owner's edit of another member's transaction stays an online-only capability).
-- The version check, authorization and write are ONE statement, so there is no check-then-write race.
--
-- Idempotency: transaction_mutations records each APPLIED mutation id. A retry after a lost response finds it
-- and answers ALREADY_APPLIED instead of a false version conflict. Conflicts are returned as data, not errors.
-- A DELETE of an already-missing row is ALREADY_GONE (idempotent success); an UPDATE of a missing row is a
-- CONFLICT and never recreates it. Hard deletes stay: the ledger, not a tombstone, carries idempotency.

create table public.transaction_mutations (
  mutation_id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  transaction_id uuid not null,  -- no FK: DELETE removes the row
  op text not null check (op in ('UPDATE', 'DELETE')),
  applied_version bigint not null,
  created_at timestamptz not null default now()
);
alter table public.transaction_mutations enable row level security;
revoke all on public.transaction_mutations from anon, authenticated;
grant select on public.transaction_mutations to authenticated;
grant insert (mutation_id, transaction_id, op, applied_version) on public.transaction_mutations to authenticated;
create policy transaction_mutations_select_own on public.transaction_mutations for select using (user_id = auth.uid());
create policy transaction_mutations_insert_own on public.transaction_mutations for insert with check (user_id = auth.uid());

create function public.apply_transaction_mutation(
  p_mutation_id uuid,
  p_op text,
  p_transaction_id uuid,
  p_expected_version bigint,
  p_payload jsonb default null,
  p_own_only boolean default false
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_prev public.transaction_mutations;
  v_row public.transactions;
  v_version bigint;
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  if p_op not in ('UPDATE', 'DELETE') then raise exception 'invalid operation' using errcode = '22023'; end if;
  if p_op = 'UPDATE' and p_payload is null then raise exception 'payload required' using errcode = '22023'; end if;

  -- Serialise replays of the same mutation id (two tabs) so the ledger check below cannot race.
  perform pg_advisory_xact_lock(hashtextextended(p_mutation_id::text, 0));
  select * into v_prev from public.transaction_mutations where mutation_id = p_mutation_id;  -- RLS: own rows only
  if found then
    if v_prev.transaction_id <> p_transaction_id or v_prev.op <> p_op then
      raise exception 'mutation id reused for a different mutation' using errcode = '22023';
    end if;
    return jsonb_build_object('status', 'ALREADY_APPLIED', 'version', v_prev.applied_version);
  end if;

  if p_op = 'UPDATE' then
    -- Whitelisted columns only. wallet_id / created_by / paid_by_user_id / version are never read from the payload.
    update public.transactions t set
      account_id = (p_payload ->> 'account_id')::uuid,
      destination_account_id = (p_payload ->> 'destination_account_id')::uuid,
      category_id = (p_payload ->> 'category_id')::uuid,
      type = p_payload ->> 'type',
      amount_minor = (p_payload ->> 'amount_minor')::bigint,
      date = (p_payload ->> 'date')::date,
      note = p_payload ->> 'note'
    where t.id = p_transaction_id and t.version = p_expected_version and (not p_own_only or t.created_by = auth.uid())
    returning t.version into v_version;
  else
    delete from public.transactions t
    where t.id = p_transaction_id and t.version = p_expected_version and (not p_own_only or t.created_by = auth.uid())
    returning t.version into v_version;
  end if;

  if found then
    insert into public.transaction_mutations (mutation_id, transaction_id, op, applied_version)
    values (p_mutation_id, p_transaction_id, p_op, v_version);
    return jsonb_build_object('status', 'APPLIED', 'version', v_version);
  end if;

  -- Nothing changed: say why (the caller's SELECT policy shows any wallet member's row).
  select * into v_row from public.transactions where id = p_transaction_id;
  if not found then
    return case p_op when 'DELETE' then jsonb_build_object('status', 'ALREADY_GONE')
                     else jsonb_build_object('status', 'CONFLICT', 'reason', 'not_found') end;
  end if;
  if (p_own_only and v_row.created_by <> auth.uid()) or not public.can_manage_transaction(v_row.wallet_id, v_row.created_by) then
    return jsonb_build_object('status', 'FORBIDDEN');
  end if;
  return jsonb_build_object('status', 'CONFLICT', 'reason', 'version_mismatch', 'version', v_row.version);
end $$;
revoke execute on function public.apply_transaction_mutation(uuid, text, uuid, bigint, jsonb, boolean) from public, anon;
grant execute on function public.apply_transaction_mutation(uuid, text, uuid, bigint, jsonb, boolean) to authenticated;
