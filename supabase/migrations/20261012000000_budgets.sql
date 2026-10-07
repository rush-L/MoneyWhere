-- Phase 6: monthly budgets, one per (wallet, top-level category, month). Owner manages; any member can view.
-- Rollover, alerts and reserved funds are deliberately absent. Currency is the wallet's (PHP only today).

create table public.budgets (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references public.wallets (id) on delete cascade,
  category_id uuid not null,
  -- Canonical month = its first day (2026-10-01 means October 2026). A plain date, so no timezone can move it.
  month date not null check (extract(day from month) = 1),
  -- Safe-integer range so JS numbers round-trip exactly.
  amount_minor bigint not null check (amount_minor between 1 and 9007199254740991),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (wallet_id, category_id, month),
  -- Pins the category to the budget's wallet. NO ACTION (not RESTRICT) like transactions: deleting a category
  -- that has a budget is refused, but deleting a whole wallet (which cascades to both) still works.
  foreign key (wallet_id, category_id) references public.categories (wallet_id, id)
);

create index budgets_wallet_month_idx on public.budgets (wallet_id, month);
create index budgets_category_id_idx on public.budgets (category_id);

create trigger budgets_touch_updated_at before update on public.budgets
  for each row execute function public.touch_updated_at();

-- Budgets live on top-level categories only (their subcategories' spending rolls up in the app).
-- category_id is never updatable, so checking on insert is enough.
create function public.budgets_guard_top_level() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.categories where id = new.category_id and parent_id is not null) then
    raise exception 'a budget must use a top-level category' using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger budgets_guard_top_level before insert on public.budgets
  for each row execute function public.budgets_guard_top_level();

alter table public.budgets enable row level security;
revoke all on public.budgets from anon, authenticated;
grant select, delete on public.budgets to authenticated;
grant insert (id, wallet_id, category_id, month, amount_minor) on public.budgets to authenticated;
grant update (amount_minor) on public.budgets to authenticated;  -- wallet, category and month are the identity

create policy budgets_select_member on public.budgets for select using (public.is_wallet_member(wallet_id));
create policy budgets_insert_owner on public.budgets for insert with check (public.is_wallet_owner(wallet_id));
create policy budgets_update_owner on public.budgets for update
  using (public.is_wallet_owner(wallet_id)) with check (public.is_wallet_owner(wallet_id));
create policy budgets_delete_owner on public.budgets for delete using (public.is_wallet_owner(wallet_id));
