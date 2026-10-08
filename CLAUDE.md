# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

MoneyWhere is an offline-capable money-tracking PWA: React 19 + Vite + TypeScript frontend, Supabase (Auth, Postgres, Realtime) backend, deployed on Vercel. There is no app server and no client-side router.

Docs: `01-APP-SPEC.md` is the source of truth for what to build. `02-ROADMAP.md` items are **not** requirements until promoted into the spec. `03-CHANGELOG.md` is the history. `README.md` covers environments, Supabase/Vercel setup and the production checklist.

## Commands

```
npm run dev | build | preview | lint | typecheck      # build = tsc -b && vite build
npm test                                               # vitest run: src/**/*.test.ts + supabase/tests/**/*.test.ts
npx vitest run path/to/file.test.ts                    # single file
npx vitest run -t "name fragment"                      # single test by name
npx vitest run --config supabase/hosted/vitest.hosted.config.ts   # hosted suites (see below)
```

Node 24.x. Config is three `VITE_*` vars in `.env.local` (copy `.env.example`), public values only, baked in at build time.

## Architecture

- **`src/domain/`** — pure TS (money, balances, budgets). ESLint forbids importing React, Supabase or `lib/*` there. UI imports domain, never the reverse.
- **`src/features/<name>/`** — one folder per feature, each with the same split: pure logic (`x.ts` + `x.test.ts`), a `xService.ts` that takes a `SupabaseClient` (`createXService(client)`) and wraps its errors in a user-safe `XError`, and the React page/components.
- **`src/ui/`** — shared presentational components. `src/lib/supabase.ts` is the single client.
- **Money is integer minor units** (`10050` = ₱100.50), `*_minor bigint` in SQL; never floats.

### Offline layer (`src/features/offline/`) — the non-obvious part
Transaction writes go through an IndexedDB **outbox** (`outbox/`), not straight to Supabase. `syncEngine.ts` replays a single user's items oldest-first; `sendItem.ts` sends them via the versioned mutation RPCs (idempotent insert / versioned update / versioned delete). `projection.ts` overlays pending items on cached server data so the UI shows them immediately; `realtime/` pulls wallet changes. Outbox status machine (PENDING/SYNCING/FAILED/BLOCKED/CONFLICT) is documented at the top of `outbox/outbox.ts`; a CONFLICT means the server row changed first and the server version wins. Items are scoped by `user_id` and never sent for a different signed-in user. `fake-indexeddb` backs the tests.

### Database (`supabase/`)
- **RLS is the security boundary**; frontend checks are UX only. Membership model: `auth.users → wallet_members (owner|member) → wallet-owned rows`, checked by `security definer` helpers `is_wallet_member` / `is_wallet_owner`. See `supabase/README.md`.
- Migrations in `supabase/migrations/` are **forward-only — never edit an applied one**; add a new timestamped file. Every business table enables RLS in the same migration. Direct transaction writes are revoked; mutations go through RPCs (`transaction_mutations`, `secure_mutation_rpc`, `revoke_direct_mutation`).
- Never use the `service_role` key in the frontend or in `VITE_*` / Vercel env.

## Testing

- `npm test` also runs `supabase/tests/*.rls.test.ts`: the **real migrations and RLS executed in-process on PGlite** with a stubbed `auth` schema. Changing a migration or policy means updating/adding a test there.
- `supabase/hosted/*.verify.ts` run against a real hosted Supabase project and are deliberately excluded from `npm test`. Each script first runs `supabase/hosted/guard.mjs`, which refuses unless `.env.local`, the linked project (`supabase/.temp/project-ref`) and the approved dev project all agree. **Never link or run these against the production project** (`cleanup.mjs --apply` included); for production migrations pass `--project-ref` explicitly (`npx supabase db push --project-ref <ref> --dry-run` first).

## Rules

Workflow, slice lifecycle, completion gate, production gate and report format live in `04-LLM-IMPLEMENTATION-PLAN.md`; follow it rather than restating it here. Before non-trivial work read the relevant parts of the spec, roadmap, changelog and plan, then inspect the existing code: the repo is implementation truth, the spec is product truth.

- **Priority on conflict:** user instruction > this file > `01-APP-SPEC.md` (behavior) > `04-…PLAN` (process) > `02-ROADMAP.md` > `03-CHANGELOG.md`. If a contradiction touches behavior, security, data integrity or architecture, stop and ask; don't resolve it silently.
- **Ask vs infer:** ask when ambiguity affects financial semantics, permissions, ownership, privacy, destructive ops, offline behavior or schema; follow the existing pattern otherwise. Don't ask what the repo answers.
- **Scope:** smallest complete vertical slice. No unrelated refactors, speculative abstractions or dependency upgrades; record follow-ups instead. Reuse existing services/utilities before adding new ones.
- **Money:** integer minor units, currency explicit, reuse the existing parse/format helpers, no silent rounding, guard against overflow.
- **Authorization:** the server/RLS enforces it. Never trust client-supplied user IDs, roles, ownership or membership, hidden/disabled UI, or IndexedDB state. For any RLS change, test both allowed and denied access, including cross-wallet and former members.
- **Wallet model:** wallets are the authorization boundary. Owner and Member can both create transactions; Members edit/delete only their own; Owners manage the wallet. Don't change this without approval.
- **Transactions:** `created_by` (who recorded it) and `paid_by_user_id` (who paid/received) are separate; never overwrite creator when the payer changes. Transfers need a distinct destination account in the same wallet and have no category or payer.
- **Privacy:** return only the fields a feature needs (allowlist in exports/reports); never use elevated credentials where normal RLS access works.
- **Offline:** replay must be idempotent and authorization-safe; use stable client-generated IDs; never silently discard pending financial changes or let a destructive account operation ignore them.
- **Destructive ops** (delete transaction/account/wallet, remove member, ownership transfer, destructive migration): identify dependencies, pending offline ops and recovery/export needs; test allowed and blocked states; never silently drop financial data.
- **Verification honesty:** local, DEV and production are separate stages, and "implemented / committed / deployed / production-verified" are different states. Only claim checks you actually ran (tests, typecheck, lint, build, browser). List anything not verified under "Not verified: … Reason: …".
- **Commits:** focused, one coherent step, diff reviewed, no secrets (`.env*`, service-role keys, tokens).
- **Docs:** update the spec/roadmap/changelog/plan only when reality changed. Add a lesson here only if it is broadly reusable, not feature-specific.

## Deployment constraints

Free tiers only, no custom domain, Supabase built-in mailer (rate-limited, not suitable for public sign-ups; don't describe the app as ready for public launch). Keep "Confirm email" on. `vercel.json` sets a strict CSP — a custom Supabase domain must be added to `connect-src`. The service worker caches the app shell only.
