-- Phase D9: account deletion (spec 17.2). Authoritative path: delete_my_account(), a SECURITY DEFINER RPC that
-- derives the caller from auth.uid(), re-checks every blocker on the server, anonymizes history, and deletes the
-- auth user in the SAME transaction. No service role, no client-supplied user id.
--
-- Schema changes forced by "transactions are retained, identity becomes anonymous (NULL)":
--   * transactions.created_by and wallets.created_by become nullable
--   * transactions_shape_check no longer demands a payer on income/expense (NULL = Former member)
--   * transactions_set_owner / apply_transaction_mutation must not turn a NULL payer back into someone
-- The foreign keys to auth.users stay NO ACTION on purpose: deleting a user any other way is still refused.

-- ---------------------------------------------------------------------------------------------------------
-- 1. Nullable identities
-- ---------------------------------------------------------------------------------------------------------
alter table public.transactions alter column created_by drop not null;
alter table public.wallets alter column created_by drop not null;

alter table public.transactions drop constraint transactions_shape_check;
alter table public.transactions add constraint transactions_shape_check check (
  case when type = 'transfer'
    then destination_account_id is not null and category_id is null and paid_by_user_id is null
         and account_id <> destination_account_id
    else destination_account_id is null
  end);

-- ---------------------------------------------------------------------------------------------------------
-- 2. transactions_set_owner. Same trigger and column list as D7. Differences:
--    * INSERT with no signed-in user is refused here (the NOT NULL on created_by used to do it)
--    * the payer falls back to the creator on INSERT only. On UPDATE a NULL payer stays NULL (anonymized)
--    * transfer -> expense/income has no payer yet, so it defaults to the editor
--    * clearing an existing payer is refused, except inside delete_my_account: the transaction-local flag (set only
--      after its blocker and confirmation checks, cleared right after the anonymizing UPDATE) AND the PL/pgSQL call
--      stack must show delete_my_account. The stack cannot be forged by a client (a SET can, and inside a definer
--      trigger current_user is always the owner, so a role test would prove nothing). Clients also hold no UPDATE
--      grant, and apply_transaction_mutation never writes a NULL payer.
--    * a payer that is SET or CHANGED must still be a current member of the wallet (unchanged history is not re-validated)
-- ---------------------------------------------------------------------------------------------------------
create or replace function public.transactions_set_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_stack text;
begin
  select wallet_id into new.wallet_id from public.accounts where id = new.account_id;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    if new.created_by is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  end if;
  if new.type = 'transfer' then
    new.paid_by_user_id := null;
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.paid_by_user_id := coalesce(new.paid_by_user_id, new.created_by);
  elsif old.type = 'transfer' then
    new.paid_by_user_id := coalesce(new.paid_by_user_id, auth.uid());
  elsif new.paid_by_user_id is null and old.paid_by_user_id is not null then
    get diagnostics v_stack = pg_context;
    if not (current_setting('app.account_deletion', true) = 'on' and v_stack like '%PL/pgSQL function %delete_my_account(uuid[])%') then
      raise exception 'a payer cannot be cleared' using errcode = '42501';
    end if;
  end if;
  if new.paid_by_user_id is not null
     and (tg_op = 'INSERT' or new.paid_by_user_id is distinct from old.paid_by_user_id)
     and not exists (select 1 from public.wallet_members where wallet_id = new.wallet_id and user_id = new.paid_by_user_id) then
    raise exception 'payer must be a current member of the wallet' using errcode = '42501';
  end if;
  return new;
end $$;

-- can_manage_transaction with a NULL creator (anonymized row): `p_created_by = auth.uid()` was NULL, so the function
-- returned NULL, and `not NULL` is NULL, which made apply_transaction_mutation report a plain member's attempt as a
-- version CONFLICT instead of FORBIDDEN. Access was already denied; the answer must also be a real boolean:
-- the owner manages it, nobody else does.
create or replace function public.can_manage_transaction(p_wallet_id uuid, p_created_by uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_wallet_owner(p_wallet_id)
         or (public.is_wallet_member(p_wallet_id) and p_created_by is not null and p_created_by = auth.uid())
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 3. apply_transaction_mutation: identical to D7 except the payer expression. An existing NULL payer (anonymized
--    income/expense) is kept unless the payload explicitly names a member; only a transfer being converted needs
--    a payer established, and that defaults to the caller. Everything else is copied unchanged.
-- ---------------------------------------------------------------------------------------------------------
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

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text || ':' || p_mutation_id::text, 0));
  select * into v_prev from public.transaction_mutations where mutation_id = p_mutation_id and user_id = v_uid;
  if found then
    if v_prev.transaction_id <> p_transaction_id or v_prev.op <> p_op then
      raise exception 'mutation id reused for a different mutation' using errcode = '22023';
    end if;
    return jsonb_build_object('status', 'ALREADY_APPLIED', 'version', v_prev.applied_version);
  end if;

  if p_op = 'UPDATE' then
    -- Whitelisted columns only. wallet_id / created_by / version are never read from the payload.
    update public.transactions t set
      account_id = (p_payload ->> 'account_id')::uuid,
      destination_account_id = (p_payload ->> 'destination_account_id')::uuid,
      category_id = (p_payload ->> 'category_id')::uuid,
      type = p_payload ->> 'type',
      amount_minor = (p_payload ->> 'amount_minor')::bigint,
      date = (p_payload ->> 'date')::date,
      note = p_payload ->> 'note',
      paid_by_user_id = case
        when p_payload ->> 'type' = 'transfer' then null
        when t.type = 'transfer' then coalesce((p_payload ->> 'paid_by_user_id')::uuid, v_uid)
        else coalesce((p_payload ->> 'paid_by_user_id')::uuid, t.paid_by_user_id)
      end
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

