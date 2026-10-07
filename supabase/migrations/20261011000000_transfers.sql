-- Phase 5C: transfers between two accounts of the same wallet, stored as ONE transactions row.
-- account_id = source, destination_account_id = destination, amount_minor > 0 (direction is implied).

alter table public.transactions drop constraint transactions_type_check;
-- Replaces the old "expense needs a category" table CHECK (unnamed, so Postgres called it transactions_check).
alter table public.transactions drop constraint transactions_check;
alter table public.transactions add constraint transactions_type_check check (type in ('income', 'expense', 'transfer'));

alter table public.transactions add column destination_account_id uuid;
-- The same wallet_id that pins account_id also pins the destination, so a cross-wallet destination is rejected.
alter table public.transactions add constraint transactions_destination_fkey
  foreign key (wallet_id, destination_account_id) references public.accounts (wallet_id, id);
create index transactions_destination_account_id_idx on public.transactions (destination_account_id);

-- A transfer moves money; nobody "paid" for it, so paid_by is NULL. created_by stays as the audit/auth identity.
alter table public.transactions alter column paid_by_user_id drop not null;

alter table public.transactions add constraint transactions_expense_category_check
  check (type <> 'expense' or category_id is not null);
alter table public.transactions add constraint transactions_shape_check check (
  case when type = 'transfer'
    then destination_account_id is not null and category_id is null and paid_by_user_id is null
         and account_id <> destination_account_id
    else destination_account_id is null and paid_by_user_id is not null
  end);

-- Same trigger, now also owns paid_by (never client-writable) and re-derives it when an edit changes the type.
create or replace function public.transactions_set_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select wallet_id into new.wallet_id from public.accounts where id = new.account_id;
  if tg_op = 'INSERT' then new.created_by := auth.uid(); end if;
  -- ponytail: payer is the creator until the payer picker exists; a transfer has no payer
  new.paid_by_user_id := case when new.type = 'transfer' then null else coalesce(new.paid_by_user_id, new.created_by) end;
  return new;
end $$;

drop trigger transactions_set_owner on public.transactions;
create trigger transactions_set_owner before insert or update of account_id, type on public.transactions
  for each row execute function public.transactions_set_owner();

grant insert (destination_account_id) on public.transactions to authenticated;
grant update (destination_account_id) on public.transactions to authenticated;

create or replace function public.account_has_transactions(p_account_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.transactions where account_id = p_account_id or destination_account_id = p_account_id
  )
$$;
