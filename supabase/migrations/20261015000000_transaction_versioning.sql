-- Phase 11B: explicit optimistic-concurrency version for transactions.
-- Starts at 1 and increments exactly once per UPDATE that really changes a client-writable business column.
-- Never client-writable (not in any insert/update column grant); updated_at stays audit/display only.

alter table public.transactions add column version bigint not null default 1;

create function public.transactions_bump_version() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.account_id, new.destination_account_id, new.category_id, new.type, new.amount_minor, new.date, new.note)
     is distinct from
     (old.account_id, old.destination_account_id, old.category_id, old.type, old.amount_minor, old.date, old.note)
  then new.version := old.version + 1;
  else new.version := old.version;  -- a no-op update (or anything touching only server fields) never moves it
  end if;
  return new;
end $$;

create trigger transactions_bump_version before update on public.transactions
  for each row execute function public.transactions_bump_version();
