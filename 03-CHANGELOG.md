# Changelog

Newest first. Records implemented changes and architectural decisions.

## UI redesign, Phase B — existing screen migration (in progress)

Presentation only; no change to financial logic, services, RLS, offline or sync behaviour.

### Gate 1 — Wallets (2026-10-07, commit `5903f3d`)
- **Wallet list:** `PageHeader`, one card per wallet with name, currency and role badges (text, not colour alone) and a primary **Open** button; loading, error and empty use `State` with the existing wording; the create form uses `Section`, `Field` and `Button` with the same validation and messages.
- **Navigation:** the four per-wallet text links are replaced by **Open**, which goes to Transactions (what the first link did). Accounts, Categories and Budgets are one tab away; there is no longer a direct shortcut to them from the list. The opened wallet shows a shell header (wallet name, "← Wallets") above the Phase A tabs; one section is still mounted at a time. Until each section page is migrated, a CSS rule hides that page's own "← Wallets" link and heading so the header is not duplicated.
- **Not added:** wallet edit, delete, archive or retry on a failed wallet load (none existed). Wallet `mode` is not shown (single internal value, not user-facing today).
- **Verified:** TypeScript, lint, 308 tests, build; real signed-in hosted-dev app at 360 / 768 / 1280 with no horizontal overflow and targets of at least 44px; open, tab switching (each switch remounts), back, empty-name validation and creating a wallet. Not verified in the real app: the loading, empty and error states of the list.

### Gate 2 — Dashboard (2026-10-07)
- **UI:** `PageHeader`; wallet selector as a `Field`; three cards (month budget, balance, Needs Attention) built with `Section`. **Remaining** is the hero figure with an explicit "Over budget by ₱X" badge when negative; Budgeted and Spent sit under it; Total Balance is in its own "Balance" card so it is not read as the remaining budget. Needs Attention rows use `Meter` (fed `percentUsed` and `over` from the finance domain) plus the unchanged rounded percentage, spent / budget, and "⚠ Over budget by" or "remaining" text. Loading, error (with the existing Retry), the no-wallets message and the no-budgets message ("Go to Budgets") use `State` with the existing wording; the stale note keeps its text in a muted notice.
- **Money:** every amount now renders through `Money` (domain `formatMinor`); the local `peso` helper is gone. No arithmetic added; all values come from `buildDashboard` / `projectDashboard` as before.
- **Preserved:** wallet selection and its remembered choice, current-month scope, snapshot-first / stale-while-revalidate loading, offline messaging, remount on return from Budgets, App shell and wallet tabs.
- **Verified:** TypeScript, lint, 308 tests, build; real signed-in hosted-dev app at 360 / 768 / 1280 (no horizontal overflow, targets of at least 44px, last content clears the bottom nav at 360, content 720 / 880px wide); values matched the test data (Remaining -₱50.50, Budgeted ₱200.00, Spent ₱250.50, Total Balance ₱8749.50, Food 125%); wallet switch refreshed the data; a wallet with no accounts and no budgets showed both empty messages; offline showed the saved data with the stale note and "Offline · Showing saved data", and reconnect cleared it; Go to Budgets, Profile, Wallets and Home navigation.
- **Not verified in the real app:** the loading and load-error states of the Dashboard (same `State` primitive as elsewhere).

## UI redesign, Phase A — UI foundation & app shell (2026-10-07)

Presentation only. No change to financial formulas, transaction semantics, RLS, mutation RPCs, offline projection, IndexedDB/outbox, Realtime or authorization. No router, UI library or dark mode added. `01-APP-SPEC.md` and `02-ROADMAP.md` unchanged.

### Status: VERIFIED, READY FOR PHASE B (commit `e7852d5`)
- **Added:** CSS tokens (colour roles, 4px spacing, type, radii, widths; semantic roles only so dark mode can be added later); `src/ui/` primitives (`Button`, `Field`, `Badge`, `Money`, `PageHeader`, `Section`, `Dialog`, `State`, `Meter`); app shell (bottom nav under 640px, top nav from 640px, content max 720px / 880px from 1024px); `SyncStatus` as a badge with unchanged text; wallet section tabs (one section mounted at a time, so a tab switch remounts and reloads as before).
- **Verified (real signed-in hosted-dev app, desktop Chrome, same-origin iframes at exact widths):** 360 / 768 / 1280, no horizontal overflow, targets at least 44px, nav switch at 640, width change at 1024, bottom nav does not cover content; wallet selection and all four tabs; each tab switch remounts and refetches; real SyncStatus through synced, offline, pending, reconnect, conflict and "Keep server version"; balances and budget figures unchanged. TypeScript, lint, build PASS; 308 tests PASS.
- **Not verified (limitations, not failures):** BLOCKED state (not reproduced, no state was manufactured); `Dialog` in the signed-in app (arrives with Phase B); other-member transaction permissions in the browser (authorization code untouched); physical devices, Safari, Firefox.
- **Left for Phase B:** duplicated "← Wallets" links and section headings, old wallet-list text links, sign-in screen 420px cap.
- **Test data:** the throwaway verification user and "UI TEST Wallet" were removed with a targeted one-off delete (exact user and wallet ids, wallet had a single member). The 9 older users and 2 `mwoff…` wallets from the Phase 14 dry run were not touched; `cleanup.mjs --apply` has still not been run.

## Phase 14 — Hardening & release readiness (2026-10-07)

No new financial features, no change to financial formulas, transaction semantics, the mutation RPC, RLS or Realtime. `01-APP-SPEC.md` and `02-ROADMAP.md` unchanged.

### Status: COMPLETE (pending and deferred items documented, not failures)
- **Completed:** profile grant hardening; OAuth avatar propagation; snapshot-first / stale-while-revalidate reads; offline Categories/Budgets reads; hosted cleanup tooling (dry-run); hosted profile verification; security verification.
- **Verified:** hosted 8 files / 82 tests passed / 0 failed; TypeScript, lint and build PASS; live profile grants verified; anonymous profile access denied; column-level profile update verified; existing mutation RPC/RLS behaviour unchanged.
- **Pending:** (1) production Auth configuration, which needs the production origin/Site URL, redirect URLs, `VITE_AUTH_REDIRECT_URL`, an email-confirmation decision plus SMTP, and the Google OAuth client id/secret (see below); (2) cleanup `--apply`, awaiting explicit approval. The dry run (9 test users, 2 test wallets, associated data) is the current state and nothing has been deleted.
- **Deferred:** owner offline editing of another member's transaction, to its own phase. It needs outbox ownership/authorization state, replay-time authorization, handling a user no longer authorized, local projection of another member's transaction, and conflict/security design. The current authorization model is not weakened.

### Migrations (applied to the hosted dev project; forward-only)
- `20261019000000_profiles_grants.sql`: `profiles` was the only table still carrying Supabase's default grants (checked on the live project via `information_schema`): `authenticated` and `anon` held `REFERENCES, TRIGGER, TRUNCATE`, `anon` also `SELECT`. `TRUNCATE` is not subject to RLS, so any signed-in user could have emptied `profiles`. Now `revoke all`, then `grant select` + `grant update (display_name, avatar_url)` to `authenticated`; `anon` has nothing. The app never used the removed privileges; the signup trigger is `security definer`, and service_role is unaffected. Observable change: an anonymous read of `profiles` is now "permission denied" (42501) instead of an empty list. Every other table already had its grants reset in its own migration (verified live: only `SELECT`/`DELETE` remain where intended; `transactions` and `transaction_mutations` have `SELECT` only).
- `20261020000000_profile_avatar_from_oauth.sql`: `handle_new_user` also copies `avatar_url` or `picture` (Google) from the signup metadata into `profiles.avatar_url`, only if it already satisfies the table's https/length constraint; anything else is dropped and signup still succeeds. Existing profiles are not back-filled.

### Offline / cache
- **Stale-while-revalidate for first loads.** `readThrough(cache, key, fetcher, onSettled?)`: with `onSettled` and a snapshot, the snapshot is returned at once as `{stale: true, revalidating: true}`, the fetch runs in the background and `onSettled` gets the server data (`stale: false`) or, on failure, the same snapshot (`stale: true`). No timeout was added; supabase-js retry is untouched. Used only for the first load of Dashboard, Wallets, Accounts, Transactions, Categories and Budgets. Reloads after a sync, Realtime tick or write do not pass `onSettled` and still wait for the server, so a just-saved change is never overwritten by an old snapshot. Pending local items are still projected on top by the unchanged `projectAccounts`/`projectDashboard`/`mergeLocal`; no new calculation.
- Stale data is labelled ("Showing data saved on this device. Checking for updates…" while revalidating, "…Reconnect to refresh." once it failed or offline) and never treated as confirmed: the Transactions balance reconciliation runs only on fresh data, and the owner create/rename/delete forms on Categories and Budgets are hidden while the data is a snapshot.
- **Categories and Budgets now have offline reads** (read-only), as per-user snapshots in the existing `cache` store (`<uid>:categories:<wallet>`, `<uid>:budgets:<wallet>:<month>`), with no IndexedDB schema change. Budget spending shown offline is the saved server rows plus pending local expenses, via the existing `localSpend`.
- The "not available offline yet" messages remain only when no snapshot exists for that wallet/month.

