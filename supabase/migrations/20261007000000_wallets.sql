-- Phase 3: wallets + membership (Shared Log mode only).
-- Authorization: user -> wallet_members -> wallet-owned rows. RLS is the boundary.

create table public.wallets (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 50),
  -- One currency per wallet. Only PHP for now; widen this CHECK when multi-currency is specified.
  currency text not null default 'PHP' check (currency in ('PHP')),
  -- Split mode arrives in a later phase by widening this CHECK.
  mode text not null default 'shared_log' check (mode in ('shared_log')),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.wallet_members (
  wallet_id uuid not null references public.wallets (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (wallet_id, user_id)
);

create index wallet_members_user_id_idx on public.wallet_members (user_id);
-- Exactly one owner per wallet. (Ownership transfer must demote first, in one transaction.)
create unique index wallet_members_one_owner_idx on public.wallet_members (wallet_id) where role = 'owner';

create trigger wallets_touch_updated_at before update on public.wallets
  for each row execute function public.touch_updated_at();

-- Membership helpers. SECURITY DEFINER so policies on wallet_members don't recurse into themselves;
-- they only ever answer about the *calling* user (auth.uid()).
create function public.is_wallet_member(p_wallet_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.wallet_members where wallet_id = p_wallet_id and user_id = auth.uid())
$$;

create function public.is_wallet_owner(p_wallet_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.wallet_members where wallet_id = p_wallet_id and user_id = auth.uid() and role = 'owner')
$$;

revoke execute on function public.is_wallet_member(uuid), public.is_wallet_owner(uuid) from public, anon;
grant execute on function public.is_wallet_member(uuid), public.is_wallet_owner(uuid) to authenticated;

-- Only way to create a wallet: the creator becomes its owner atomically. No direct INSERT for clients.
create function public.create_wallet(p_name text) returns public.wallets
language plpgsql security definer set search_path = '' as $$
declare
  w public.wallets;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  insert into public.wallets (name, created_by) values (btrim(p_name), auth.uid()) returning * into w;
  insert into public.wallet_members (wallet_id, user_id, role) values (w.id, auth.uid(), 'owner');
  return w;
end $$;

revoke execute on function public.create_wallet(text) from public, anon;
grant execute on function public.create_wallet(text) to authenticated;

alter table public.wallets enable row level security;
alter table public.wallet_members enable row level security;

-- Start from nothing, grant only what the policies below can use (also drops TRUNCATE/TRIGGER/REFERENCES).
revoke all on public.wallets, public.wallet_members from anon, authenticated;
grant select, delete on public.wallets, public.wallet_members to authenticated;
grant update (name) on public.wallets to authenticated;

create policy wallets_select_member on public.wallets for select using (public.is_wallet_member(id));
create policy wallets_update_owner on public.wallets for update
  using (public.is_wallet_owner(id)) with check (public.is_wallet_owner(id));
create policy wallets_delete_owner on public.wallets for delete using (public.is_wallet_owner(id));

-- Members see the member list of wallets they belong to.
create policy wallet_members_select on public.wallet_members for select using (public.is_wallet_member(wallet_id));
-- A member may leave; the owner may not (they must transfer ownership or delete the wallet).
create policy wallet_members_leave on public.wallet_members for delete
  using (user_id = auth.uid() and role = 'member');
-- No INSERT/UPDATE policies: adding members and ownership transfer come with invitations (later phase).
