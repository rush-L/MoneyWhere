-- Phase 5A: wallet-scoped expense categories (two levels: category -> subcategory). Owner manages; any member can view.
-- Expense-only: no income categories and no `type` column until income is specified (add a CHECK-ed column then).

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references public.wallets (id) on delete cascade,
  parent_id uuid,
  name text not null check (char_length(btrim(name)) between 1 and 50),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A subcategory must live in its parent's wallet; deleting a parent deletes its subcategories.
  -- (Transactions/budgets will reference categories with ON DELETE RESTRICT, which blocks both deletes.)
  unique (wallet_id, id),
  foreign key (wallet_id, parent_id) references public.categories (wallet_id, id) on delete cascade
);

create index categories_wallet_id_idx on public.categories (wallet_id);
create index categories_parent_id_idx on public.categories (parent_id);
-- One name per wallet at any level, case-insensitive. Different wallets may reuse names.
create unique index categories_wallet_name_key on public.categories (wallet_id, lower(btrim(name)));

create trigger categories_touch_updated_at before update on public.categories
  for each row execute function public.touch_updated_at();

-- Two levels only: a parent may not itself have a parent. (parent_id is never updatable, so insert is enough.)
create function public.categories_guard_depth() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.parent_id is not null
     and exists (select 1 from public.categories where id = new.parent_id and parent_id is not null) then
    raise exception 'subcategories cannot have subcategories' using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger categories_guard_depth before insert on public.categories
  for each row execute function public.categories_guard_depth();

alter table public.categories enable row level security;
revoke all on public.categories from anon, authenticated;
grant select, delete on public.categories to authenticated;
grant insert (id, wallet_id, parent_id, name) on public.categories to authenticated;
grant update (name) on public.categories to authenticated;  -- no re-parenting, no moving between wallets

create policy categories_select_member on public.categories for select using (public.is_wallet_member(wallet_id));
create policy categories_insert_owner on public.categories for insert with check (public.is_wallet_owner(wallet_id));
create policy categories_update_owner on public.categories for update
  using (public.is_wallet_owner(wallet_id)) with check (public.is_wallet_owner(wallet_id));
create policy categories_delete_owner on public.categories for delete using (public.is_wallet_owner(wallet_id));

-- The one definition of the starter set. Internal: not callable by clients, only from create_wallet / this migration.
create function public.seed_default_categories(p_wallet_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  defaults constant json := '{
    "Food": ["Groceries", "Restaurants", "Coffee"],
    "Transportation": ["Fuel", "Public Transportation", "Ride Sharing"],
    "Bills": ["Electricity", "Water", "Internet", "Phone"],
    "Lifestyle": ["Entertainment", "Shopping", "Hobbies"]
  }';
  parent record;
  pid uuid;
begin
  for parent in select key, value from json_each(defaults) loop
    insert into public.categories (wallet_id, name) values (p_wallet_id, parent.key) returning id into pid;
    insert into public.categories (wallet_id, parent_id, name)
      select p_wallet_id, pid, json_array_elements_text(parent.value);
  end loop;
end $$;

revoke execute on function public.seed_default_categories(uuid) from public, anon, authenticated;

-- Same as Phase 3 plus the seed call, so wallet + owner + defaults are one atomic statement.
create or replace function public.create_wallet(p_name text) returns public.wallets
language plpgsql security definer set search_path = '' as $$
declare
  w public.wallets;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  insert into public.wallets (name, created_by) values (btrim(p_name), auth.uid()) returning * into w;
  insert into public.wallet_members (wallet_id, user_id, role) values (w.id, auth.uid(), 'owner');
  perform public.seed_default_categories(w.id);
  return w;
end $$;

-- Wallets that already exist get the same starter set.
select public.seed_default_categories(id) from public.wallets;
