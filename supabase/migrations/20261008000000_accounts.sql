-- Phase 4: financial accounts inside wallets. Owner manages; any member can view.

-- Lets accounts reference (wallet_id, currency) so an account's currency can never drift from its wallet's.
alter table public.wallets add constraint wallets_id_currency_key unique (id, currency);

create table public.accounts (
  id uuid primary key,  -- client-generated (idempotent retries once offline sync exists)
  wallet_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 50),
  type text not null check (type in ('cash', 'e_wallet', 'bank', 'credit_card', 'loan')),
  -- Integer minor units. Safe-integer range so JS numbers round-trip exactly.
  opening_balance_minor bigint not null default 0
    check (opening_balance_minor between -9007199254740991 and 9007199254740991),
  holder text check (holder is null or char_length(btrim(holder)) between 1 and 50),
  -- Never client-supplied: set from the wallet by trigger, then pinned by the composite FK below.
  currency text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Only debt-like accounts may start negative.
  check (type in ('credit_card', 'loan') or opening_balance_minor >= 0),
  foreign key (wallet_id, currency) references public.wallets (id, currency) on delete cascade
);

create index accounts_wallet_id_idx on public.accounts (wallet_id);

create function public.accounts_set_currency() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select currency into new.currency from public.wallets where id = new.wallet_id;
  return new;  -- unknown wallet leaves currency NULL, which fails NOT NULL
end $$;

create trigger accounts_set_currency before insert on public.accounts
  for each row execute function public.accounts_set_currency();
create trigger accounts_touch_updated_at before update on public.accounts
  for each row execute function public.touch_updated_at();

-- Single place that answers "does this account have history?". No transactions table exists yet, so
-- this is false; the transactions migration replaces it (create or replace) to check account_id and
-- destination_account_id. No `locked` column: it would be a second source of truth.
create function public.account_has_transactions(p_account_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$ select false $$;

-- Once history exists only name/holder may change (type and opening balance feed the balance).
create function public.accounts_guard_history() returns trigger
language plpgsql as $$
begin
  if (new.type is distinct from old.type or new.opening_balance_minor is distinct from old.opening_balance_minor)
     and public.account_has_transactions(old.id) then
    raise exception 'account has transactions: type and opening balance can no longer change' using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger accounts_guard_history before update on public.accounts
  for each row execute function public.accounts_guard_history();

alter table public.accounts enable row level security;
revoke all on public.accounts from anon, authenticated;
grant select, delete on public.accounts to authenticated;
grant insert (id, wallet_id, name, type, opening_balance_minor, holder) on public.accounts to authenticated;
-- wallet_id/currency are never editable; type and opening balance are guarded by the trigger above.
grant update (name, type, opening_balance_minor, holder) on public.accounts to authenticated;

create policy accounts_select_member on public.accounts for select using (public.is_wallet_member(wallet_id));
create policy accounts_insert_owner on public.accounts for insert with check (public.is_wallet_owner(wallet_id));
create policy accounts_update_owner on public.accounts for update
  using (public.is_wallet_owner(wallet_id)) with check (public.is_wallet_owner(wallet_id));
create policy accounts_delete_owner on public.accounts for delete
  using (public.is_wallet_owner(wallet_id) and not public.account_has_transactions(id));
