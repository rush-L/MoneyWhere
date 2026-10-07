-- Phase 8: server-side account balances. One row per account of the wallet, balance computed in SQL.
-- SECURITY INVOKER on purpose: the caller's RLS applies to accounts AND transactions, so a non-member gets
-- zero rows and no definer privilege is involved. The pure domain accountBalance() stays the correctness
-- reference; this is the optimized read path and must agree with it (see account_summaries.rls.test.ts).
create function public.account_summaries(p_wallet_id uuid)
returns table (
  account_id uuid,
  wallet_id uuid,
  account_name text,
  account_type text,
  holder text,
  currency text,
  opening_balance_minor bigint,
  current_balance_minor bigint,
  has_transactions boolean
)
language sql stable security invoker set search_path = '' as $$
  select a.id, a.wallet_id, a.name, a.type, a.holder, a.currency, a.opening_balance_minor,
         (a.opening_balance_minor + coalesce(sum(
            case
              when t.type = 'income'   and t.account_id = a.id then t.amount_minor
              when t.type = 'expense'  and t.account_id = a.id then -t.amount_minor
              when t.type = 'transfer' and t.account_id = a.id then -t.amount_minor
              when t.type = 'transfer' and t.destination_account_id = a.id then t.amount_minor
              else 0
            end), 0))::bigint,
         count(t.id) > 0
  from public.accounts a
  left join public.transactions t
    on t.wallet_id = a.wallet_id and (t.account_id = a.id or t.destination_account_id = a.id)
  where a.wallet_id = p_wallet_id
  group by a.id
  order by a.created_at, a.id
$$;
revoke execute on function public.account_summaries(uuid) from public, anon;
grant execute on function public.account_summaries(uuid) to authenticated;
