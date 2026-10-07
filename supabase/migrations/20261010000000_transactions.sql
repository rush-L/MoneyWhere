-- Phase 5B: income & expense transactions. Any member can add; owner manages all, a member only their own.
-- Transfers are Phase 5C (it adds destination_account_id and extends account_has_transactions).

-- Composite FK target so a transaction's account is pinned to the transaction's wallet.
alter table public.accounts add constraint accounts_wallet_id_id_key unique (wallet_id, id);

create table public.transactions (
  id uuid primary key,  -- client-generated (idempotent retries once offline sync exists)
  -- Never client-supplied: set from the account by trigger, then pinned by the composite FKs below.
  wallet_id uuid not null references public.wallets (id) on delete cascade,
  account_id uuid not null,
  category_id uuid,
  type text not null check (type in ('income', 'expense')),
  -- Always positive; direction comes from `type`. Safe-integer range so JS numbers round-trip exactly.
  amount_minor bigint not null check (amount_minor between 1 and 9007199254740991),
  -- The calendar day the transaction happened (the user's local day). A plain date, so no timezone shifts it.
  -- created_at is when the row was recorded, which can differ (backdated or offline entries).
  date date not null,
  note text check (note is null or char_length(note) <= 500),
  -- Never client-supplied: both are set to auth.uid() by trigger. paid_by_user_id is separate from
  -- created_by so Shared Log can later record that someone else paid.
  created_by uuid not null references auth.users (id),
  paid_by_user_id uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Expenses need a category; income has none yet (categories are expense-only).
  check (type = 'income' or category_id is not null),
  -- NO ACTION, not RESTRICT: identical for a direct delete (the delete is refused), but checked at end of
  -- statement, so deleting a whole wallet (which cascades to transactions, accounts and categories) still works.
  foreign key (wallet_id, account_id) references public.accounts (wallet_id, id),
  foreign key (wallet_id, category_id) references public.categories (wallet_id, id)
);

create index transactions_account_id_idx on public.transactions (account_id);
create index transactions_wallet_date_idx on public.transactions (wallet_id, date desc);
create index transactions_category_id_idx on public.transactions (category_id);

-- Identity and wallet come from the database, never from the request body.
create function public.transactions_set_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select wallet_id into new.wallet_id from public.accounts where id = new.account_id;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.paid_by_user_id := auth.uid();  -- ponytail: payer picker comes with member profiles
  end if;
  return new;  -- unknown account leaves wallet_id NULL, which fails NOT NULL; null uid fails NOT NULL too
end $$;

create trigger transactions_set_owner before insert or update of account_id on public.transactions
  for each row execute function public.transactions_set_owner();
create trigger transactions_touch_updated_at before update on public.transactions
  for each row execute function public.touch_updated_at();

alter table public.transactions enable row level security;
revoke all on public.transactions from anon, authenticated;
grant select, delete on public.transactions to authenticated;
grant insert (id, account_id, category_id, type, amount_minor, date, note) on public.transactions to authenticated;
grant update (account_id, category_id, type, amount_minor, date, note) on public.transactions to authenticated;

create function public.can_manage_transaction(p_wallet_id uuid, p_created_by uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_wallet_owner(p_wallet_id) or (public.is_wallet_member(p_wallet_id) and p_created_by = auth.uid())
$$;
revoke execute on function public.can_manage_transaction(uuid, uuid) from public, anon;
grant execute on function public.can_manage_transaction(uuid, uuid) to authenticated;

create policy transactions_select_member on public.transactions for select using (public.is_wallet_member(wallet_id));
create policy transactions_insert_member on public.transactions for insert
  with check (public.is_wallet_member(wallet_id) and created_by = auth.uid());
create policy transactions_update on public.transactions for update
  using (public.can_manage_transaction(wallet_id, created_by))
  with check (public.can_manage_transaction(wallet_id, created_by));
create policy transactions_delete on public.transactions for delete
  using (public.can_manage_transaction(wallet_id, created_by));

-- Replaces the Phase 4 placeholder. Phase 5C must also match a destination account here.
create or replace function public.account_has_transactions(p_account_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.transactions where account_id = p_account_id)
$$;
