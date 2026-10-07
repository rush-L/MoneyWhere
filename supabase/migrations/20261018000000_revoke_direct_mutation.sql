-- Phase 12B step 2: apply_transaction_mutation (SECURITY DEFINER, 20261017) is now the ONLY client path for UPDATE/DELETE.
-- A table-level revoke also removes the column-level UPDATE grants. This closes the stale direct UPDATE/DELETE and the
-- PostgREST upsert (insert ... on conflict do update) route, both of which skipped the version check.
-- Unchanged: SELECT and INSERT on transactions. FK cascades (wallet delete) run as the table owner and need no grant.
-- The UPDATE/DELETE RLS policies stay as defense in depth if a grant is ever restored.
--
-- Rollback (forward migration, never edit this file):
--   grant delete on public.transactions to authenticated;
--   grant update (account_id, destination_account_id, category_id, type, amount_minor, date, note) on public.transactions to authenticated;
--   grant insert (mutation_id, transaction_id, op, applied_version) on public.transaction_mutations to authenticated;
--   create policy transaction_mutations_insert_own on public.transaction_mutations for insert with check (user_id = auth.uid());

revoke update, delete on public.transactions from anon, authenticated;

-- The ledger is now written only by the function (as owner); clients keep read access to their own rows.
revoke insert on public.transaction_mutations from anon, authenticated;
drop policy transaction_mutations_insert_own on public.transaction_mutations;
