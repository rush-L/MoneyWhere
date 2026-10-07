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
