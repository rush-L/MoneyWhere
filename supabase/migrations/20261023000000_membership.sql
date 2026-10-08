-- Phase D4: membership foundation. Invitations (hashed, single-use, 7-day), remove / leave, rate limiting.
-- Every membership mutation is a SECURITY DEFINER RPC; clients get no INSERT/UPDATE/DELETE on these tables.
-- Ownership transfer is NOT here (D6). Owners cannot leave or be removed.

-- ---------------------------------------------------------------------------------------------------------
-- Invitations. Only sha256(token) is stored; the plaintext token exists once, in the create RPC's response.
-- ---------------------------------------------------------------------------------------------------------
create table public.wallet_invitations (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references public.wallets (id) on delete cascade,
  created_by uuid not null references auth.users (id) on delete cascade,
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  revoked_at timestamptz,
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  -- Lifetime is capped in the database too, not only in the RPC.
  check (expires_at > created_at and expires_at <= created_at + interval '7 days'),
  check (accepted_at is null or revoked_at is null)
);
create index wallet_invitations_wallet_id_idx on public.wallet_invitations (wallet_id);

alter table public.wallet_invitations enable row level security;
revoke all on public.wallet_invitations from anon, authenticated;
-- Owners may read the non-secret columns of their wallet's invitations. token_hash and accepted_by stay unreadable.
grant select (id, wallet_id, created_by, created_at, expires_at, revoked_at, accepted_at) on public.wallet_invitations to authenticated;
create policy wallet_invitations_select_owner on public.wallet_invitations for select using (public.is_wallet_owner(wallet_id));

-- ---------------------------------------------------------------------------------------------------------
-- Rate limiting: one row per counted attempt, per user and action. Server-side only (RLS on, no policy, no grant).
-- ---------------------------------------------------------------------------------------------------------
create table public.membership_rate_events (
  user_id uuid not null references auth.users (id) on delete cascade,
  action text not null,
  at timestamptz not null default now()
);
create index membership_rate_events_idx on public.membership_rate_events (user_id, action, at);
alter table public.membership_rate_events enable row level security;
revoke all on public.membership_rate_events from anon, authenticated;

-- True and records the attempt when under the limit; false (nothing recorded) when over it. Internal: not callable by clients.
create function public.membership_rate_check(p_action text, p_max int, p_window interval) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
begin
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text || ':' || p_action, 0)); -- serialise one user's counting
  delete from public.membership_rate_events where user_id = v_uid and at < now() - interval '1 day';
  if (select count(*) from public.membership_rate_events where user_id = v_uid and action = p_action and at > now() - p_window) >= p_max then
    return false;
  end if;
  insert into public.membership_rate_events (user_id, action) values (v_uid, p_action);
  return true;
end $$;
revoke execute on function public.membership_rate_check(text, int, interval) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------
-- Owner: create / revoke invitations.
-- Limit: 20 invitations per user per hour. 244-bit token (two v4 UUIDs from the server CSPRNG), hex, 64 chars.
-- ---------------------------------------------------------------------------------------------------------
create function public.create_wallet_invitation(p_wallet_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_token text;
  v_row public.wallet_invitations;
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if not public.is_wallet_owner(p_wallet_id) then raise exception 'not allowed' using errcode = '42501'; end if;
  if not public.membership_rate_check('invite_create', 20, interval '1 hour') then
    raise exception 'rate limit exceeded' using errcode = '54000';
  end if;
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.wallet_invitations (wallet_id, created_by, token_hash)
  values (p_wallet_id, auth.uid(), sha256(convert_to(v_token, 'utf8')))
  returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'token', v_token, 'expires_at', v_row.expires_at);
end $$;

