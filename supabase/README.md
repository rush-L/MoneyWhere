# Supabase

- Migrations: `supabase/migrations/<UTC timestamp>_<name>.sql`, forward-only, never edit an applied one.
- Every business table: explicit FKs, indexes on FK/filter columns, CHECK constraints, **RLS enabled in the same migration**.
- Money columns: `*_minor bigint` (integer minor units) + `currency text` (wallet-level).
- Seed data: `supabase/seed.sql` (dev only, no secrets).
- Local: `npx supabase start`, `npx supabase db reset`. Never use the `service_role` key in the frontend.

## Authorization model (RLS is the boundary)
```
auth.users -> wallet_members (user_id, wallet_id, role owner|member) -> wallet-owned rows (wallet_id)
```
Accounts, transactions, budgets etc. carry `wallet_id`; policies check membership via a
`security definer` helper `is_wallet_member(wallet_id)` / `is_wallet_owner(wallet_id)`.
Members may update/delete transactions only where `created_by = auth.uid()`; owners manage wallet settings.
Frontend checks are UX only.

## Account deletion (D9)
`delete_my_account(confirmed_wallet_ids uuid[])` and `account_deletion_preview()` are the only way to delete an account; both are `SECURITY DEFINER`, `search_path=''`, authenticated only, and take no user id. `account_deletion_plan(uuid)` is an internal helper that no client role can execute. The function runs as the migration role, which can delete from `auth.users` (verified on DEV), so deletion is atomic with the data changes and needs no service role.

- Lock order: own memberships, then invitations of owned wallets, then those wallet rows (matches `accept_wallet_invitation`, so no deadlock; a join in flight either lands before the recount or fails its foreign key).
- FKs from `transactions` and `wallets` to `auth.users` stay NO ACTION on purpose: deleting a user any other way is still refused. `transactions.created_by`, `wallets.created_by` and, for income/expense, `paid_by_user_id` may be NULL (deleted account).
- `transactions_set_owner` refuses to clear an existing payer unless the transaction-local flag `app.account_deletion` is on **and** the PL/pgSQL call stack contains `delete_my_account`. The flag is set only inside that function, after its checks, and reset right after the anonymizing UPDATE. `apply_transaction_mutation` keeps a NULL payer unless the payload names a current member.
- Hosted verification: `supabase/hosted/account_deletion.verify.ts` (real `auth.users`, sessions, tokens, concurrency, 5,000-row timings).
