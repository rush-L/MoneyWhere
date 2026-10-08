-- Phase D5: co-member visibility. profiles stays readable only by its owner (no new policy on it). Instead, ONE
-- function returns the display identity of a wallet's CURRENT members, and only to a current member of that wallet.
--   * exposes only display_name and avatar_url (never email or any auth data)
--   * membership is the boundary: a user who left or was removed is not in wallet_members, so their profile is not
--     returned; their id stays on historical transactions and the client renders it as "Former member"
--   * another wallet, an outsider and anon get nothing (error), so it cannot be used to enumerate users
create function public.list_wallet_members(p_wallet_id uuid)
returns table (user_id uuid, role text, joined_at timestamptz, display_name text, avatar_url text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if not public.is_wallet_member(p_wallet_id) then raise exception 'not allowed' using errcode = '42501'; end if;
  return query
    select m.user_id, m.role, m.created_at, p.display_name, p.avatar_url
    from public.wallet_members m
    left join public.profiles p on p.id = m.user_id
    where m.wallet_id = p_wallet_id
    order by m.created_at;
end $$;

revoke execute on function public.list_wallet_members(uuid) from public, anon;
grant execute on function public.list_wallet_members(uuid) to authenticated;