-- Pending (not accepted, not revoked) invitations only. Unknown id and "not your wallet" are the same error.
create function public.revoke_wallet_invitation(p_invitation_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  update public.wallet_invitations set revoked_at = now()
  where id = p_invitation_id and accepted_at is null and revoked_at is null and public.is_wallet_owner(wallet_id);
  if not found then raise exception 'invitation not found' using errcode = 'P0002'; end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- Recipient: preview / accept. Both need a signed-in user and share one limit: 20 attempts per user per 15 minutes.
-- A bad, expired, revoked or used token always yields the same {ok:false}; it is returned (not raised) so that the
-- attempt stays counted instead of rolling back with the transaction.
-- ---------------------------------------------------------------------------------------------------------
create function public.preview_wallet_invitation(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
  v_wallet uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if not public.membership_rate_check('invite_attempt', 20, interval '15 minutes') then
    raise exception 'rate limit exceeded' using errcode = '54000';
  end if;
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok', false); end if;
  select w.id, w.name into v_wallet, v_name
  from public.wallet_invitations i join public.wallets w on w.id = i.wallet_id
  where i.token_hash = sha256(convert_to(p_token, 'utf8'))
    and i.accepted_at is null and i.revoked_at is null and i.expires_at > now();
  if not found then return jsonb_build_object('ok', false); end if;
  return jsonb_build_object('ok', true, 'wallet_name', v_name,
    'already_member', exists (select 1 from public.wallet_members where wallet_id = v_wallet and user_id = auth.uid()));
end $$;

create function public.accept_wallet_invitation(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_inv public.wallet_invitations;
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if not public.membership_rate_check('invite_attempt', 20, interval '15 minutes') then
    raise exception 'rate limit exceeded' using errcode = '54000';
  end if;
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok', false); end if;
  -- The row lock makes acceptance single-use: a concurrent or replayed accept waits here, then sees accepted_at set.
  select * into v_inv from public.wallet_invitations where token_hash = sha256(convert_to(p_token, 'utf8')) for update;
  if not found or v_inv.accepted_at is not null or v_inv.revoked_at is not null or v_inv.expires_at <= now() then
    return jsonb_build_object('ok', false);
  end if;
  -- Already a member: succeed without consuming the invitation.
  if exists (select 1 from public.wallet_members where wallet_id = v_inv.wallet_id and user_id = auth.uid()) then
    return jsonb_build_object('ok', true, 'wallet_id', v_inv.wallet_id, 'joined', false);
  end if;
  update public.wallet_invitations set accepted_at = now(), accepted_by = auth.uid() where id = v_inv.id;
  insert into public.wallet_members (wallet_id, user_id, role) values (v_inv.wallet_id, auth.uid(), 'member');
  return jsonb_build_object('ok', true, 'wallet_id', v_inv.wallet_id, 'joined', true);
end $$;

-- ---------------------------------------------------------------------------------------------------------
-- Remove / leave. Direct DELETE on wallet_members is closed; these are the only paths. History is untouched:
-- transactions keep created_by / paid_by_user_id. The owner can neither be removed nor leave (transfer is D6).
-- ---------------------------------------------------------------------------------------------------------
drop policy wallet_members_leave on public.wallet_members;
revoke delete on public.wallet_members from authenticated;

create function public.remove_wallet_member(p_wallet_id uuid, p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if not public.is_wallet_owner(p_wallet_id) then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_user_id = auth.uid() then raise exception 'the owner cannot be removed' using errcode = '42501'; end if;
  delete from public.wallet_members where wallet_id = p_wallet_id and user_id = p_user_id and role = 'member';
  if not found then raise exception 'member not found' using errcode = 'P0002'; end if;
end $$;

create function public.leave_wallet(p_wallet_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_role text;
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  select role into v_role from public.wallet_members where wallet_id = p_wallet_id and user_id = auth.uid();
  if v_role is null then raise exception 'not a member' using errcode = 'P0002'; end if;
  if v_role = 'owner' then raise exception 'the owner cannot leave' using errcode = '42501'; end if;
  delete from public.wallet_members where wallet_id = p_wallet_id and user_id = auth.uid();
end $$;

revoke execute on function
  public.create_wallet_invitation(uuid), public.revoke_wallet_invitation(uuid),
  public.preview_wallet_invitation(text), public.accept_wallet_invitation(text),
  public.remove_wallet_member(uuid, uuid), public.leave_wallet(uuid)
from public, anon;
grant execute on function
  public.create_wallet_invitation(uuid), public.revoke_wallet_invitation(uuid),
  public.preview_wallet_invitation(text), public.accept_wallet_invitation(text),
  public.remove_wallet_member(uuid, uuid), public.leave_wallet(uuid)
to authenticated;