### Hosted test cleanup
- `supabase/hosted/cleanup.mjs`: dry-run by default; `--apply` deletes. Refuses unless `--project-ref` equals both the linked project and the host in `.env.local`. Matches only `reambillo.russel+mw<letters><13-digit timestamp><suffix>@gmail.com`; deletes a wallet only if every member is a matched user; keeps any user who belongs to a wallet with a non-test member. **Not run with `--apply`** (awaiting approval). The dry run found 9 users and 2 wallets (`mwoff…-WA/-WB`, left by an earlier offline-suite run). Left untouched: the 2 `mw3a/mw3b…` users (older address format), the real users, and the wallet `try`.
- `supabase/hosted/profiles.verify.ts` (new): live grants, no direct profile insert/delete/protected-column update, anon denied, avatar copy (valid https `picture` copied, `javascript:` dropped, none).

### Production authentication: what remains (environment-specific, NOT configured here)
`supabase/config.toml` has no site URL, redirect or provider settings and none were invented. In the production Supabase dashboard:
1. Authentication → URL Configuration: set **Site URL** to the production origin and add it (and any preview origins you intend to use) to **Redirect URLs**; set `VITE_AUTH_REDIRECT_URL` in the production build to the same origin (the app already passes it as `emailRedirectTo` / OAuth `redirectTo`, falling back to `window.location.origin`).
2. Authentication → Providers → Email: decide **Confirm email**. Signup already handles both (it reports "needs confirmation" when no session is returned and detects an already-registered address). Configure custom SMTP before launch (the built-in mailer is rate-limited and for testing).
3. Authentication → Providers → Google: create the OAuth client in Google Cloud, add Supabase's callback URL (`https://<project-ref>.supabase.co/auth/v1/callback`) as an authorized redirect URI, and paste the client id/secret into Supabase.
4. Not verified: the real email-confirmation round trip and Google sign-in (they need those external settings and a real mailbox/Google account). The avatar copy is verified through the signup trigger with metadata, not through a live Google login.
- Pre-existing, not changed: a Google display name longer than 50 characters would violate `profiles_display_name_len` inside the signup trigger and fail the signup.

