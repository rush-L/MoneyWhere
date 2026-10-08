-- Phase D7: Who Paid (expense) / Received by (income). paid_by_user_id becomes client-selectable; created_by never is.
--   * the payer must be a CURRENT member of the transaction's own wallet, checked by the trigger below, so it covers
--     every write path (direct INSERT and apply_transaction_mutation) and cannot be bypassed from the client
--   * validated when it is set or CHANGED. An untouched historical payer who has since left is kept as-is, so editing
--     the amount of an old transaction does not rewrite history. Assigning a former member is always refused.
--   * transfers have no payer: still forced to NULL
--   * an unspecified payer defaults to the creator (insert) or stays as it was (update)

grant insert (paid_by_user_id) on public.transactions to authenticated;

create or replace function public.transactions_set_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select wallet_id into new.wallet_id from public.accounts where id = new.account_id;
  if tg_op = 'INSERT' then new.created_by := auth.uid(); end if;
  if new.type = 'transfer' then
    new.paid_by_user_id := null;
  else
    new.paid_by_user_id := coalesce(new.paid_by_user_id, new.created_by);
    if (tg_op = 'INSERT' or new.paid_by_user_id is distinct from old.paid_by_user_id)
       and not exists (select 1 from public.wallet_members where wallet_id = new.wallet_id and user_id = new.paid_by_user_id) then
      raise exception 'payer must be a current member of the wallet' using errcode = '42501';
    end if;
  end if;
  return new;  -- unknown account leaves wallet_id NULL, which fails NOT NULL; null uid fails NOT NULL too
end $$;

drop trigger transactions_set_owner on public.transactions;
create trigger transactions_set_owner before insert or update of account_id, type, paid_by_user_id on public.transactions
  for each row execute function public.transactions_set_owner();

-- A payer-only edit is a real change: it must move the version (optimistic concurrency, offline replay).
create or replace function public.transactions_bump_version() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.account_id, new.destination_account_id, new.category_id, new.type, new.amount_minor, new.date, new.note, new.paid_by_user_id)
     is distinct from
     (old.account_id, old.destination_account_id, old.category_id, old.type, old.amount_minor, old.date, old.note, old.paid_by_user_id)
  then new.version := old.version + 1;
  else new.version := old.version;
  end if;
  return new;
end $$;

-- Same RPC as before plus the payer. Absent/null in the payload keeps the stored payer (older queued edits carry none);
-- a transfer is always NULL. created_by is still never read from the payload. Membership is enforced by the trigger.
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
      paid_by_user_id = case when p_payload ->> 'type' = 'transfer' then null
                             else coalesce((p_payload ->> 'paid_by_user_id')::uuid, t.paid_by_user_id, v_uid) end
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