-- ---------------------------------------------------------------------------------------------------------
-- 4. Deletion plan. INTERNAL helper (not callable by any client role): what deleting p_uid would do.
--    blocking    owner of a wallet that has other members (deletion refused)
--    will_delete owner and the only member (wallet is deleted with the account)
--    leaving     plain member (membership ends, history is kept)
-- ---------------------------------------------------------------------------------------------------------
create function public.account_deletion_plan(p_uid uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with mine as (
    select m.wallet_id, m.role, w.name,
           (select count(*) from public.wallet_members o where o.wallet_id = m.wallet_id and o.user_id <> p_uid) as others
    from public.wallet_members m join public.wallets w on w.id = m.wallet_id
    where m.user_id = p_uid
  )
  select jsonb_build_object(
    'blocking', coalesce((select jsonb_agg(jsonb_build_object('id', wallet_id, 'name', name, 'other_members', others) order by name, wallet_id)
                          from mine where role = 'owner' and others > 0), '[]'::jsonb),
    'will_delete', coalesce((select jsonb_agg(jsonb_build_object('id', wallet_id, 'name', name) order by name, wallet_id)
                             from mine where role = 'owner' and others = 0), '[]'::jsonb),
    'leaving', coalesce((select jsonb_agg(jsonb_build_object('id', wallet_id, 'name', name) order by name, wallet_id)
                         from mine where role = 'member'), '[]'::jsonb)
  )
$$;
revoke execute on function public.account_deletion_plan(uuid) from public, anon, authenticated;

create function public.account_deletion_preview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  return public.account_deletion_plan(auth.uid());
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- 5. delete_my_account. Takes NO user id: the caller is auth.uid(). p_confirmed_wallet_ids is what the user was
--    shown; it is compared with the server's own computed set and never decides anything on its own.
--    Results: {ok:true} | {ok:false, reason:'blocked', wallets} | {ok:false, reason:'changed'}.
--    Any failure raises and the whole transaction rolls back (no partial deletion).
--    Lock order is members -> invitations -> wallets, matching accept_wallet_invitation (invitation row, then the
--    membership insert's key-share lock on the wallet), so the two cannot deadlock; a join in flight either commits
--    before our recount (-> blocked) or waits and then fails its foreign key.
-- ---------------------------------------------------------------------------------------------------------
create function public.delete_my_account(p_confirmed_wallet_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
  v_plan jsonb;
  v_sole uuid[];
  v_confirmed uuid[];
begin
  if v_me is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if p_confirmed_wallet_ids is null then raise exception 'confirmed wallets required' using errcode = '22023'; end if;

  perform pg_advisory_xact_lock(hashtextextended('delete_account:' || v_me::text, 0)); -- one deletion per user at a time
  if not exists (select 1 from auth.users where id = v_me) then
    return jsonb_build_object('ok', true); -- already deleted: a retry after a lost response is harmless
  end if;

  perform 1 from public.wallet_members where user_id = v_me order by wallet_id for update;
  perform 1 from public.wallet_invitations
    where wallet_id in (select wallet_id from public.wallet_members where user_id = v_me and role = 'owner')
    order by id for update;
  perform 1 from public.wallets
    where id in (select wallet_id from public.wallet_members where user_id = v_me and role = 'owner')
    order by id for update;

  v_plan := public.account_deletion_plan(v_me); -- a new statement after the locks: sees every committed join
  if jsonb_array_length(v_plan -> 'blocking') > 0 then
    return jsonb_build_object('ok', false, 'reason', 'blocked', 'wallets', v_plan -> 'blocking');
  end if;
  select coalesce(array_agg((e ->> 'id')::uuid order by (e ->> 'id')::uuid), '{}') into v_sole
    from jsonb_array_elements(v_plan -> 'will_delete') e;
  select coalesce(array_agg(distinct x order by x), '{}') into v_confirmed from unnest(p_confirmed_wallet_ids) x;
  if v_confirmed is distinct from v_sole then
    return jsonb_build_object('ok', false, 'reason', 'changed');
  end if;

  -- Past every check. Wallets where the user is the only member go, with everything in them.
  delete from public.wallets where id = any (v_sole);

  -- Surviving wallets keep their history; only this user's identity is removed. One UPDATE, so each row is touched once.
  perform set_config('app.account_deletion', 'on', true);
  update public.transactions set
    created_by = case when created_by = v_me then null else created_by end,
    paid_by_user_id = case when paid_by_user_id = v_me then null else paid_by_user_id end
  where created_by = v_me or paid_by_user_id = v_me;
  perform set_config('app.account_deletion', 'off', true);

  delete from public.wallet_members where user_id = v_me;
  update public.wallets set created_by = null where created_by = v_me;
  delete from auth.users where id = v_me; -- cascades: profile, rate events, mutation ledger, own invitations, Auth's sessions/identities
  return jsonb_build_object('ok', true);
end $$;

revoke execute on function public.account_deletion_preview(), public.delete_my_account(uuid[]) from public, anon;
grant execute on function public.account_deletion_preview(), public.delete_my_account(uuid[]) to authenticated;