### Owner offline editing: deferred (decision)
Replay is own-only by design (`sendItem` always sends `ownOnly: true`; the outbox item does not record the user's role). Allowing an owner's offline edit of another member's transaction needs a new field on persisted outbox items, handling of "no longer owner at replay" (FORBIDDEN), and projection of other members' rows. That touches the in-doubt/version/ledger rules this phase must not change. Recommend its own phase. Owner edits of another member's transaction stay online-only.

### Verification
- Local: `tsc -b`, eslint and `npm run build` pass; **308 tests, 26 files** passed (301 before; new: SWR cases, per-user cache keys, profile grants, signup avatar copy).
- Hosted (`supabase/hosted/vitest.hosted.config.ts`, real dev project): after the grants migration **7 files / 80 tests passed** (535 s); final run after both migrations and all code changes **8 files / 82 tests passed**, 0 failed (549 s). Live grants checked by query after the migration.
- Browser (Chromium from the Playwright cache against the production build + service worker and the hosted dev project; throwaway user/wallet, deleted afterwards): "lie-fi" (browser online, every Supabase request held 12 s then aborted): Dashboard visible in 83 ms with the "Checking for updates…" banner, changing to "Reconnect to refresh" after the background fetch failed (was ~7 s); Categories 74 ms. Real offline cold reload: Dashboard 82 ms, Categories and Budgets rendered from snapshots with no create/rename/delete controls. IndexedDB cache keys are all prefixed with the user id.
- Not re-run in the browser this phase: pending offline items on top of a revalidating snapshot, conflict/blocked flows, user switching, a real Google/email-confirmation login. Pending/outbox/user-binding/version/idempotency behaviour is covered by the unchanged unit and hosted suites that passed.

### Remaining limitations / deferred
- Owner offline edit (above); Budgets/Categories offline are read-only (no offline writes by design); production auth settings (above); cleanup `--apply` not yet run; Budget spending still passes an empty confirmed-id list to `localSpend` (pre-existing); offline with no snapshot, a doomed request still starts and fails in the background.

## Phase 13 — Mobile, offline & UX hardening (2026-10-06)

No new financial features, no migration, no change to financial formulas or to any applied migration.

### Cleanup
- Removed the throwaway hosted data named in the brief, by id and only after listing it: wallets `Smoke 12B` and `SmokeWallet`, user `reambillo.russel+mwsmoke…`. Left alone: the real user that owned `Smoke 12B`, the wallet `try`, and the older `mw…` test users from earlier phases (not named). Phase 13's own browser users/wallet (tag `mw13…`) were deleted at the end.

### Mobile
- **Actual cause of the "Accounts" overflow:** it was never Accounts-specific. The header (brand + status + four nav buttons) was a single non-wrapping flex row about 418 px wide, so *every* page scrolled horizontally at ≤ 418 px; additionally `.card` was content-box (380 px + 40 px padding) and the Transactions form's `select` grew to its longest option text. Fixes in `index.css` only: header and nav wrap, `.card` is border-box with `width: calc(100% - 24px)`, form controls get `min-width: 0; max-width: 100%`, long text (`h2`, `p`, list rows: wallet names, e-mail) wraps. No `overflow-x: hidden`.
- Inline link-buttons now have a 44 px minimum height; a visible `:focus-visible` outline was added.
- Verified in Chromium with long wallet/account/holder names and a long e-mail: horizontal overflow is 0 on Dashboard, Wallets, Accounts, Categories, Transactions, Budgets and Profile at 320, 360, 375, 390 and 1280 px (measured `scrollWidth - clientWidth`, plus per-page screenshots reviewed at 360 and desktop).

### Offline Dashboard delay
- **Cause:** `readThrough` was network-first. Offline, supabase-js retries a failed GET with backoff (1 s + 2 s + 4 s), so the snapshot fallback only ran after ~7 s; Dashboard did that twice in sequence (wallets, then summary), and the first load also fired before IndexedDB had opened (`cache === null`), adding a second doomed request. Not IndexedDB, auth or React state.
- **Fix:** with `navigator.onLine === false` and a snapshot present, `readThrough` returns the snapshot without any request; `OfflineProvider` renders its children only once the IndexedDB open attempt has settled (milliseconds), so the first read can already use the snapshot. No timeout was added.
- **Measured (production build + service worker, Chromium network disconnect, cold reload):** 7.4 s with 4–8 failed requests → 52–85 ms with zero requests. The same projection (server baseline + pending items) is applied on top.

### Create → edit offline: now supported
- **Why it was refused before:** every offline enqueue immediately triggered a sync attempt that failed on the network; a failed attempt marks the item "may have reached the server" (`attempt_count > 0`), and such an item must not be rewritten (the 11A/11B rule, unchanged). So an offline-created transaction was never editable.
- **Decision:** the sync engine is no longer run while the browser reports offline (`OfflineProvider`), so an offline-created item keeps `attempt_count = 0` and may be folded: edit replaces the payload of the single CREATE (same UUID, still one create), projection unchanged. The in-doubt rule is untouched: once an attempt has been made (including network failure while the browser claimed to be online) the item cannot be edited, and the message now says why ("A sync was already attempted … can't be changed until the server confirms it").
- **A race this exposed and fixed:** `syncOutbox` sent the copy it listed, not the stored record. With items staying untouched for the whole offline period, an edit/remove of a later item made while an earlier one was on the wire could be lost (edit) or resurrected (remove). `markSyncing` now reads, patches and returns the stored record in one IndexedDB transaction, the engine sends that, and skips items that no longer exist. Tests cover both (the edit test fails against the old code).
- On the `online` event the provider also bumps `syncedTick`, so "Showing data saved on this device" clears even when the queue is empty.

### Offline / pending / conflict UX
- Four distinct states are shown without colour alone: confirmed server data (no badge), cached ("Showing data saved on this device. Reconnect to refresh."), pending local change (dashed card, "↻ Saved on this device · waiting to sync"), and sync issue. Wording lives in `offline/syncLabels.ts`: PENDING never attempted (editable) vs attempted (paused), SYNCING, FAILED ("will be retried automatically"), BLOCKED ("the server rejected this change … exists only on this device", Dismiss), CONFLICT ("someone changed this transaction first. The server version is shown", Keep server version). No automatic merge.
- Header: CONFLICT now counts as a sync issue (it was shown as "Pending sync"); offline with an empty queue reads "Offline · Showing saved data" instead of "✓ Synced"; the tooltip no longer shows raw `last_error` text.
- **Budgets and Categories** have no offline copy. Offline they now show "Budget data isn't available offline yet…" / "Categories aren't available offline yet…" immediately (no request, no 7 s wait, no "No budgets" and no zeros, no create form); back online they load by themselves. Dashboard with no snapshot offline says its summary isn't saved on this device yet.

### Accessibility (basic review)
- Every input/select on all pages has an associated label (checked programmatically at 360 and 1280 px); no nameless buttons; status text always carries words/icons, not colour only; keyboard Tab reaches nav/controls with a visible 3 px focus outline; inline delete confirmations have an explicit Cancel; errors use `role="alert"`.

### Verification
- Local: 301 tests (295 + 6 new: sync sends the stored record, removed item not sent, attempted item refuses edit with explanation, `readThrough` offline uses the snapshot without a request, describeSync), `tsc -b`, eslint, `npm run build` pass.
- Browser (Chromium via Playwright against the production build and the hosted dev project; offline = real network emulation, requests genuinely fail; DB results read with SQL, not UI): offline expense / income / transfer → pending, balances move, nothing sent while offline, reconnect syncs; create→edit keeps one create with the original UUID; edit and delete of a synced own transaction (version 2, row gone); conflict (A offline, owner B edits, A edits, reconnect → CONFLICT, server value kept, Keep server version clears it); user switching (A queues offline, signs out while offline, B signs in online: A's mutation not sent and still in IndexedDB; A signs back in: it syncs, `created_by` = A); Realtime + pending (write requests aborted so A keeps a pending item while the websocket stays up, B inserts, A shows B's row and the pending item with balances = server baseline + pending, then syncs); Budgets/Categories offline messages; cold open offline.
- Hosted suites (`npx vitest run --config supabase/hosted/vitest.hosted.config.ts`, real hosted dev project, final run after all Phase 13 changes): **7 files, 80 tests passed**, 0 failed (542 s).
- Cleanup confirmed by SQL: the 6 `mw13…` users, their 3 wallets and profiles are gone (0 rows). Only wallets whose members were all `mw13…` users were deleted.

### Remaining limitations
- **Browser reports online but Supabase is unreachable** ("lie-fi"): the request still waits through supabase-js's retry backoff (~7 s) before the snapshot is used. No timeout was added (brief); a stale-while-revalidate read would remove it.
- Budgets and Categories still have no offline read. Owner edits of another member's transaction remain online-only.
- Not exercised: a real touch device, screen readers, Escape-to-cancel on inline confirmations, expired-session token refresh while offline at cold start.

## Phase 12B — Secure mutation RPC; direct UPDATE/DELETE closed (2026-10-06)

### Architecture
- `apply_transaction_mutation` is now **SECURITY DEFINER** (`search_path = ''`, fully qualified names; execute for `authenticated` only) and is the only client UPDATE/DELETE path. Needed because once clients have no UPDATE/DELETE grant only a function running as another role can write, and neither column grants nor RLS can express "expected version matches". The owner bypasses RLS, so every statement is scoped explicitly: never add an unscoped query to it.
- Authorization is explicit, inside the one version-checked statement: `can_manage_transaction(wallet_id, created_by)` (owner any, member own) AND `p_own_only -> created_by = auth.uid()`. Ledger lookup is scoped to `user_id = auth.uid()`; the advisory lock key includes the user.
- Information hygiene (decided): a non-member gets CONFLICT/not_found (UPDATE) or ALREADY_GONE (DELETE) and learns nothing; a member without permission gets FORBIDDEN. The diagnostic read mirrors the SELECT policy (`is_wallet_member`).
- `transactions_wallet_immutable` trigger (migration `20261017`): a transaction never changes wallet. Definer has no RLS `WITH CHECK`, and `transactions_set_owner` re-derives `wallet_id` from `account_id`, so without this a caller could inject a row into another wallet using a foreign account id.
- Migration `20261018` revokes `UPDATE, DELETE` on `transactions` (also closes the PostgREST upsert route) and `INSERT` on `transaction_mutations`; the dead ledger insert policy is dropped. SELECT/INSERT, RLS update/delete policies (defense in depth), Realtime, account locking and the projection are unchanged. FK cascades (wallet delete) need no grant.
- Deployed in two steps: 20261017 (additive, old grants intact) was verified locally, on hosted and in the browser before 20261018 was applied.

### Rollback
Forward migration only: re-grant `delete`, the 7-column `update` list and the ledger `insert` (listed in the header of `20261018`), then `create or replace` the function back to the 11B invoker body if needed. Roll back 20261018 before 20261017.

### Known limits
- The definer owner is the migration role (RLS-bypassing); a dedicated least-privilege owner role was deferred.
- Offline own-only is enforced via the client-supplied `p_own_only`; it can only narrow, never escalate.
- `service_role` keeps Supabase's default table access (server-side only).

### Tests
- PGlite: definer/search_path, cross-wallet account injection (non-member and member-of-both), no information leak to non-members, FORBIDDEN for members, user-scoped ledger replay, former member, direct UPDATE/DELETE/upsert denied, grants and column privileges. The ~35 direct-DML RLS tests now go through the RPC.
- `npm test` 295 pass, `tsc -b`, lint, build clean.
- Hosted (DEVELOPMENT project): after 20261017 only, 7 files / 78 tests; after 20261018, 7 files / 80 tests (new: direct UPDATE/DELETE/upsert denied, grants query, anonymous RPC denied, non-member opacity, foreign-account injection). Hosted suites now mutate through `supabase/hosted/mutate.ts` (the RPC).
- Browser (Chrome, local dev server, hosted dev project): before and after the revoke: online add/edit/delete, stale-form conflict message with server value kept, Realtime refresh across two tabs, balances correct. Limitation: "offline" was simulated by overriding `navigator.onLine`; the app's sync still reached the network, so true offline queue/replay and the Keep-server-version UI were not re-exercised in the browser. They are covered by the hosted offline/mutations suites (real outbox + sync engine) and run through the same RPC.

## Phase 11B — Versioned transaction mutations + offline edit/delete (2026-10-06)

### Architecture
- `transactions.version` (migration `20261015`): starts at 1, +1 exactly once per UPDATE that changes a business column (BEFORE UPDATE trigger; no-ops and server-only touches never bump). Not writable by clients. `updated_at` stays audit/display.
- `apply_transaction_mutation` RPC + `transaction_mutations` ledger (migration `20261016`): the single UPDATE/DELETE path, online and offline. SECURITY INVOKER, so `can_manage_transaction` RLS still decides (owner any, member own); `p_own_only` (offline replay) additionally requires `created_by = auth.uid()`. Version check + authorization + write are one statement. Conflicts are returned as data (`CONFLICT`, `FORBIDDEN`, `ALREADY_GONE`, `ALREADY_APPLIED`), never as errors. Applied mutation ids are recorded, so a lost response replays as `ALREADY_APPLIED` (never a false conflict, never a second effect). Hard deletes kept: no tombstone needed.
- Outbox is a generic mutation queue: `op`, `expected_version`, `mutation_id`, `base` (the row the user saw). One open item per transaction: CREATE+edit = one CREATE, CREATE+delete = nothing queued, UPDATE+edit = one UPDATE, UPDATE+delete = one DELETE. An item that may already have reached the server (SYNCING, or attempt_count > 0) is not rewritten (`OutboxBusyError`): a lost response would otherwise swallow the new edit. New status `CONFLICT` (valid mutation, server changed first): never retried, does not stop the run, dismissed with "Keep server version" (`discard`).
- Projection: `pendingEffect()` is the one rule; balances take the superseded server rows out and replay the new state through `accountBalance()` (no second formula), the same overlay feeds the list, Accounts, Dashboard and Budgets. A stale / CONFLICT / BLOCKED item changes nothing (server row shown, flagged). Offline the item's own `base` is the baseline.
- Online edit/delete in the app now go through the RPC (`txService.update/remove` with the loaded `version`); a stale form gets `TransactionConflictError`, nothing is overwritten. If Supabase is unreachable the user's OWN change is queued with the same mutation id. Owner edits of another member's transaction stay online-only.

### Known limits
- ~~**Direct-grant limitation:**~~ (closed in Phase 12B)  Direct table UPDATE/DELETE grants remain because the current RPC is SECURITY INVOKER. Application mutation paths use the version-aware RPC, but direct database mutation remains technically possible. A future hardening phase should move mutation authorization behind a SECURITY DEFINER RPC with explicit authorization and then revoke direct UPDATE/DELETE grants. The database is NOT fully protected against stale direct mutations while these grants remain.
- A create that already had a sync attempt (even one that failed on the network) cannot be edited until it syncs: the UI says "still syncing, try again". Create+delete still cancels cleanly.
- An online edit whose reply is lost and is then retried manually uses a new mutation id and shows a (harmless) conflict; the server already holds the user's value.

### Verification
- `npm test` 286 pass (new: `supabase/tests/transaction_mutations.rls.test.ts` against PGlite, `offline/mutations.test.ts`).
- Hosted (2026-10-06, DEVELOPMENT project): migrations 20261015/20261016 applied. `mutations.verify.ts` 22/22 (anon users only; includes no-op update, spoofed payload fields ignored, account locking via RPC transfer). Re-run unchanged suites: transactions 15, transfers 7, offline 12, realtime 10, account_summaries 3, budgets 4, all pass. Test data cleaned.
- Browser (Playwright Chromium, local dev server; A member in browser, B owner as Node anon session): offline update, offline delete, update conflict, delete conflict (server version kept, "Keep server version"), create+delete (no server row), user isolation (A's queued edit not sent while B signed in, resumed on A's return), pending status, Edit/Delete hidden while syncing, local balance projection on Transactions/Accounts/Dashboard. Not verified in browser: Budgets projection (no offline read exists), create+edit while offline after a sync attempt (refused by design).

## Phase 10 — Realtime transaction invalidation (2026-10-06)

### Architecture
- Realtime is **invalidation only**. A change notification bumps the existing `syncedTick`; pages reload through their existing queries and the existing projection (server baseline + eligible outbox, `existingIds` dedupe) applies unchanged. No payload is merged into any state; no new finance math.
- **Private Broadcast, not `postgres_changes`.** `postgres_changes` applies no RLS to DELETE and cannot filter DELETE by `wallet_id`, so every subscriber would learn other wallets' deletes. Migration `20261014000000_transactions_realtime.sql`: row trigger `transactions_notify` (insert/update/delete; covers expense, income, transfer) calls `realtime.send({op}, 'tx_changed', 'wallet:<id>', private=true)` from a `security definer` function (`search_path=''`, execute revoked). Payload is the operation only. A failing send is caught (warning) and never fails the money write.
- Authorization: SELECT policy `wallet_broadcast_receive` on `realtime.messages` (`authenticated`, broadcast only, topic must match `wallet:<uuid>`, `is_wallet_member(...)`; CASE-guarded cast so a malformed topic denies). No INSERT policy, so clients cannot publish to wallet topics. Transactions RLS untouched.
- Client: `features/offline/realtime/walletChanges.ts` (`subscribeWalletChanges(client, walletId, onChange, onStatus) -> unsubscribe`; `setAuth` before join; no custom retry, realtime-js rejoins). `OfflineProvider` owns the single channel for the *watched wallet*; pages declare it with `useWatchWallet(wallet.id)` (Dashboard, Transactions, Accounts, Budgets). Events are debounced 300 ms (a 3-item sync = 3 events). After a drop and rejoin the channel invalidates once (Broadcast has no replay).
- Status `CONNECTED | CONNECTING | DISCONNECTED | ERROR` shown as a short suffix in the header (`· Live`, `· …`, `· Live off`; hidden when nothing is watched).
- Budgets now reload on `syncedTick` too (it previously did not). Every page `load` has a newest-wins guard so an older fetch resolving late cannot overwrite fresher data.

### Lifecycle
- Wallet change / page change: effect cleanup removes the old channel before the next join. Logout or user change unmounts the user-keyed `OfflineProvider`, removing the channel. Offline: no Realtime dependency; the outbox is untouched, and on reconnect the rejoin invalidates once.

### Verification
- `npm test` 246 pass (new: `walletChanges.test.ts` with a fake client — lifecycle/one channel/cleanup/status/rejoin/no-throw; trigger + policy tests in `transactions.rls.test.ts` against PGlite with a **stubbed** `realtime` schema; pending-outbox + refresh cases in `localFinance.test.ts`). The PGlite tests verify our SQL, not Supabase's service. `tsc`, `eslint`, `build` pass.
- Hosted (`supabase/hosted/realtime.verify.ts`, 3 anon users, real websockets): B's insert/update/delete of expense, income and transfer each reach A; A's own write reaches A; after unsubscribe no channel remains and nothing arrives; non-member C cannot join `wallet:WA` (private) and receives nothing; C on a non-private `wallet:WA` receives nothing; A on WA gets nothing from C's writes to WB while C receives its own; a client cannot publish into a wallet topic. Test data cleaned up.
- Browser (local dev server, real Chrome; A in the browser, B as a separate Node anon session): B insert/update/delete observed in A without refresh on Dashboard (balance, budget, spent), Transactions (rows, account balance), Budgets and Accounts; A switched to the other wallet, B wrote to Wallet A: zero new REST requests from A, then switching back showed it.

### Remaining limitations
- Not verified in the browser: pending offline item surviving a live Realtime event (covered by unit tests only); 360px layout of the header status; drop/rejoin on a real network cut.
- Realtime must stay enabled on the Supabase project; if it is off, the app works on load-on-open/reload as before.
- Pre-existing: 360px horizontal scroll on Accounts.

## Phase 9.1 — Pending-aware financial state (2026-10-06)

Scope: consistency pass. Transactions, Accounts and Dashboard now show the same locally-known balances. No Realtime, offline edit/delete, conflict resolution or retry/backoff.

### Local financial state
- `Server baseline + pending outbox items = local state`. `src/features/offline/localFinance.ts`: loaders (`loadAccounts`, `loadDashboard`: network first, per-user snapshot fallback) and pure projections (`projectAccounts`, `projectDashboard`) that reuse `localBalances` / the domain `accountBalance()` and `spendingByBudgetCategory`. No second formula; no IndexedDB/React in the projections; `src/domain` untouched.
- Pending = PENDING, SYNCING, FAILED of the current wallet. BLOCKED is never counted. FAILED means a temporary server failure that is retried on the next sync trigger, so it stays in the projection; it leaves only by syncing (record deleted) or by being marked BLOCKED (permanent rejection). Transitions are unchanged from Phase 9.
- Duplicate prevention: the baseline lists which pending ids the server already has (`transactionService.existingIds`: one ids-only query, chunked by 100, skipped when nothing is pending; stored in the snapshot for offline use). A confirmed id is not replayed: the server row wins. Spending rows now carry `id` for the same check. Account balances still come from the `account_summaries` aggregate, so no transaction history is downloaded.
- Online with an empty queue: no extra request, projection is a no-op. After a sync (`syncedTick`) pages reload and the server becomes the baseline.

### UI
- Accounts and Dashboard load through the snapshot cache (they previously failed offline) and show "Showing data saved on this device" when stale. Dashboard's wallet list uses the existing wallets cache. The Dashboard also writes the Accounts snapshot. Budgets page spending includes pending local expenses (online use only; Budgets still has no offline mode). `AccountsPage` takes `userId`.
- Budget spending: pending expenses add to their (parent) category for the month, e.g. Food 8000, server 3000 + pending 500 -> spent 3500, remaining 4500. Income and transfers are not spending.
- Reconciliation unchanged: after sync a mismatch with the displayed balances is logged and the server value kept. It is still only checked on the Transactions page.

### Tests
- Local: 231 pass (16 new in `offline/localFinance.test.ts`: expense/income/transfer, BLOCKED, SYNCING/FAILED, duplicate, other wallet, dashboard total = Accounts sum = Transactions balances, budget example, reconciliation). Typecheck, lint, production build pass. User isolation tests from Phase 9 unchanged and passing.
- Hosted (`offline.verify.ts`): 12/12 (3 new: baseline minus pending; server-committed-but-queued item counted once; after sync server is baseline, queue empty). Test data cleaned.
- Browser (production build, headless Chromium via playwright-core, real hosted user, `setOffline`): Cash 1000, Bank 5000. Offline expense 500: Transactions pending, Accounts Cash 500, Dashboard total 5500, spent 500. Offline income 100 + transfer 300 Bank->Cash: Cash 900, Bank 4700, total 5600 (unchanged by the transfer). Offline reload: same values. Reconnect: Synced, same server values on Accounts, Dashboard, Transactions and after another refresh; 3 rows, no duplicates. Test user deleted.

### Limitations
- Offline Accounts/Dashboard need one earlier online visit (snapshot). Offline-only: Budgets page, Categories.
- Reconciliation logging not shared with Accounts/Dashboard.
- At 360px width the Accounts page scrolls horizontally (`scrollWidth > innerWidth`); not investigated or fixed (no redesign this phase).
- Mismatch window: aggregate and ids query are not one atomic read; a sync finishing between them corrects itself on the next reload.

## Phase 9 — Offline create & sync (2026-10-06)

Scope: create income/expense/transfer offline, queue in IndexedDB, replay safely. No offline edit/delete, no conflict resolution, no service-worker data sync.

### Architecture
- `src/features/offline/` (no browser code in `src/domain`): `db/idb.ts` (IndexedDB v1: `outbox` + `cache`), `db/cache.ts` (per-user snapshots, `readThrough`: network first, fall back to snapshot), `outbox/outbox.ts`, `outbox/projection.ts` (pure), `sync/syncEngine.ts` + `sync/errors.ts`, `hooks/OfflineProvider.tsx`, `SyncStatus.tsx`. New dev dependency: `fake-indexeddb` (tests only).
- Flow: Transactions page -> `saveTransaction`: online with an empty queue -> Supabase directly; offline, queue non-empty, or the request fails with a network error -> outbox (same UUID) and a sync run.
- Outbox record: `seq` (auto-increment = creation order), `id` (the transaction UUID, unique), `user_id`, `wallet_id`, `created_at`, `status`, `attempt_count`, `last_error`, `payload` (the validated `NewTransaction`). No `created_by`, tokens, passwords or session are stored.
- Validation is the existing `parseTransaction`; no second validator. Replay uses the normal authenticated client, so RLS decides.

### User isolation
- Every item stores the creating user's id. A sync run is for one user and only ever *reads* that user's items (`user_id` index). User A's queue is untouched (stays PENDING) while B is signed in and resumes when A signs in again. `OfflineProvider` is keyed by user id, so a user switch remounts it.
- Per item the engine re-checks `currentUserId() === run user` (stops the run if the session changed) and `item.user_id === run user`; a mismatch is **BLOCKED (`user-mismatch`)** and never sent. `created_by` is never sent: the DB trigger sets it from the JWT.
- Deliberate reading of the spec: another user's items are *not* quarantined merely for belonging to someone else (that would make "A logs back in and resumes" impossible); they are simply not eligible. Quarantine applies to an item that reaches the sender with the wrong owner.

### Idempotency
- One UUID: local row -> IndexedDB -> insert. Never regenerated. `transactionService.send` inserts; on `23505` it selects the row: visible and `created_by` = this user -> success (earlier attempt committed); otherwise `IntegrityError` -> BLOCKED, the other row is not touched. Lost-response retry creates no duplicate.

### Statuses and retention
- PENDING (queued, or network failed, retried on reconnect), SYNCING, FAILED (temporary server error, retried on the next trigger), BLOCKED (permanent: RLS/FK/CHECK, integrity, user mismatch; never retried, stays visible), SYNCED (never persisted: record is deleted on success). A crashed SYNCING item is reset to PENDING at the next run. Network error stops the run (keeps order); a BLOCKED item does not stop later items.
- Triggers: provider start with an authenticated user, browser `online` event, after queueing. One run per user at a time; a trigger during a run schedules exactly one more. No timers/loops. `navigator.onLine` is only a UI hint; Supabase unreachable while "online" leaves the item queued.

### Local projection, balance, reconciliation
- Transactions page shows queued items on top with `↻ Pending sync` / `⚠ Sync issue`; the header shows `✓ Synced` / `↻ Pending sync (n)` / `⚠ Sync issue (n)` plus `Offline`.
- Local balance = server balance as baseline + pending items replayed through the domain `accountBalance()`; transfers move both accounts. BLOCKED items are shown but not counted. Rows already on the server win over the outbox copy (no double count).
- After a sync the page reloads the server `account_summaries`; if the balances we displayed differ, it logs `[offline] balance reconciliation mismatch` and keeps the server value. No automatic correction.
- Cached per user (wallet list; per wallet: accounts, categories, transactions) so a wallet is usable offline and after an offline refresh.

### Unsupported offline
- Edit/delete buttons are hidden while offline and on pending rows; saving an edit offline shows an error. Wallets/Accounts/Categories/Budgets/Dashboard have no offline mode (Dashboard and Accounts page do not include pending amounts).

### Tests
- Local: 215 pass (26 new: outbox, sync/idempotency/user isolation/transitions, projection with domain totals). Typecheck, lint (also removed dead code that failed lint in `account_summaries.verify.ts`), build pass.
- Hosted (`supabase/hosted/offline.verify.ts`, anon-key users only): 9/9 pass: network-down keeps items queued; reconnect syncs expense/income/transfer once each with owner = session user; server aggregate equals `accountBalance()`; lost-response retry -> one row; replay is a no-op; same-wallet member and outsider reusing a UUID -> BLOCKED, original untouched; RLS-denied account -> BLOCKED, payload unchanged; B's session does not send A's item, A does. Test data cleaned (0 leftovers).
- Browser (production build + service worker, headless Chromium via Playwright, real hosted users, network toggled with `setOffline`): offline expense/income/transfer appear with Pending status and local balances (Cash 1000 -> 500 -> 600, Bank 100), survive an offline reload, sync on reconnect, status clears, server balances equal local, 4 rows total with no duplicates after refresh. User switch: A queued offline, logged out, B signed in (nothing sent, B shows Synced), A signed back in and the item synced with `created_by` = A.

### Not verified / limits
- Not run in a headed/mobile browser; sign-out was done while offline-created, but a sign-in while offline is impossible by design. Multi-tab races are protected only by idempotency (no Web Locks). An expired access token while offline was not exercised in the browser (access token was fresh).
- Cached data for a user stays on the device after sign-out (keyed per user, unreadable by another account); clear it if that is not acceptable.
- FAILED items have no retry cap or backoff; BLOCKED items have no UI to discard them yet.

## Phase 8 — Server-side account balance aggregate (2026-10-06)

### Added
- Migration `20261013000000_account_summaries.sql` (applied to the hosted project; no earlier migration touched): `public.account_summaries(p_wallet_id uuid)` returns one row per account of the wallet: `account_id, wallet_id, account_name, account_type, holder, currency, opening_balance_minor, current_balance_minor, has_transactions` (all bigint/integer minor units; no floats).
- Formula in SQL: opening + income − expense − transfer out (`account_id`) + transfer in (`destination_account_id`). A transfer is still one row and moves two balances.
- One service call: `accountService.list(walletId)` now calls the RPC. Accounts page, Dashboard and the Transactions page account dropdown all use it; there is no second balance calculation.

### Security model
- `SECURITY INVOKER` (not DEFINER): the caller's RLS applies to `accounts` and `transactions`, so a non-member gets zero rows for a wallet id they pass. No service role anywhere; the wallet id is a filter, never a grant. `EXECUTE` revoked from `public`/`anon`, granted to `authenticated`. A test asserts `prosecdef = false`.

### Domain/SQL decision
- `accountBalance()` (pure, `src/domain/finance`) is the **correctness reference** and stays (unit tests, future offline calculation, sync reconciliation). The SQL function is the **optimized read path**. An automated parity test loads a pseudo-random dataset (5 accounts, 80 mixed income/expense/transfer rows) and asserts SQL == `accountBalance()` per account; mutating the SQL sign made 4 tests fail.
- Offline architecture (not built): offline code will use the pure finance functions locally; online reads use the aggregate; sync reconciliation can compare the two.

### Performance
- Removed the "fetch every wallet transaction, sum in the browser" path for balances (Accounts page, Dashboard, Transactions dropdown). Dashboard no longer loads transactions at all. The Transactions page still loads its own list because it displays it. No cache, no materialized view.

### Tests
- Local: 189 pass (PGlite RLS `account_summaries.rls.test.ts`: spec example A 20,000 / B 8,000, transfer both sides, empty account, negative opening, large values, parity, wallet scoping, member read, outsider/anon denied, unknown wallet empty, invoker). Typecheck, lint, build pass. `account.test.ts` now tests `accountFromSummary`; the client-side `accountFromRow` was removed.
- Hosted (`supabase/hosted/account_summaries.verify.ts`, anon-key users only): 3/3 pass: spec dataset equals `accountBalance()`, wallet scoping, member reads, outsider gets `[]`, anonymous is rejected. Test data cleaned up (0 leftovers).

### Limitations / unverified
- **Browser: NOT verified** (same reason as Phase 6: needs a signed-in hosted session; the assistant does not create accounts/enter passwords in the UI). The UI is covered by typecheck/lint/build, unit tests and the hosted RPC test only.
- Balances are returned as JSON numbers; sums beyond 2^53 would lose precision. Per-row amounts are capped at 2^53−1, so this needs implausibly large totals.
- The aggregate scans all transactions of the wallet's accounts server-side (indexed on account/destination); fine now, revisit if a wallet reaches millions of rows.

## Phase 6 — Monthly Category Budgets (2026-10-12)

### Added
- Migration `20261012000000_budgets.sql` (applied to the hosted project): `budgets(id, wallet_id, category_id, month date, amount_minor bigint, created_at, updated_at)`; `unique (wallet_id, category_id, month)`; composite FK `(wallet_id, category_id)` → `categories(wallet_id, id)` (NO ACTION, like transactions) so a budget can never use another wallet's category; `amount_minor` 1..2^53-1; indexes `(wallet_id, month)` and `category_id`.
- **Top-level rule:** `budgets_guard_top_level` insert trigger rejects a category with a parent (check_violation). Safe on insert only because category/wallet/month are not updatable and categories cannot be re-parented.
- **Month:** canonical first-of-month `date` (`2026-10-01`), CHECK `extract(day from month) = 1`. No timestamp, so no timezone can shift it. The UI month is a `YYYY-MM-01` string; month arithmetic is on numbers, and transaction dates are matched by string prefix.
- **Permissions/RLS:** RLS on. Members: select. Owner: insert/update/delete via `is_wallet_owner`. Anon/outsiders denied. Column grants: insert `(id, wallet_id, category_id, month, amount_minor)`, update `amount_minor` only (identity is immutable; to move a budget, create a new one).
- **Category deletion:** a category with a budget cannot be deleted, directly or via its parent (FK 23503); the category service message now says "transaction history or a budget". Deleting a wallet still cascades. Category archiving is still not built; budgets are another reason it may eventually be useful.
- Finance domain `budget.ts`: `calculateBudgetStatus(budget, spent)` → spent/remaining (negative when over)/`percentUsed` (unrounded)/`over`; `spendingByBudgetCategory(txs, categories, month)` maps each expense to its top-level category (own id or parent), once; ignores income, transfers and other months. Pure, no Supabase.
- `features/budgets`: `budget.ts` (mapping, month helpers, `parseBudget`, `parseBudgetAmount` reusing `parseMinor`/`assertMinor`), `budgetService.ts`, `BudgetsPage` (month navigation, progress bars, over-budget message, owner create/edit-amount/delete with confirmation, top-level-only category dropdown, members read-only), "Budgets" link per wallet.

### Spending query / scalability decision
- The service fetches only `type, amount_minor, category_id, date` of **expense** rows of **one wallet and one month** (date range filtered by the database, paged at 1000), then rolls up in TypeScript. Not the whole history. Upgrade path when a month's expense volume is large: a SQL aggregate/RPC grouped by top-level category; the domain function remains the reference for tests. Account balances are still computed client-side from the full list (unchanged).

### Verification
- Local: finance budget tests (14), feature tests, and 13 RLS tests on PGlite (owner CRUD, member read-only, outsider/anon denied, subcategory/cross-wallet/duplicate/amount/month rejected, category-delete block, wallet cascade).
- Hosted (`supabase/hosted/budgets.verify.ts`, anon-key users only): 4/4 passed. RLS and policies present, permissions as above, constraints reject bad input, category delete blocked (23503). With Food ₱8,000 and Groceries ₱3,000 + Coffee ₱500: spent ₱3,500, remaining ₱4,500; transfer, income, other-month and other-wallet expenses did not count; over-budget gives negative remaining.
- **Browser: NOT verified.** The UI needs a signed-in session against the hosted project; creating an account/entering a password there was not done by the assistant. Typecheck, lint and build cover the UI only statically.
- Also fixed three pre-existing unused-variable lint errors in `supabase/hosted/transfers.verify.ts`.

### Deferred
- Rollover, 80%/100% alerts, notifications, reserved funds, financial capacity, wishlist/event funding, subcategory budgets, copy-from-previous-month.

## Phase 5C — Transfers (2026-10-11)

### Added
- Migration `20261011000000_transfers.sql` (new; 5B migration untouched): `type` now income|expense|transfer; `destination_account_id` with composite FK `(wallet_id, destination_account_id)` → `accounts(wallet_id, id)` (same `wallet_id` that pins the source, so a cross-wallet source or destination is rejected by the database); index on the destination; `paid_by_user_id` nullable.
- CHECKs: expense needs a category; for `transfer`: destination not null, `category_id` null, `paid_by_user_id` null, `account_id <> destination_account_id`; for income/expense: destination null and payer not null. `amount_minor` stays 1..2^53-1 (positive; direction is implied by source → destination).
- `transactions_set_owner` trigger now also derives `paid_by_user_id`: NULL for transfers, else the creator; it re-derives on a type change (transfer → expense gives the creator, expense → transfer clears it). `created_by`/`wallet_id`/`paid_by_user_id` still not client-writable; only `destination_account_id` was added to the insert/update grants.
- `account_has_transactions()` matches `account_id` OR `destination_account_id`. Source and destination both lock (type/opening balance frozen, delete blocked; name/holder editable); editing or deleting the transfer unlocks them again. No `locked` column.
- RLS unchanged: members read, any member creates, owner edits/deletes any, a member only their own. Wallet delete still cascades (transfers included).
- Domain: `accountBalance()` (the only balance calculation) already handled transfers out/in; tests added. `transactionTotals` keeps transfers in their own `transfer` bucket, `spendingByCategory` ignores them.
- App: `parseTransaction` validates transfers (amount, source, destination, source ≠ destination, date, note; category dropped). `TransactionsPage`: "Transfer" type → From/To account, no category, no "Paid by", button "Add Transfer"; each account dropdown hides the account chosen in the other; list shows "↔ BPI → GCash". `accountFromRow` locks on either side. Edit/delete use the existing flow.

### Decisions
- One row per transfer in `transactions`; no transfers table, no compensating rows on delete (balance is derived from the ledger).
- A transfer is not spending: it never reaches income/expense totals, category spending, or (later) budgets.
- **Offline sync identity (architecture decision, nothing built):** offline mutation queues must be isolated by authenticated user. A mutation created by User A must never be synced while User B is signed in. `created_by` / `paid_by_user_id` stay derived server-side from the session for online writes, intentionally. For offline: every queued record is tagged with its originating user id; logout/login must not submit another user's queue; the sync layer rejects or quarantines a mutation whose originating user differs from the current session; never solve it by trusting a client-supplied `created_by`.

### Verified
- Local: typecheck, lint, build pass; 134 tests (was 119+), including 11 new PGlite transfer tests. Mutating the migration (dropping the self-transfer CHECK, dropping the destination from `account_has_transactions`) made the matching tests fail.
- Hosted (project `sitlhdkfihzmdzxfrliv`): `db push --dry-run` listed only the new migration; `db push` applied it; `migration list` local = remote (7). `supabase/hosted/transfers.verify.ts`, 7/7 passed twice, normal anon-key users (service role not used; Management API SQL only for adding members, schema inspection, cleanup): BPI → GCash moves balances and delete reverses them; same account / category / zero / negative / missing destination rejected; cross-wallet source and destination rejected; spoofed `wallet_id`/`created_by`/`paid_by_user_id` rejected; owner and member permissions (member cannot edit or delete another's transfer); anon and outsider denied; both accounts lock and unlock; wallet delete cascades; schema constraints present. No test data left (0 wallets/users/transactions).
- Browser (Chrome, `localhost:5173`, owner session, hosted DB): Transfer type shows From/To and no category/Paid by; destination list excludes the source; "Choose the account to transfer to." and "Amount must be greater than zero." shown; ₱3,000 BPI → GCash saved, list shows "↔ BPI → GCash", balances 20,000 → 17,000 and 5,000 → 8,000; refresh preserved it; edit to 4,000 → 16,000 / 9,000; delete → 20,000 / 5,000. Temp wallet removed.

### Not verified / open
- Browser: "transfers excluded from expense totals" is covered by domain tests only (the UI shows no totals yet); member (non-owner) view and phone layout untested; the explicit locked-account message in the Accounts UI after a transfer was not clicked through (covered at DB level, hosted and local).
- A transfer cannot swap source/destination in one edit step in the UI (each dropdown hides the other's choice); change one side, then the other.
- Balances are still computed client-side from all wallet transactions (paged by 1000).

## Phase 5B — Income & Expense Transactions (2026-10-10)

### Added
- Migration `20261010000000_transactions.sql`: `transactions` (client UUID `id`, `account_id`, nullable `category_id`, `type` income|expense, `amount_minor` bigint 1..2^53-1, `date`, `note` ≤500, `created_by`, `paid_by_user_id`, timestamps). Expense requires a category; income's is nullable.
- Denormalised `wallet_id`, set by trigger from the account and pinned by composite FKs `(wallet_id, account_id)` → accounts and `(wallet_id, category_id)` → categories, so a cross-wallet account or category is rejected by the database. Added `accounts unique (wallet_id, id)`.
- `created_by` / `paid_by_user_id` are set to `auth.uid()` by trigger and are not insertable or updatable by clients.
- RLS: members read; any member inserts; owner updates/deletes any, a member only rows with `created_by = auth.uid()` (`can_manage_transaction`). `anon` has nothing.
- `account_has_transactions()` now checks `transactions.account_id`: type/opening balance lock, account delete blocked (Phase 5C must add `destination_account_id`).
- Finance domain: `Transaction` trimmed to ledger fields; `spendingByCategory()`. `accountBalance()` is the only balance calculation; `accountFromRow` now receives the account's transactions.
- `features/transactions` (validation, service with paged list, `TransactionsPage`); "Transactions" button per wallet. Category delete on FK violation shows "This category has transaction history and cannot be deleted."

### Decisions
- **`date` is a Postgres `date`** (the user's calendar day, no timezone shift), labelled "Transaction Date" in the UI; `created_at` is when it was recorded. (The brief's section 16 was cut off; revisit if a time of day is required.)
- Category/account FKs are `NO ACTION`, not `RESTRICT`: same refusal on direct delete, but deleting a whole wallet (cascade) still works.
- Category archiving is not implemented; it may be introduced later.
- Balances are computed client-side from all wallet transactions (paged by 1000). Move to a server-side aggregate if wallets get large.
- Payer is always the creator ("Paid by: Me"); the payer picker waits for member profiles.

### Hosted verification (2026-10-06 host clock; project `sitlhdkfihzmdzxfrliv`)
Script: `supabase/hosted/transactions.verify.ts` (run `npx vitest run --config supabase/hosted/vitest.hosted.config.ts`; not part of `npm test`). 15/15 passed, run twice. Normal users are anon-key sign-ups; the service role was not used. Management-API SQL (`supabase db query --linked`) was used only to add members (no client path yet), inspect the schema, and clean up.
- **Migration:** `db push --dry-run` listed only `20261010000000_transactions.sql`; `db push` applied it; `migration list` shows all 6 local = remote.
- **Schema:** columns, uuid PK, composite FKs `(wallet_id, account_id)` / `(wallet_id, category_id)`, `wallet_id` → wallets ON DELETE CASCADE, `created_by`/`paid_by_user_id` → auth.users, CHECKs (amount 1..2^53-1, type income|expense, expense needs category, note ≤500), RLS on, 4 policies, `anon` has no grants, `authenticated` has only select/delete + column-level insert/update.
- **Owner:** create, read, edit own, edit a member's, delete own, delete a member's: all passed.
- **Member (two members + owner):** create, read wallet, edit own, delete own passed; editing or deleting another member's or the owner's transaction affected 0 rows and the rows were unchanged.
- **Cross-wallet:** A could not read, update or delete Wallet B rows; inserts with a B account, a B category, or a mix were rejected; moving an own transaction onto a B account/category was rejected.
- **Anonymous:** select returned nothing; insert, update, delete were denied.
- **Server-controlled identity:** supplying `created_by`, `paid_by_user_id` or `wallet_id` on insert, or changing them (or `id`) on update, was rejected; rows carry the caller's uid and the account's wallet.
- **Account locking:** `account_has_transactions` false → true after the first transaction; type and opening balance change blocked ("account has transactions: …"), delete blocked, name and holder editable; with no transactions type/opening edit and delete work; removing the history unlocks again.
- **Financial (via `accountBalance`):** 10,000 − 2,000 = 8,000; 10,000 + 5,000 = 15,000; 10,000 + 5,000 − 2,000 = 13,000.
- **Categories:** deleting a category with history fails with FK 23503, which `categoryService` maps to "This category has transaction history and cannot be deleted."; an unused one deletes.
- **Cascades:** deleting a wallet removed its transactions, accounts, categories and members (counts 1/1/seeded/1 → 0); deleting an account or category with transactions was blocked beforehand.
- **Offline-ready fields:** client-supplied uuid `id` (no default), `created_at`/`updated_at` timestamptz with `now()` defaults. No sync status or IndexedDB added.
- **Cleanup:** all test wallets and users (tag `mwtx…`) deleted by the script; checked afterwards: 0 matching users, 0 wallets, 0 transactions remain. Earlier manual sign-ups from the Auth phase were not touched.
- **Browser (Chrome extension, `localhost:5173`, the already-signed-in dev session, hosted DB), all passed:** Transactions page loads; empty state ("No transactions yet. Add an account first (owner)…"); validation messages ("Choose an account.", "Choose a category for the expense.", "Amount must be greater than zero."); Add Expense ₱2,000 appears in the list and the account goes ₱10,000 → ₱8,000; Add Income ₱5,000 (category field hidden, shows "—") → ₱13,000; refresh preserves both; Edit 2,000 → 3,000 → ₱12,000; Delete (in-page confirm) → ₱15,000; deleting a category with history shows "This category has transaction history and cannot be deleted." Temp wallet `UI-VERIFY-TEMP` was removed afterwards (0 wallets/transactions left).
- **Still not verified in a browser:** member/non-owner views (only the owner session was available) and the phone-width layout.

## Phase 5A — Categories (2026-10-09)

### Added
- Migration `20261009000000_categories.sql`: `categories` (`id` uuid default `gen_random_uuid()`, `wallet_id` → wallets ON DELETE CASCADE, nullable `parent_id`, `name` 1–50 after trim, timestamps). Composite FK `(wallet_id, parent_id)` → `categories(wallet_id, id)` keeps a subcategory in its parent's wallet; a BEFORE INSERT trigger limits depth to two levels. Indexes on `wallet_id`, `parent_id`, and unique `(wallet_id, lower(btrim(name)))`.
- RLS: members read; owner inserts, renames and deletes (`is_wallet_member` / `is_wallet_owner`). Column grants: insert `id, wallet_id, parent_id, name`; update `name` only (no re-parenting, no moving between wallets). `anon` has nothing.
- `seed_default_categories(wallet_id)` (SECURITY DEFINER, execute revoked from all client roles) holds the single definition of the starter set: Food, Transportation, Bills, Lifestyle with the 13 subcategories from the spec (17 rows). `create_wallet()` replaced to call it, so wallet + owner membership + defaults stay one atomic statement; existing wallets were backfilled by the same migration.
- `features/categories`: mapping, name validation, grouping, `categoryService` (list/create/rename/remove, duplicate → friendly message), `CategoriesPage` (loading/empty/error, add form with optional parent, inline rename, delete confirmation); "Categories" button per wallet in `WalletsPage`.

### Decisions
- **Wallet-scoped**, no global or shared categories.
- **Expense-only:** no `type` column and no income categories; add a CHECK-ed column when income is specified.
- **Names unique per wallet across both levels**, case/whitespace-insensitive, enforced by the index. Consequence: "Other" cannot exist under two parents.
- **Two levels only**; parents delete their subcategories (cascade). No sort column; UI sorts by name.
- **Defaults are server-side only**; the frontend has no creation logic. Changing the starter set affects new wallets only.
- **Future delete rule (Phase 5B):** transactions/budgets must reference `categories(id)` with ON DELETE RESTRICT, which also blocks deleting a parent whose child is in use. Once referenced, a category must not be deletable in a way that destroys historical meaning (options: block, or archive/soft-delete). Not decided here.

### Verified
- Local: typecheck, lint, 90 tests (20 new: mapping/validation/grouping, plus PGlite defaults, owner/member/outsider/anon RLS, constraints, duplicates, cross-wallet parent, depth, cascade), build pass.
- Hosted (project `sitlhdkfihzmdzxfrliv`): `db push --dry-run` listed only the new migration; `db push` applied it; `migration list` local = remote. Live supabase-js script, two real users, 20 checks passed (17 defaults per new wallet, cross-wallet read/create/rename/delete denied, duplicate → 23505, owner rename/delete, `wallet_id` not updatable, name limits, nesting rejected, anon denied, seed function not callable). Test wallets deleted; two test users (`reambillo.russel+mwcat…`) remain in Authentication.

### Not verified
- **Browser: not performed.** The Playwright browser (Chrome) is not installed here and sign-in is manual. Checklist still to do by hand: defaults appear, add/rename/delete, duplicate error text, refresh persistence.
- **Member role on hosted** (no invite flow yet): PGlite only.
- **Backfill of pre-existing hosted wallets** was not inspected directly.

## Phase 4 — Accounts (2026-10-08)

### Added
- Migration `20261008000000_accounts.sql`: `accounts` (client UUID id, `wallet_id`, name 1–50, `type` cash|e_wallet|bank|credit_card|loan, `opening_balance_minor` bigint, optional `holder` 1–50, `currency`, timestamps). RLS: members read; owner creates, edits and deletes (see mutability below).
- `features/accounts`: row mapping (current balance via the existing `accountBalance`), input validation, `accountService` (list, create, update, remove), `AccountsPage` (list, create/edit form, inline delete confirm, owners only); "Accounts" button per wallet in `WalletsPage`.
- Tests: `account.test.ts`, `supabase/tests/accounts.rls.test.ts` (70 total pass; typecheck + lint clean).

### Decisions
- **Currency enforced in the DB:** a trigger copies the wallet's currency on insert, `currency` is not insertable/updatable by clients, and a composite FK `(wallet_id, currency)` → `wallets(id, currency)` pins it. No picker in the UI.
- **Owner-only create/update:** accounts are wallet structure; members only view. Spec has no account permissions, so this is the conservative reading — loosen the policy if members should add accounts.
- **Only credit_card/loan may start negative** (CHECK + client validation).
- **Mutability depends on history:** before the first transaction the owner may edit name/type/opening balance/holder and delete; after it only name/holder, no delete. Implemented as `public.account_has_transactions(uuid)` (returns `false` now; the Transactions migration must `create or replace` it to check `account_id` and `destination_account_id`) used by a BEFORE UPDATE trigger (blocks type/opening-balance changes) and the delete policy. No `locked` column (second source of truth). `wallet_id`/`currency` never editable. Wallet deletion still cascades. UI: `Account.hasTransactions` (hard-wired `false` until Transactions) disables type/opening balance and hides Delete.
- **Credit Card/Loan semantics deferred:** negative opening balance is allowed for them, but liability/accounting meaning and balance calculation are unchanged and will be settled in their own phases.
- **Holder is free text**; no link to profiles/members.

### Hosted verification (project `sitlhdkfihzmdzxfrliv`, 2026-10-06 clock)
- `db push --dry-run` listed only `20261008000000_accounts.sql`; `db push` applied it; `migration list` shows all four local = remote. (The migration was edited before applying to add the mutability rule; it was never applied in its earlier form.)
- Schema query: RLS on; policies select/insert/update/delete; triggers `accounts_guard_history`, `accounts_set_currency`, `accounts_touch_updated_at`; `authenticated` has SELECT, DELETE, column-level INSERT/UPDATE only; `anon` has nothing.
- Live supabase-js script with two real users: 15/15 passed (owner create/edit/delete, currency from wallet, client currency and `wallet_id` updates denied, negative cash rejected, negative credit card allowed, outsider/anon read/insert/update/delete denied). Test wallet deleted; two test users (`reambillo.russel+mwacc…`) remain in Authentication → Users.

### Not done / not verified
- **Member role on hosted:** no invite flow exists yet, so member behaviour is covered only by the PGlite tests.
- **"Has transactions" branch:** exercised in PGlite by swapping the check function to `true`; there is no transactions table to test it against yet.
- **Accounts UI in a browser: not verified.** Page loads to the sign-in screen, but sign-in/sign-up was left to the project owner. To check: create, edit all fields, delete (Confirm delete), a negative Credit Card balance, a negative Cash balance error.

## Phase 3 — Wallets, Shared Log only (2026-10-07)

### Added
- Migration `20261007000000_wallets.sql`: `wallets` (name 1–50, `currency` CHECK `PHP`, `mode` CHECK `shared_log`, `created_by`), `wallet_members` (PK `wallet_id,user_id`, role owner|member, index on `user_id`, partial unique index = one owner per wallet), `touch_updated_at` trigger, helpers `is_wallet_member` / `is_wallet_owner`, RPC `create_wallet(p_name)`.
- RLS: members read their wallets and co-members; owner may rename (column grant: `name` only) and delete; a member may leave (owner may not). No client INSERT/UPDATE on memberships and no direct INSERT on wallets.
- `features/wallets`: row mapping, name validation, `walletService` (list, create), `WalletsPage` (list with role, create form, loading/empty/error states); header nav Wallets | Profile.
- `supabase/tests/wallets.rls.test.ts` (14 tests).

### Decisions
- **Creation only via `create_wallet` (SECURITY DEFINER):** wallet + owner membership are atomic, so there is no state where a wallet has no owner and clients cannot self-assign roles.
- **Helpers are SECURITY DEFINER with empty `search_path`:** avoids RLS recursion on `wallet_members`; they only answer for `auth.uid()`; execute revoked from `anon`/`public`.
- **Grants start from `revoke all`:** new tables don't inherit Supabase's default TRUNCATE/TRIGGER/REFERENCES (the Phase 2 gap is *not* fixed for `profiles`).
- **Currency and mode are CHECKs, not enums:** widening later is a one-line migration. UI shows PHP as fixed; there is no currency picker until a second currency exists.
- **Deferred:** invitations/adding/removing members, ownership transfer, archive, seeing co-members' profile names (profiles SELECT is still own-row only), wallet rename UI.

### Verified
- Local: typecheck, lint, 55 tests (14 new RLS tests on PGlite, 3 mapping/validation), build all pass. Loosening the wallet SELECT/UPDATE policies to `true` made 5 RLS tests fail.
- Hosted dev project (Claude, supabase-js, anon key, two fresh users): migration previewed with `--dry-run`, applied with `db push`, `migration list` shows all three local = remote. 17/17 live checks passed: create, list with role, outsider cannot read/rename/delete wallets or read members, cannot self-join or change roles, direct inserts denied, anon denied, name limit, owner rename + `updated_at`, `currency` not updatable, owner cannot leave, owner delete.

### Not verified
- Member (non-owner) behavior on the hosted project: only PGlite covers it, because adding a member needs the invitation feature or a service-role key.
- Wallets UI not exercised in a browser.
- Remote catalog (policies/grants) not inspected directly; behavior was tested instead. The two new live users remain in the project (delete under Authentication → Users).

## Phase 2 verification — hosted Supabase (2026-10-06)

Full detail and per-item "who checked" in `supabase/VERIFICATION.md`. This resolves the "Limitations / unverified" list under Phase 2 below, except where noted there.

### Fixed
- `index.html`: static "Loading…" inside `#root`. On slow networks the page was blank white until the JS bundle loaded, since the only loading state was React code.

### Verified
- Both migrations applied to the hosted project; remote schema (RLS, policies, triggers, constraints, column grants) matches the migrations.
- 15/15 live checks with two real users (trigger-created profiles, own-row reads, update + `updated_at`, A cannot touch B, protected columns, insert/delete denied, constraints, anon sees nothing).
- Browser flow (manual): sign-up, sign-in, refresh persistence, profile edit, sign-out, loading state (after fix). Google sign-in works and creates a profile.

### Still open
- Email-confirmation flow untested; Google avatar not copied to `avatar_url`; table-level TRUNCATE/TRIGGER/REFERENCES grants to `anon`/`authenticated` remain; production URLs not configured.

## Phase 1 — Foundation (2026-10-06)

### Documentation correction
- Canonical names set: `01-APP-SPEC.md` (renamed, content untouched), `02-ROADMAP.md`, `03-CHANGELOG.md`; duplicates removed.
- `02-ROADMAP.md` could **not** be restored: the stub was empty and the full roadmap was not available in the project. It is now a marked placeholder awaiting the real content.

### Added
- Vite + React + TypeScript (strict, `noUncheckedIndexedAccess`), ESLint, Vitest; scripts: dev, build, preview, test, test:watch, lint, typecheck.
- PWA via `vite-plugin-pwa` (manifest, generated service worker, app-shell precache, placeholder icons). No data sync.
- Supabase client (`src/lib/supabase.ts`, null when env is unset), `.env.example`, `supabase/migrations/`, initial `profiles` migration with RLS.
- Pure finance domain (`src/domain/finance`): `Transaction` model, `accountBalance`, `transactionTotals`, money helpers; 14 unit tests.

### Decisions
- **Vite + React + TS:** PWA-friendly SPA, no SSR needed, fast tests/builds.
- **Supabase:** Postgres + Auth + RLS + Realtime + Storage cover the security/sync needs without a custom backend.
- **Integer minor units:** no float rounding errors; `assertMinor` rejects non-integers and unsafe overflow. `parseMinor`/`formatMinor` are string-based.
- **Client-generated UUIDs for transactions:** the future offline queue can retry inserts idempotently (`insert ... on conflict (id) do nothing`).
- **RLS is the authorization boundary:** user → wallet membership → wallet-owned rows (see `supabase/README.md`). Frontend checks are UX only.
- **Domain purity enforced** by an ESLint `no-restricted-imports` rule on `src/domain/**`.
- **Transactions:** `amount_minor` always positive; direction derives from `type`. Transfer = one row with `account_id` (source) and `destination_account_id`.
- **Split Mode deferred:** needs a member/share model; Shared Log (who paid) is enough for first shared wallets.
- **Offline sync deferred:** no transactions exist yet to sync. Planned conflict rule (not built): each row has `updated_at` + integer `version`; server applies an update only if client `base_version` equals current, else rejects and the client refetches; deletes are soft (tombstones); creates are idempotent by UUID. Deterministic, no merge engine.
- Dropped the `idb` dependency until the offline phase needs it.

## Phase 2 — Authentication & Profile (2026-10-06)

### Added
- `features/auth`: `authReducer` (LOADING / AUTHENTICATED / UNAUTHENTICATED, one source of truth in `AuthProvider`), `authService` (email/password, Google OAuth, sign-out, session listener), validation, error mapping (raw Supabase messages go to console only), `AuthScreen`.
- `features/profile`: row→domain mapping, input validation, `profileService`, `ProfilePage` (display name + avatar URL), minimal header with Profile / Sign out.
- Migration `20261006010000_profiles_hardening.sql` (new file; Phase 1 migration untouched): `updated_at` trigger (it never changed before), CHECKs (name 1–50 chars, avatar must be `https://`), column-level grant so clients can update only `display_name`/`avatar_url`, insert/delete revoked.
- `supabase/tests/profiles.rls.test.ts`; `@electric-sql/pglite` dev dependency.

### Decisions
- **Supabase Auth only:** no password handling or identity table of our own; `profiles.id` = `auth.users.id`, created by trigger.
- **Avatar = https URL, no upload:** upload needs Storage buckets/policies that belong with receipt storage; the `https` CHECK blocks `javascript:`/`data:` URLs.
- **Identity from session:** services take the user id from the session; RLS is what enforces it.
- **Redirects:** `VITE_AUTH_REDIRECT_URL`, defaulting to `window.location.origin`; nothing hardcoded.
- **Password minimum 8** client-side; the server-side minimum is set in the Supabase dashboard.
- **Existing-email sign-up:** detected via empty `identities` (Supabase's anti-enumeration response when confirmation is on).

### Tests
- 37 pass: finance (14), auth state/validation/errors/service with a fake client, profile mapping/validation, and 8 RLS tests (own read/update, cannot read or update other user, no insert/delete, protected columns, anon sees nothing, constraints, trigger-created profile, `updated_at` moves). Mutating the SELECT policy to `true` made 3 of them fail, so they do exercise the policies.

### Limitations / unverified
- RLS ran on plain Postgres (PGlite) with a stubbed `auth` schema and `auth.uid()` — real policies and triggers, but not hosted/local Supabase (no Docker or project available).
- Not run against a real Supabase project: sign-up, sign-in, sign-out, session persistence on refresh, Google OAuth (needs dashboard + Google Cloud setup, see README), email confirmation. UI was not exercised in a browser.
