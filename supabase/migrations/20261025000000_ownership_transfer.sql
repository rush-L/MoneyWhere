-- Phase D6: ownership transfer. The only way to change a wallet's owner. No table, policy or grant changes:
-- wallet_members still has no INSERT/UPDATE/DELETE for clients, so this RPC is the sole path.
-- Only wallet_members.role changes; wallets, accounts, categories, budgets and transactions (created_by,
-- paid_by_user_id) are untouched.
create function public.transfer_wallet_ownership(p_wallet_id uuid, p_new_owner uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  -- Lock the caller's owner row first. A concurrent transfer by the same owner waits here, then re-evaluates
  -- role = 'owner', finds nothing (they are now a member) and is refused.
  perform 1 from public.wallet_members where wallet_id = p_wallet_id and user_id = v_me and role = 'owner' for update;
  if not found then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_new_owner is null or p_new_owner = v_me then raise exception 'choose another member' using errcode = '22023'; end if;
  -- Target must be a CURRENT plain member of this very wallet. Also locked, so a concurrent remove/leave waits and then fails.
  perform 1 from public.wallet_members where wallet_id = p_wallet_id and user_id = p_new_owner and role = 'member' for update;
  if not found then raise exception 'member not found' using errcode = 'P0002'; end if;
  -- Demote first: the one-owner unique index forbids two owners even momentarily. Both updates commit or neither does.
  update public.wallet_members set role = 'member' where wallet_id = p_wallet_id and user_id = v_me;
  update public.wallet_members set role = 'owner' where wallet_id = p_wallet_id and user_id = p_new_owner;
end $$;

revoke execute on function public.transfer_wallet_ownership(uuid, uuid) from public, anon;
grant execute on function public.transfer_wallet_ownership(uuid, uuid) to authenticated;
