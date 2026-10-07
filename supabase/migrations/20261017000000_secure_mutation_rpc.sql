-- Phase 12B step 1: apply_transaction_mutation becomes SECURITY DEFINER with its OWN authorization, so the next
-- migration can revoke direct UPDATE/DELETE on transactions and leave this RPC as the only client mutation path.
-- This migration is additive: table grants are untouched, so the app works before and after it.
--
-- Why DEFINER: once the caller has no UPDATE/DELETE grant, only a function running as another role can write the row,
-- and neither column grants nor RLS can express "expected version matches" (RLS cannot see RPC arguments).
-- The owner (the migration role) bypasses RLS, so EVERY statement below is scoped explicitly. Never add an unscoped query.
--
-- Authorization: auth.uid() -> transaction -> wallet -> membership via can_manage_transaction (owner of the wallet, or a
-- member who created the row), narrowed by p_own_only (a client-supplied narrowing hint: it can only restrict).
-- Information: a non-member learns nothing (UPDATE -> CONFLICT/not_found, DELETE -> ALREADY_GONE, no version/wallet/owner);
-- a member without permission gets FORBIDDEN. The diagnostic read mirrors the transactions SELECT policy.

-- A transaction never changes wallet. transactions_set_owner re-derives wallet_id from account_id on every UPDATE, and the
-- invoker RLS WITH CHECK used to stop a caller moving a row into a wallet they don't belong to; definer has no such check,
-- so the invariant lives here (named to sort after transactions_set_owner, so it sees the re-derived value).
create function public.transactions_wallet_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.wallet_id is distinct from old.wallet_id then
    raise exception 'a transaction cannot move between wallets' using errcode = '42501';
  end if;
  return new;
end $$;
revoke execute on function public.transactions_wallet_immutable() from public, anon, authenticated;

create trigger transactions_wallet_immutable before update on public.transactions
  for each row execute function public.transactions_wallet_immutable();

create or replace function public.apply_transaction_mutation(
  p_mutation_id uuid,
  p_op text,
  p_transaction_id uuid,
  p_expected_version bigint,
  p_payload jsonb default null,
  p_own_only boolean default false
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_prev public.transaction_mutations;
  v_row public.transactions;
  v_version bigint;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  if p_op not in ('UPDATE', 'DELETE') then raise exception 'invalid operation' using errcode = '22023'; end if;
  if p_op = 'UPDATE' and p_payload is null then raise exception 'payload required' using errcode = '22023'; end if;

  -- Serialise replays of the same mutation id (two tabs); keyed by user so nobody can stall another user's id.
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text || ':' || p_mutation_id::text, 0));
  -- Own ledger rows only (RLS no longer applies inside a definer function).
  select * into v_prev from public.transaction_mutations where mutation_id = p_mutation_id and user_id = v_uid;
  if found then
    if v_prev.transaction_id <> p_transaction_id or v_prev.op <> p_op then
      raise exception 'mutation id reused for a different mutation' using errcode = '22023';
    end if;
    return jsonb_build_object('status', 'ALREADY_APPLIED', 'version', v_prev.applied_version);
  end if;

  -- Version check, authorization and write are ONE statement: no check-then-write race.
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
    where t.id = p_transaction_id and t.version = p_expected_version
      and public.can_manage_transaction(t.wallet_id, t.created_by)
      and (not p_own_only or t.created_by = v_uid)
    returning t.version into v_version;
  else
    delete from public.transactions t
    where t.id = p_transaction_id and t.version = p_expected_version
      and public.can_manage_transaction(t.wallet_id, t.created_by)
      and (not p_own_only or t.created_by = v_uid)
    returning t.version into v_version;
  end if;

  if found then
    insert into public.transaction_mutations (mutation_id, user_id, transaction_id, op, applied_version)
    values (p_mutation_id, v_uid, p_transaction_id, p_op, v_version);
    return jsonb_build_object('status', 'APPLIED', 'version', v_version);
  end if;

  -- Nothing changed: say why, but only to wallet members (same visibility as the transactions SELECT policy).
  select * into v_row from public.transactions where id = p_transaction_id and public.is_wallet_member(wallet_id);
  if not found then
    return case p_op when 'DELETE' then jsonb_build_object('status', 'ALREADY_GONE')
                     else jsonb_build_object('status', 'CONFLICT', 'reason', 'not_found') end;
  end if;
  if (p_own_only and v_row.created_by <> v_uid) or not public.can_manage_transaction(v_row.wallet_id, v_row.created_by) then
    return jsonb_build_object('status', 'FORBIDDEN');
  end if;
  return jsonb_build_object('status', 'CONFLICT', 'reason', 'version_mismatch', 'version', v_row.version);
end $$;

revoke all on function public.apply_transaction_mutation(uuid, text, uuid, bigint, jsonb, boolean) from public, anon;
grant execute on function public.apply_transaction_mutation(uuid, text, uuid, bigint, jsonb, boolean) to authenticated;
