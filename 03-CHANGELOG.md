# Changelog

Newest first. Records implemented changes and architectural decisions.

## Production migration D4–D7 (2026-10-08)

The D4–D7 code was pushed to `main` (`e398af5..e9fe878`) and auto-deployed to production before production had the migrations, so the database was behind the deployed app for a short window. Production Supabase (`zoyauiojqpcglyhxzzkh`) was at `20261022000000` (18 migrations, history identical to the repository).

- **Applied to production:** `20261023000000_membership.sql`, `20261024000000_co_member_visibility.sql`, `20261025000000_ownership_transfer.sql`, `20261026000000_who_paid.sql`, in that order, with `supabase db push --project-ref zoyauiojqpcglyhxzzkh` after a dry run that listed exactly those four. No migration file was edited; no seeds or roles changed.
- **History check:** `supabase migration list` shows 22 local / 22 remote, no gaps and no unexpected versions.
- **Production smoke test (manual, by the project owner, reported as passed):** sign-in; existing wallets, accounts and transactions visible; expense creation; Who Paid on expenses; Received by on income; transfer without a payer; payer/recipient edit persists; temporary test transactions removed; no unexpected data changes observed. Invitation, remove/leave and ownership-transfer flows were not separately reported.
- **Not done:** no backup or restore point was confirmed before the push (not reported).
- D8 is not started.

## Phase D7 — Who Paid / Received by (2026-10-08)

Implements `01-APP-SPEC.md` section 9.1. D8 and later are not started. Migration `20261026000000_who_paid.sql` is applied to the DEV project only (`sitlhdkfihzmdzxfrliv`); production untouched.

- **Before D7:** `paid_by_user_id` was stored but forced to the creator by trigger; the UI only printed "Paid by: Me".
- **UI:** Expense create/edit shows **Who Paid**, Income shows **Received by** (a select of current members, "You" first and selected by default). Transfers show neither. The list reads "Paid by: X" (expense) / "Received by: X" (income), resolved through the D5 member list, so a payer who has left shows **Former member**. An edit keeps a departed payer as "Former member" rather than reassigning it.
- **Database:** `paid_by_user_id` is now insertable. `transactions_set_owner` validates it on every write path (direct insert and `apply_transaction_mutation`): when set or changed it must be a current member of the transaction's own wallet (derived from the account), otherwise `42501`. An unchanged historical payer is not re-validated, so editing an old transaction does not rewrite history; assigning a former member is always refused. Transfers force NULL. `created_by` is still set by the database only. `apply_transaction_mutation` now reads `paid_by_user_id` from the payload (absent keeps the stored one, so edits queued before D7 stay valid). The version trigger now counts a payer change as a change.
- **Offline:** the outbox payload carries `paid_by_user_id`; the local projection shows the chosen payer. No new offline infrastructure; offline the selector offers only "You".
- **Tests changed:** assertions that "paid_by_user_id cannot be set" (local and hosted) now assert the D7 rule instead; outsider inserts are rejected by the payer trigger before RLS (message differs, still rejected).
- **Tests added:** `supabase/tests/who_paid.rls.test.ts`, parse/projection unit tests, `supabase/hosted/who_paid.verify.ts` (15 tests, passing on DEV). Dashboard and budget code untouched.

- **Verification status:** implementation complete. Local: 493 tests, typecheck, lint, build pass. Hosted DEV: 37/37 checks pass (`who_paid`, `transactions`, `transfers` suites); the DEV test data was removed afterwards. **Manual smoke tests (2026-10-08, run by the project owner against DEV, reported as passed or as expected):** browser (Expense/Income/Transfer forms, payer in list, former-member display) and offline runtime. These were run by a human; the automated agent could not sign in. No production verification is claimed.

## Phase D6 — Ownership transfer (2026-10-08)

Implements `01-APP-SPEC.md` section 6.4. D7 and later are not started. Migration `20261025000000_ownership_transfer.sql` is applied to the DEV project only (`sitlhdkfihzmdzxfrliv`); production untouched.

- **RPC:** `transfer_wallet_ownership(wallet, new_owner)` (`SECURITY DEFINER`, `search_path = ''`, execute revoked from `public`/`anon`). Caller must be the current owner; the target must be a current plain member of that wallet; self-transfer is refused. It locks the owner row and the target row, then demotes and promotes in one transaction (the one-owner unique index is never violated). Only `wallet_members.role` changes. No schema, RLS or grant changes: clients still cannot write `wallet_members`.
- **Concurrency:** a second transfer by the same owner waits on the row lock, then fails the owner check. Verified on DEV with two simultaneous requests (exactly one wins, one owner remains).
- **UI:** Members tab, owner only: pick a current member, confirm ("X will become the Owner. You will become a Member."). On success the page switches to the Member view. Online only, no outbox, no optimistic role change.
- **Tests:** `supabase/tests/ownership_transfer.rls.test.ts` (17: rejections, closed direct writes, privileges, swap, history snapshot unchanged, post-transfer capabilities, stale membership, repeat transfer) and service tests. 455 tests, typecheck, lint, build clean. `supabase/hosted/ownership.verify.ts` passes against DEV (5 tests).
- **Not verified:** the browser UI (no local Chrome for Playwright; typing credentials into a browser that talks to hosted DEV was not done).

## Phase D5 — Co-member visibility / Former member (2026-10-08)

Implements `01-APP-SPEC.md` section 6.5. D6 and later are not started. **Migration `20261024000000_co_member_visibility.sql` is tested locally (PGlite) but has NOT been applied to any hosted Supabase project.**

- **Current members:** new RPC `list_wallet_members(wallet)` (`SECURITY DEFINER`, `search_path = ''`, authenticated only) returns each current member's role, join date, display name and avatar to members of that wallet only. No email or auth data. Outsiders, other wallets and anon get an error, so it cannot enumerate users. `profiles` RLS is unchanged (own row only); no broad policy was added.
- **UI:** Members tab shows display name and avatar ("You" for self; "Owner"/"Member N" only when a member has no name). Transaction list "paid by" now resolves through the current member list.
- **Former members:** `created_by` / `paid_by_user_id` are never touched. Anyone not in the current member list shows as **Former member**, and their name, email and avatar are not returned by any wallet path. Re-joining makes them visible again. Offline (member list unavailable), non-self users show as "Another member".
- **Tests:** `supabase/tests/co_members.rls.test.ts` (visibility, boundaries, before/after removal and leave, profile policies unchanged, function privileges) and resolver tests in `membership.test.ts`. 437 tests pass; typecheck, lint, build clean.

## Phase D4 — Membership foundation (2026-10-08)

Implements the membership and invitation rules of `01-APP-SPEC.md` sections 6.1 to 6.3. Ownership transfer (D6), co-member names and Former-member display (D5), Who Paid (D7) and everything later are not started. Transactions, budgets, dashboard and offline code are untouched. **Migration `20261023000000_membership.sql` is written and tested locally (PGlite) but has NOT been applied to any hosted Supabase project.**

- **Invitations (`wallet_invitations`):** only `sha256(token)` is stored (`token_hash`, unique, 32 bytes); the plaintext token is generated on the server (two v4 UUIDs from the CSPRNG, 64 hex chars, about 244 bits) and returned once by `create_wallet_invitation`. It is not stored in the database, and the client never logs or persists it; it does travel in the RPC request and response, and server-side request logging is outside the app's control. The hash is unsalted SHA-256 on purpose: the token is high-entropy and looked up by hash. Expiry is 7 days, capped by a CHECK as well as the RPC. Single use via `accepted_at`; revocable via `revoked_at`.
- **RPCs (all `SECURITY DEFINER`, `search_path = ''`, execute revoked from `public`/`anon`):** `create_wallet_invitation` and `revoke_wallet_invitation` (owner only); `preview_wallet_invitation` and `accept_wallet_invitation` (any signed-in user); `remove_wallet_member` (owner only, never the owner); `leave_wallet` (members only, the owner is refused). An invalid, expired, revoked, used or malformed token always returns the same `{ ok: false }`.
- **Single use:** accept locks the invitation row (`FOR UPDATE`), re-checks it, then marks it accepted and inserts the membership in one transaction. Sequential replays are tested; the row lock is meant to make concurrent accepts single-use too, but PGlite is a single session, so true concurrency is **unverified** until run against multi-connection Postgres. A user who is already a member succeeds without consuming the link.
- **Rate limiting:** server-side, per user, in `membership_rate_events` (RLS on, no client access) via an internal helper. Limits: **20 invitations created per hour; 20 preview/accept attempts per 15 minutes**. Failed token attempts are returned, not raised, so they stay counted. Over the limit the call raises SQLSTATE `54000`. Limitation: the limit is per account, so it does not stop an attacker who signs up many accounts (Supabase Auth's own sign-up limits apply there); guessing a 244-bit token is not feasible regardless.
- **Table access:** `wallet_invitations` has RLS and no write grants; owners may `SELECT` only the non-secret columns (`token_hash` and `accepted_by` are not readable). The old direct `DELETE` on `wallet_members` (policy `wallet_members_leave` and the grant) was removed: remove and leave now exist only as RPCs. Wallet deletion still cascades.
- **History:** removing or leaving deletes only the `wallet_members` row; `created_by` and `paid_by_user_id` on transactions are kept (tested). Members are still listed without names ("You", "Owner", "Member 1..."); names and Former-member handling are D5.
- **Client:** (opening any main nav item closes an open invitation screen) `membership.ts` (link and token helpers), `membershipService.ts` (RPC wrappers with safe messages; it logs only the error code and message, never the token), a **Members** tab in each wallet (members, owner remove, member leave, owner invite link with copy, pending invitations with revoke), and a join screen opened by `#/join/<token>`. The token travels in the URL fragment, is held in memory only, and is cleared from the URL when the screen closes. A signed-out visitor sees a sign-in prompt and the link stays in the URL (sign-up flows that reload the page lose it; open the link again). Membership changes are online-only; nothing goes through the transaction outbox.
- **Tests:** 38 database tests (`supabase/tests/membership.rls.test.ts`): owner/member/outsider/anon creation, hash-only storage, closed direct access, valid/expired/revoked/used/unknown/malformed tokens, sequential replay by the same and other users, already-member no-op, revoke and remove authorization, cross-wallet attempts, owner cannot leave or be removed, ownership unchanged, history kept, and both rate limits. Plus `membership.test.ts` (link parsing, labels, service mapping, no token in logs). Two old direct-leave tests in `wallets.rls.test.ts` now assert the RPC path. Mutation check: removing the revoked-invitation condition from the migration makes the revoked test fail.
- **Verified:** 413 tests, typecheck, lint and build pass. **Not verified:** the migration on a hosted project, the UI in a browser (including the clipboard copy and the sign-in-then-join path), and behavior with a removed member's pending offline transactions (the server will reject them; no special handling was added).

## Phase D3 follow-up — Total Remaining definition (2026-10-08)

Resolves the open question recorded in the Phase D3 entry. Only the dashboard Remaining metric changed; no schema, RLS, RPC, Auth or Vercel change, and D4 and later are not started.

- **Definition:** Total Remaining = Total Budgeted - Budgeted Spent (budget capacity left, not cash on hand). It was Total Budgeted - Total Spent, so unbudgeted expenses wrongly consumed budget. They still count in Total Spent and in the account balances.
- **Code:** `summarizeBudgets` (`src/domain/finance/budget.ts`) computes `totalRemaining` from `budgetedSpent`. Total Spent, Budgeted Spent, Monthly Income, Total Balance, Total Budgeted, per-budget lines and the D2 thresholds are unchanged. Negative values (budgets exceeded) display as before ("Over budget by ...").
- **Spec:** section 13 now defines Total Remaining; the D3 open-question pointer was replaced.
- **Tests:** unbudgeted spending leaves 8,000 remaining; 2,000 budgeted + 1,000 unbudgeted leaves 6,000; fully budgeted spending leaves 0; 9,000 against 8,000 gives -1,000; no budget gives 0 with unbudgeted spending.
- **Verified:** 360 tests, typecheck, lint and build pass.

## Phase D3 — Dashboard metrics (2026-10-08)

Implements the dashboard metric definitions in `01-APP-SPEC.md` section 13. No schema, RLS, RPC, Auth or Vercel change; D4 and later are not started; D2 threshold behavior is untouched.

- **Correction to the D0 record:** the D0 audit stated that the dashboard "Spent" excluded unbudgeted expenses. It did not: `summarizeBudgets` already summed every expense in the month (the existing test "unbudgeted expenses still count as spent" covered it). The D0 entry below and the spec change note were wrong on this point; the spec note was corrected, the historical entry is left as written. What was actually missing was Budgeted Spent and Monthly Income.
- **Total Spent:** every expense in the wallet-month, budgeted or not (value unchanged; label "Spent" is now "Total Spent").
- **Budgeted Spent (new):** the part of Total Spent in categories that have a budget; subcategory expenses roll up to their budgeted parent. `summarizeBudgets` gained `budgetedSpent`; no second spending formula.
- **Monthly Income (new):** all income in the wallet-month, transfers and expenses excluded (`monthlyIncome` in `src/domain/finance/budget.ts`, same month prefix test as spending). The dashboard now reads the month's income rows with the existing paged four-column query (`budgetService.income`, sharing one helper with `spending`); a failed read fails the whole load as before.
- **Offline/pending:** baseline expense and income rows go through the one existing `localSpend` projection, so pending (non-BLOCKED) income and expenses show immediately and a synced row counts once. Snapshots cached before this change lack income and build with 0 until they revalidate.
- **Unchanged:** Total Balance (account-balance aggregate), Total Budgeted, Needs Attention (D2 thresholds), month/timezone semantics, wallet scoping.
- **Open question, not changed:** the hero **Remaining** is still total budgeted minus *Total Spent*, so unbudgeted spending reduces it (budgeted 8,000, budget categories untouched, 2,000 spent elsewhere shows 6,000 remaining). Subtracting Budgeted Spent instead may be what is intended; the contract does not define Remaining, so it needs a decision.
- **Tests:** Total Spent / Budgeted Spent / Monthly Income for the required 5,000 + 2,000 + 20,000 + 3,000-transfer scenario and cases 1 to 6 (budgeted only, unbudgeted only, none, income only, transfers only, mixed with other months and subcategory roll-up); pending income, duplicate ids, BLOCKED items and pending unbudgeted expenses through the offline projection; income-read failure; D2 thresholds in Needs Attention.
- **Verified:** 355 tests, typecheck, lint and build pass. Not verified against the hosted database or in a browser (no hosted run was made).

## Phase D2 — Budget threshold semantics (2026-10-08)

Implements the budget-status contract in `01-APP-SPEC.md` section 12. No schema, RLS, RPC, Auth, Vercel, dashboard-metric or offline change; D3 and later are not started.

- **Behavior:** `calculateBudgetStatus` (`src/domain/finance/budget.ts`, the single source) now classifies usage as `normal` below 80%, `warning` from 80% to below 100%, and `exceeded` at 100% or more. Exactly 100% is Exceeded: `over` changed from `spent > budget` to `spent >= budget`. The warning boundary is exactly 80%.
- **Added:** a `status` field (`'normal' | 'warning' | 'exceeded'`) on `BudgetStatus`; `over` is kept and equals `status === 'exceeded'`. Thresholds use exact integer (BigInt) comparison, not the float `percentUsed`, so boundaries cannot drift. `percentUsed` and money handling are unchanged.
- **UI:** unchanged structure. Because exactly 100% is now Exceeded with 0 remaining, the Budgets and Dashboard lines read "Budget fully used" instead of "Over budget by ₱0.00" in that case. There was no warning state in the code before, and no warning visual was added (not part of D2).
- **Tests:** table-driven boundary tests (0%, 79%, 79.99%, exactly 80%, 99%, 99.99%, exactly 100%, over 100%), non-divisible budgets, and a large-integer case. The old "exact limit is not over" assertions (domain and dashboard) were reversed to match the contract.
- **Verified:** 341 tests, typecheck, lint and build pass.

## Phase D0 — Core product contract finalized (2026-10-08)

Documentation and specification only. **Nothing in this entry is implemented.** No application code, database schema, migration, RLS, RPC, Supabase, Auth or Vercel change. Phase D implementation (D2 onward) has not started.

The specification audit found a strong financial/security foundation but gaps and conflicts against `01-APP-SPEC.md`. The conflicts were resolved and approved, and `01-APP-SPEC.md` now states them as the implementation contract.

### Resolved business rules (now in the spec; to be implemented in later phases)
- **Wallet mode:** Shared Log only. Split Mode is deferred.
- **Membership:** invite-link model; random high-entropy token, only its hash stored; single-use; revocable; 7-day expiry; authenticated acceptance; one generic error for invalid/expired/used; rate limited. Owner can remove members, a member can leave, and the owner cannot leave.
- **Ownership transfer:** owner to an existing member only; atomic; exactly one owner afterwards; old owner becomes a member; history unchanged; rejected when the owner is the only member.
- **Co-member visibility:** display name and avatar URL only; never email or other profile fields.
- **Former members:** history keeps `created_by` / `paid_by_user_id`, the profile is not exposed after membership ends, and the UI shows "Former member".
- **Payer:** `created_by` and `paid_by_user_id` are independent. `paid_by_user_id` is "Who Paid" for expenses and "Received by" for income; default is the creator; any current member may be selected; the server validates membership when the payer changes; transfers have no payer.
- **Account deletion:** blocked while the user owns a wallet that has other members; wallets where the user is the only member are deleted with the account (named in the confirmation, export offered first); memberships end automatically; transactions are retained with `created_by` / `paid_by_user_id` anonymized and shown as "Former member" (anonymized rows become owner-editable only); profile data deleted; blocked while the local outbox has pending mutations ("Sync or discard pending changes first."), never auto-discarded.
- **Data export:** client-side JSON, versioned envelope, only data the user can already read, no other users' email or profile fields.
- **Transaction search/filter:** case-insensitive search over note, account, category (and parent), payer/member and type; filters for date, category, payer/member, account and type; AND between filters, OR within one filter; runs on already-loaded transactions so it works offline.
- **Budget thresholds:** under 80% Normal, 80% to under 100% Warning, 100% or more Exceeded (exactly 100% is Exceeded); budget must be greater than zero.
- **Legal pages:** `/privacy` and `/terms`, public; the spec lists the data practices to describe but contains no legal text.

### Dashboard metric semantic change
The dashboard "Spent" figure currently means spending inside budgeted categories only (unbudgeted expenses are excluded). The contract redefines it: **Total Spent** is all expense transactions in the selected wallet and month, and **Budgeted Spent** is a separate figure for categories that have a budget. Monthly Income is all income in the month; transfers are excluded from both; Total Balance stays the computed account-balance aggregate. The code still has the old meaning until the dashboard phase.

### Deferred scope (explicit, moved to `02-ROADMAP.md`, ideas kept)
Split Mode, **Wallet Archive** (no archive column, state or UI; wallets are active or deleted), budget rollover, Net Worth, credit-card/loan special semantics, receipts and file storage, push and advanced notifications, Reserved Funds and "available to spend", Wishlist/Purchase Goals, Events, recurring/planned purchases, offline writes for non-transaction data, income/custom categories, and custom domain/SMTP/production Google sign-in.

### Documentation changes
- `01-APP-SPEC.md`: wallet/member permission table consolidated (section 6); invitations, ownership transfer, privacy, payer, search/filter, budget, dashboard, export and deletion rules added; password recovery added to section 4; free-tier production strategy and its email limitation documented (section 17); section 25 lists every deferred feature.
- `02-ROADMAP.md`: Phase 13 moved to "Completed"; Phase D sequencing and the deferred features recorded.
- `03-CHANGELOG.md`: this entry; "Phase B (in progress)" corrected to complete.
- Spec path: the repository already references the root-level `01-APP-SPEC.md` everywhere; the `docs/01-APP-SPEC.md` path appeared only in a task brief, so no repository reference needed correcting.

### Known gaps in the current code relative to the contract (to be closed in Phase D)
Budget `over` uses `spent > budget`; dashboard Spent excludes unbudgeted expenses; there are no invitations, member removal or ownership transfer; the payer is forced to the creator by trigger; the Transactions page shows "Another member"; no search/filter, export, account deletion or legal pages exist; account deletion is currently refused by foreign keys on `created_by` / `paid_by_user_id`.

### Remaining documentation debt (not changed; cannot be proven from git history)
- `supabase/VERIFICATION.md` covers only Phase 2 (2026-10-06); it is a point-in-time report, left as is.
- Changelog phase numbering has no Phase 7, 11A or 12A entries, and Phase 2 is listed after Phase 1; no history was invented.
- Dates on the Phase 3 to 6 entries (2026-10-07 to 10-12) mirror migration filename prefixes and cannot be verified: early history is a single commit (`6b20fab`) and all later commits are dated 2026-10-07.

## Free-tier production strategy: custom domain and SMTP deferred (2026-10-07)

Documentation only. No application code, Supabase (Auth, Site URL, redirect URLs, schema, RLS), Vercel, DNS, SMTP, Google OAuth or environment-variable change; nothing was sent or created.

- **Decision:** stay on free tiers (Vercel Hobby, Supabase Free) with no purchased or configured custom domain. The production origin remains `https://moneywhere-rho.vercel.app`; production Supabase is `zoyauiojqpcglyhxzzkh`, development `sitlhdkfihzmdzxfrliv`.
- **Email:** keep Supabase's built-in mailer. Confirm email stays on, email/password signup enabled, anonymous sign-ins off, minimum password 8. Email confirmation is not disabled and no weaker flow, signup restriction or code workaround is added.
- **Reason:** remain on free tiers during development and controlled testing; custom SMTP needs a sender domain we control, which `vercel.app` cannot provide.
- **Current limitation:** the built-in mailer is rate-limited and only delivers to addresses Supabase permits, so it is fit for development, internal testing and controlled testers, not for general-public email delivery. Public sign-ups and password recovery for arbitrary users are not production-ready until SMTP exists. Already verified on production and not repeated: load, signup, confirmation email and redirect, sign-in/out, session persistence, password validation. Production recovery email remains untested.
- **Future path:** register a domain and add it to Vercel; move Site URL, redirect URLs and `VITE_AUTH_REDIRECT_URL`; configure custom SMTP (SPF, DKIM, DMARC) in the Supabase dashboard; re-test production signup confirmation and password recovery. Also deferred: Google OAuth, and reassessing Vercel Pro (Hobby is non-commercial use) and the Supabase plan.
- **Spec:** `01-APP-SPEC.md` is unchanged; this is a deployment decision, not a product-requirement change.

## Password recovery (2026-10-07)

Application code and tests only. No Supabase, Vercel, environment-variable, migration, Site URL/redirect or SMTP change; nothing was sent or created in any project.

- **Flow:** sign-in screen gets `Forgot password?` → email form (`Send reset link`) → neutral message "If an account exists for that email, we've sent a reset link." The email link returns to the existing `VITE_AUTH_REDIRECT_URL` origin (same helper as signup, `window.location.origin` fallback); the app opens a `Set a new password` screen (new + confirm, 8-character minimum, must match), calls `updateUser({ password })`, signs out with the existing `signOut()`, and shows "Password updated. You can now sign in with your new password." An invalid/expired link shows "This reset link is invalid or has expired." with `Request a new link`. The reset screen also has `Cancel` (signs out) so an expired recovery session is not a dead end. No router, no PKCE.
- **State:** new `RECOVERY` auth status carrying the session; `PASSWORD_RECOVERY` maps to it and it is sticky (later `SIGNED_IN`, `INITIAL_SESSION`, `TOKEN_REFRESHED`, `USER_UPDATED` keep it; only sign-out leaves). `UNAUTHENTICATED` can carry a one-time `notice` or `linkError`. The recovery UI renders only in `RECOVERY`, so the data layer (`OfflineProvider`) never mounts on a recovery session.
- **Race fix:** Supabase emits `PASSWORD_RECOVERY` once, in a `setTimeout(0)` during client init, possibly before React subscribes. `src/lib/authLink.ts` is passed to `createClient` as `detectSessionInUrl`; Supabase calls it synchronously at init, so it classifies the link (recovery / error code / none) before anything can miss it, and the provider decides after `getSession()` (which resolves after init): session + recovery link → `RECOVERY`; no session + recovery/error link → link error. No dependence on event timing, no extra listeners (StrictMode double-mount just repeats idempotent dispatches).
- **Security:** only the link kind and an error code are kept, never a token; nothing logs the URL. The fragment is removed with `history.replaceState` inside that hook, before Supabase's own `location.hash = ''`, so the token does not stay in a history entry. No manual token storage, no admin API or service role. Unknown-email stays neutral: `requestPasswordReset` surfaces only connectivity failures; Supabase's throttle errors (which exist only for real accounts) are swallowed. Errors map through the existing safe-message table (`otp_expired`, `same_password`, `weak_password`, `session_expired`/`session_not_found` added or reused).
- **Tests:** `src/features/auth/recovery.test.ts` (+14, total 318 → 332): reducer (recovery, sticky, sign-out, notice/linkError), hash parsing (valid, error, `otp_expired`, malformed, empty), `detectAuthCallback` (classification, fragment stripped, default test preserved), services (trim + redirect, neutral for unknown/throttled, connectivity reported, `updateUser` then sign-out, failed update does not sign out), validation (short, mismatch, valid) and error mapping. `tsc -b`, `eslint .` and `npm run build` pass.
- **Manual verification:** **not performed.** The browser tool was unavailable in this environment, and a valid recovery link needs a real email. Still to do locally (development project): forgot-password screen, neutral message, recovery link → reset screen, address bar and history free of the token, tampered/expired link error card, short and mismatched passwords, update → signed out → sign-in with new password and old one rejected, reload during normal sign-in, no token in the console.
- **Known limitations:** production recovery email needs custom SMTP (the built-in mailer only reaches project members) and has not been tested in production. An error redirect carries no link type, so an expired *signup* link also shows "reset link" wording. If a signed-in user opens a tampered recovery link they briefly get the reset screen on their own session (`Cancel` signs out). Reloading mid-recovery drops the user into the app as themselves (the link is already consumed). `signOut()` uses Supabase's default scope, unchanged. `01-APP-SPEC.md` does not mention password recovery; it was not edited (documentation gap).

## Phase C-3 — Pre-production database hardening (2026-10-07)

One forward migration, **not applied to any hosted project yet** (the development project is still at `20261020000000`, and production does not exist). No application, UI, business-rule, RLS-policy or other function change.

- **Migration `20261022000000_account_has_transactions_privileges.sql`:** `public.account_has_transactions(uuid)` is `SECURITY DEFINER` and returns whether any transaction uses an account as source or destination. Its execute privilege was held by `PUBLIC`, `anon` (Supabase also grants new functions to `anon` directly), `authenticated`, `service_role` and the owner, so it could be called through the Data API with only the public anon key, with no session, as a yes/no probe for an account id (an unguessable UUID, so low severity). The migration revokes execute from `public` and `anon` and grants it to `authenticated`. After it: owner, `authenticated` and `service_role`. Body, return value and security mode are unchanged.
- **Why `authenticated` must keep it:** its only users are the `accounts_delete_owner` policy (`... and not account_has_transactions(id)`) and the `accounts_guard_history` trigger, and both run as the calling role. `anon` has no table access to accounts, so it never needed the function. The hosted transactions suite also calls it as a signed-in client. A signed-in user can still call it with any account id; closing that would need a different design (the policy and trigger would have to stop calling it as the user) and is out of scope.
- **Safe on a new database and on dev:** `revoke` and `grant` on an existing function are idempotent and touch nothing else; the function exists from migration 4 and is replaced in 6 and 7, so the statement is valid after migrations 1–21 on an empty project and on the development database (`create or replace` in the tests keeps the privileges).
- **`accounts_guard_history`: left unchanged.** It is `SECURITY INVOKER` (no privilege escalation), every object it references is schema-qualified (`public.account_has_transactions`) or a built-in operator that `pg_catalog` resolves first, so a caller-controlled `search_path` cannot redirect it. The missing `set search_path` is only a linter/advisor notice; pinning it would change nothing observable and was not asked to be changed without a clear benefit.
- **Tests (`supabase/tests/accounts.rls.test.ts`, PGlite with Supabase's default function privileges reproduced):** `anon` and `PUBLIC` have no execute and `authenticated` has it; `anon` gets "permission denied for function" for a real and a random account id; a signed-in user can still call it; a negative control shows the owner's delete and type change fail with "permission denied for function" if `authenticated` loses execute, and work again once it is restored, with a member still unable to delete. Without the migration the first test and the control fail, with it they pass. Every existing account-history, owner/member and delete test runs on the migrated schema, so those paths are covered. Test count 316 to 318.
- **Dev project state, read-only:** before: ACL `PUBLIC`, `anon`, `authenticated`, `service_role`, owner; the migration is not recorded as applied. Applying it is part of the production/dev migration steps and was not done here.

## Phase C-3 — Hosted-suite safety guard (2026-10-07)

Test-infrastructure change only: no application code, migration, RLS, RPC or infrastructure change, and no Supabase project was linked, unlinked, created or modified.

- **Why:** the nine hosted scripts create and delete real users, wallets and rows. Only `cleanup.mjs` checked its target; the eight `*.verify.ts` suites trusted `.env.local` for the API and `supabase db query --linked` for SQL, so a production `.env.local` or a production link would have pointed them at production.
- **Guard (`supabase/hosted/guard.mjs`, fails closed):** a script runs only if all of these hold: `VITE_SUPABASE_URL` in `.env.local` is a plain `https://<20-character-ref>.supabase.co` URL (no port, credentials, path tricks or look-alike host); the linked project (`supabase/.temp/project-ref`) is readable and is the same project; and that project is in `APPROVED_DEV_REFS`, which holds only the development project `sitlhdkfihzmdzxfrliv`. Anything missing, malformed, mismatched or unlisted throws before the script reads credentials, opens a client or spawns the CLI. There is no environment variable or flag that adds a project; changing the list means editing the file. A production project is never added, and production work uses an explicit `--project-ref` outside these scripts.
- **Wiring:** every `*.verify.ts` calls `assertDevProject()` at the top of the file; `cleanup.mjs` calls it first and still requires `--project-ref` to name the same project.
- **Tests (`supabase/tests/hosted_guard.test.ts`, part of `npm test`, no network):** accepts the approved dev project; rejects a mismatch in both directions, an unapproved project even when `.env.local` and the link agree, missing/empty/unreadable inputs, and eleven malformed or look-alike URLs; shows that the environment cannot widen the list; and checks statically that every hosted script imports the guard and calls it before anything that reads `.env.local`, creates a client, spawns the CLI or reads arguments. Test count 309 to 316.
- **Also checked:** the real guard code path (it reads the two files) was run from a throwaway copy with unknown-project, mismatch both ways, missing `.env.local` and missing link: all refused with a non-zero exit. The hosted suites were then run, with the guard in place, against the development project: **8 files, 82 tests passed, 0 failed, 573 s**; the only warning was Node's `DEP0190` notice about `shell: true` in the existing `execFileSync('npx', …)` calls (not new, not changed). Afterwards the guarded `cleanup.mjs` dry run listed the same 11 test users and 4 test wallets as before the run (the 9 older ones plus the two throwaway verification users and their wallets), the database holds 15 users, 5 wallets, 9 transactions, 5 accounts, 1 budget and 7 memberships (consistent with the earlier inventory) and the only user created in the last hour is the verification member created before the run, so the suites left nothing behind and no cleanup was needed. `cleanup.mjs --apply` was not run.

## Phase C-3 — Production deployment preparation, repository side (2026-10-07)

Repository changes only. No production Supabase project, Auth setting, SMTP, Google client, Vercel project or deployment was created or changed, and the development Supabase project was not touched (the new migration is **not applied** anywhere yet). No RLS, RPC, transaction, offline or financial change.

- **Migration `20261021000000_profile_name_normalize.sql`:** a Google (or other OAuth) display name longer than 50 characters, or a blank one, violated `profiles_display_name_len` inside the `handle_new_user` signup trigger and failed the whole signup (the pre-existing issue noted in Phase 14). The trigger now normalises the incoming name and the constraint is unchanged: a name within the limit is stored exactly as before; a longer one is trimmed and cut to its first 50 characters; a missing or blank one becomes no display name (the user can set one in Profile). Avatar handling is identical to the previous version; existing profiles are untouched. Test (PGlite, in `profiles.rls.test.ts`): 120-character, 50 and 51-character, whitespace-only, empty, absent, padded-but-valid and `display_name`-over-`name` cases; it fails on the previous trigger with `profiles_display_name_len` and passes with the migration. Test count 308 to 309.
- **`vercel.json` security headers:** `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, a restrictive `Permissions-Policy`, and a conservative Content-Security-Policy: `default-src 'self'`, scripts from self only, styles self plus inline (the app uses style attributes), images self, `data:` and any `https:` (profile avatars), `connect-src 'self' https://*.supabase.co wss://*.supabase.co` for the API and Realtime, `worker-src 'self'`, `manifest-src 'self'`, `object-src 'none'`, `base-uri`/`form-action` self, `frame-ancestors 'none'`. No rewrites (the app has no client routes). Checked locally by serving the production build with exactly these headers from a throwaway static server against the development project: sign-out and sign-in through Supabase Auth, Realtime showed "Live", the service worker registered and activated, inline meter styles applied, and the page reported no CSP violations. It has not been checked on a real Vercel deployment yet, and the Google redirect is a top-level navigation that the policy does not restrict.
- **Node pin:** `engines.node` is `24.x` (and the lock file's root entry). The build, typecheck, lint and tests were run on Node 24.16; the dependencies' own `engines` ranges also allow 22.13+, but that was not run, so only 24 is declared.
- **Icons:** `icon-192.png` and `icon-512.png` were flat teal squares with no mark. They are regenerated in the same teal (`#0f766e`) with the white ₱ from `icon.svg`, full-bleed, with the glyph inside the central 80% safe zone (farthest corner 135px from the centre against a 205px safe radius), so the existing "maskable" manifest entry is now valid. The manifest is unchanged.
- **Docs:** the README's "Auth setup" became environments, Supabase setup, deployment and a production verification checklist; `.env.example` documents the per-environment values. The README states the isolation rule: do not link the production project in this working copy, pass `--project-ref` for production migrations, and never run the hosted suites or `cleanup.mjs --apply` against production.
- **Still open (external, not decided here):** the production Supabase project, the custom domain (so Site URL and redirects are not set), SMTP provider and sender, the production Google OAuth client and its published consent screen, Vercel project and variables, applying the new migration to production, and the production smoke test.

## Phase C-1 — Transaction conflict-save safety fix (2026-10-07)

One focused correctness fix in `TransactionsPage.tsx`. No change to the mutation RPC, versions, RLS, the outbox, offline replay, financial calculations or any other screen.

- **Bug:** `save()` chooses between update and create from the `editing` state alone. When an online edit lost the version check (another client changed the same transaction first) and `TransactionConflictError` was thrown, the handler cleared `editing` but left `form` and `formOpen` alone. The dialog stayed open with the typed values, retitled "New transaction" with an "Add Transaction" button, so the next submit created a new transaction with a fresh id and no version check: a duplicate. Closing the dialog instead left the stale values as a draft for the next "+ Add".
- **Reproduced** on the old code against hosted dev with two clients (an edit open in the browser, a second client changing the same row, then submitting twice): the first submit showed the conflict message inside a dialog now titled "New transaction", the second created a second ₱250.50 expense (3 rows became 4).
- **Fix:** on `TransactionConflictError` the handler now calls the existing `cancelEdit()` (clears `editing`, the form and the form error, and closes the dialog), shows the service's conflict message with `setNotice`, and still calls `load()`. Other save failures are unchanged: they keep `editing`, so a retry stays an update.
- **Behaviour after a conflict:** the edit is not saved; the dialog closes and the typed values are discarded; the latest server state is reloaded; a page notice ("Someone changed this transaction. Your edit was not saved; the latest version is shown.") stays until the next save; the user must reopen Edit, which shows the latest version, and re-apply the change; "+ Add" opens a clean form; no duplicate can be created from the conflicted edit.
- **Not touched:** the delete-conflict path (it still reports through the load-error line, which a successful reload clears; left as is on purpose), `Keep server version`, offline edit and replay (a queued edit that conflicts at replay never reaches this handler and is presented per row as before).
- **Verified (browser only, no automated test; the repository has no DOM test setup and none was added):** the same two-client scenario on the fixed code: the dialog closed, the notice was shown, the list stayed at 3 rows with the other client's version on top, no row carried the stale text, the dialog's form was reset (title "New transaction", empty fields), "+ Add" opened a clean form and a fresh Edit showed the latest note; normal edit saved; create and delete worked; an offline edit showed the pending state, reconnect synced it, and an offline edit made stale by the second client became a conflict row cleared with "Keep server version"; Dashboard balance, spent and remaining returned to the baseline (₱8749.50, ₱250.50, -₱50.50) after the test duplicate from the reproduction was deleted. TypeScript, lint, 308 tests and the production build pass.
- **Limitation:** the discarded typed edit is not recoverable; the notice tells the user to reapply it. Only the online edit path is covered by this fix.

## UI redesign, Phase B — existing screen migration (complete)

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

### Gate 3 — Transactions (2026-10-07)
- **UI:** `PageHeader` "Transactions" with a primary **+ Add** button beside it (visible without scrolling at 360px; hidden only when the wallet has no accounts, exactly when the old form was hidden). The add/edit form moved into the Phase A native `Dialog`; the old inline form and the page's own "← Wallets" link and heading are gone, so this page no longer relies on the temporary CSS hiding rule (the rule stays for the pages not yet migrated). Rows are cards grouped under date headings (consecutive rows with the same date; `shown` is not reordered, filtered or re-queried): type badge (Expense / Income / Transfer, with the existing +, − and ↔ signs through `Money`), right-aligned amount, account · category · "Paid by", note, then the unchanged sync sentence from `describeSync`. Pending and conflict rows keep the dashed border and their full text; "Keep server version" / "Dismiss" are buttons; Edit is secondary, Delete a red ghost button, and the inline Confirm delete / Cancel step is kept (danger button).
- **Dialog:** the page still owns `form`, `editing`, `busy`, `formError`, validation (`parseTransaction`), `save`, `remove` and the post-save `load()`; the only new state is `formOpen`. The dialog's children stay mounted while it is closed, and it cannot be dismissed while a save is busy. Saving closes it (same point as the old form reset); errors stay in it. Closing an edit cancels it (as Cancel did); closing a half-typed new transaction keeps the draft, as the inline form did. The separate Cancel button is replaced by the dialog's Close.
- **Preserved:** `shown`, `offlineEditable`, `syncEditable`, `localBalances`, reconciliation, snapshot-first loading, stale note, offline create/edit through the outbox, conflict and Keep server version, owner/member rules, `TransactionConflictError` handling. No service, domain, outbox, RPC or authorization file was touched. `WalletsPage` only stopped passing the unused `onBack`.
- **Verified:** TypeScript, lint, 308 tests, build; real signed-in hosted-dev app at 360 / 768 / 1280 (no overflow, targets of at least 44px, dialog fits a 360x740 viewport without scrolling, 480px wide at tablet and desktop); create expense, income and transfer, edit (dialog pre-filled, saved), delete with confirm and cancel, empty-form validation; Dashboard balance, spent and remaining moved as expected after each change and returned to baseline after deleting the test rows; offline create and edit showed the pending state, reconnect synced the create, a change made from a second client turned the edit into a conflict, and Keep server version cleared it.
- **Not verified:** BLOCKED (not reproduced, nothing manufactured); other-member transactions in the browser; Esc and backdrop dismissal in the real page; load-error state of the list.
- **Observation, unchanged behaviour:** after a save that fails with a conflict the old code clears `editing` while leaving the typed values, so the same form would then submit as a new transaction. That is still the case, now inside the dialog; flagged for a separate decision.

### Gate 4 — Budgets (2026-10-07)
- **UI:** `PageHeader` "Budgets" with an owner-only **+ Add budget** button (visible without scrolling at 360px); month switcher as a month label with two buttons (stacked under the label on phones, in one row from 640px); each budget is a card with the category name, a `Meter` fed `percentUsed` and `over` from `calculateBudgetStatus`, "spent / budget" and the unchanged status line through `Money` ("Over budget by ₱X" with `role="alert"`, or "₱X remaining", plus "N.N% used"). The old "← Wallets" link and heading are gone; the wallet shell's tabs are the navigation. Edit stays inline in the card, Delete keeps its inline confirmation (same sentence), with the danger button for Confirm delete. The create form moved into the native `Dialog`; its validation and server errors show inside the dialog, other errors on the page. Loading, load error, "not available offline yet" and the empty message use `State`; the stale note is a muted notice.
- **Wording changes (only because the form is no longer below the list):** the empty-state hint "Create one below." now reads "Use + Add budget to create one."
- **Standalone use:** when the Dashboard's "Go to Budgets" opens the page outside the wallet shell it still receives `onBack`; the header then reads "{wallet} · Budgets" with "← Dashboard" (it used to say "← Wallets" although it returned to the Dashboard).
- **Preserved:** `calculateBudgetStatus`, `spendingByBudgetCategory`, `localSpend` and the sort are untouched; wallet and month scope, top-level categories only, owner-only create/edit/delete (and the existing rule that nothing is editable from an unconfirmed snapshot), member read-only note, read-through snapshot and revalidation, month `<input type="month">` in the form. No service, domain, offline or authorization file was touched; `WalletsPage` only stopped passing `onBack` to Budgets.
- **Verified:** TypeScript, lint, 308 tests, build; real signed-in hosted-dev app at 360 / 768 / 1280 (no overflow, targets of at least 44px, dialog fits 360x740 and is 480px wide on larger screens); Food 125.3% over budget shown in text and red; create (empty and zero amount rejected with the existing messages; Bills 5000 saved), edit (pre-filled, invalid amount rejected, 6000 saved), delete (confirm, cancel, confirm); the Dashboard's Budgeted, Remaining and Needs Attention followed each change through the existing domain code (200 to 5200 to 6200 and back to 200.00, Spent 250.50 and Balance 8749.50 unchanged); month switch and the empty month; Dashboard "Go to Budgets" and back; offline showed the saved budgets with the stale note and no owner actions, reconnect restored them.
- **Not verified:** other-member (read-only) view in the browser; the load-error state.

### Gate 5 — Accounts (2026-10-07)
- **UI:** `PageHeader` "Accounts" with an owner-only **+ Add account** button (visible without scrolling at 360px); each account is a card with the name, a type `Badge` (text), the holder line when present, **Current balance** as the largest figure through `Money`, the opening balance below it, and a "Has transactions" badge. Owners also see one sentence on such cards explaining why Delete is absent and that type and opening balance are locked. The create/edit form moved into the native `Dialog`; locked Type and Opening balance fields stay disabled and now carry a "Locked: this account has transactions." hint next to the existing explanation sentence. Edit is a secondary button; Delete keeps its inline confirmation (danger button for Confirm delete). Loading, load/delete error, empty and stale use `State` or the muted notice; the member note is unchanged text. The page's own "← Wallets" link and heading are gone.
- **Wording changes (layout-driven or clarifying):** empty hint "Create your first one below." now reads "Use + Add account to create your first one."; the card labels are "Current balance" and "Opening balance" (were "Current" and "Opening").
- **Preserved:** the balance is the server value projected with pending items by `projectAccounts` (no formula in the UI); `hasTransactions` still decides the locks and whether Delete is offered; owner-only controls are unchanged, including that they are not hidden while data is stale (unlike Budgets); name 50-character validation and every other message come from `parseNewAccount`; snapshot-first loading and the stale note. No service, domain, offline or authorization file was touched; `WalletsPage` only stopped passing `onBack` to Accounts.
- **Verified:** TypeScript, lint, 308 tests, build; real signed-in hosted-dev app at 360 / 768 / 1280 (no overflow even with a 42-character name and a long holder, targets of at least 44px, dialog fits 360x740 and is 480px wide on larger screens); balances on the cards matched the earlier test data (Cash ₱1249.50, Bank ₱7500.00); create (empty and over-long name rejected with the existing messages), edit of an account without transactions (name, type, opening balance, holder all saved), an account with transactions (type and opening balance disabled and hinted, name and holder saved and reverted); the Dashboard balance followed each change (8749.50, 9749.50, 9249.50, then back to 8749.50); Transactions account, transfer-from and transfer-to selectors listed the new account; a ₱1.00 expense on the temporary account switched it to "Has transactions" with no Delete, and deleting that transaction restored Delete; delete confirm, cancel and confirm; offline kept the saved balances with the stale note, reconnect cleared it.
- **Not verified:** other-member account permissions in the browser; a server rejection of deleting an account with transactions (the UI never offers that delete); the load-error state.

### Gate 6 — Categories (2026-10-07)
- **UI:** `PageHeader` "Categories" with an owner-only **+ Add category** button (visible without scrolling at 360px). Each top-level category is a card; its subcategories are nested under it with an indent and a left rule. Rename stays inline in the row (same field label, same Save/Cancel), Delete keeps its inline confirmation with the unchanged sentence ("Also deletes its N subcategories. Delete?"), with a secondary Rename button, a red ghost Delete and a danger Confirm delete. The create form (name and optional parent) moved into the native `Dialog`; its validation and server errors show inside the dialog, rename/delete errors on the page. Loading, load error and the empty and "not available offline yet" messages use `State`; the stale note is a muted notice; the member note is unchanged text. The page's own "← Wallets" link and heading are gone.
- **CSS cleanup:** with Categories migrated no wallet section page renders the old back link or heading any more, so the temporary hiding rule for them was removed (the `.wallet-shell` layout rule stays).
- **Wording change (layout-driven):** the empty hint "Add your first one below." now reads "Use + Add category to add your first one."
- **Preserved:** `groupCategories` ordering and two levels, `parseCategoryName` validation, create with an optional parent, rename, delete with its cascade warning, owner-only controls and the existing rule that nothing is editable from an unconfirmed snapshot, read-through snapshot and stale note, server error messages. No service, domain, offline or authorization file was touched; `WalletsPage` only stopped passing `onBack` to Categories. There is no category total, count or usage metadata on the page, and none was added.
- **Verified:** TypeScript, lint, 308 tests, build; real signed-in hosted-dev app at 360 / 768 / 1280 (no overflow, including with a 70-character unbroken name injected into a row, targets of at least 44px, dialog fits 360x740 and is 480px wide on larger screens); 4 parents and 13 subcategories rendered nested; create top-level (empty name rejected with the existing message) and create a subcategory under it; rename (pre-filled, blank rejected, saved); delete confirmation text and cancel; the server's rejection of deleting a category that has a transaction ("This category has transaction history or a budget and cannot be deleted.") shown on the page; deleting the temporary parent removed its child; the new category and subcategory appeared in the Transactions category selector (parent as an option group) and top-level ones in the Budgets category list; offline kept the saved categories with the stale note and hid the owner controls, reconnect restored them.
- **Not verified:** other-member (read-only) view in the browser; the load-error state; deleting a category that has a budget (the transaction case was exercised; the server message covers both).

### Gate 7 — Profile and Auth (2026-10-07)
- **AuthScreen:** the sign-in / create-account card is centred in a 440px column with the brand as the heading, `Field` inputs, `Button` for Sign In / Create Account, a secondary "Continue with Google" button and a ghost button to switch mode (it was an underlined text link). The error and the "Check your email to confirm your account, then sign in." notice keep their text; the "not connected to Supabase" message uses `State`. The shell's "Loading…" while the session resolves (`App.tsx`, one line) now uses `State`; the `OfflineProvider`'s own loading line is unchanged (offline code is out of scope).
- **Profile:** `PageHeader`, an identity card (avatar or initial fallback as before, display name or email, and the email), a "Your details" form (display name, avatar URL, Save; same validation and messages; success shown as a muted green notice) and a "Session" section with **Sign out**.
- **Sign out on Profile:** this is the one addition. It calls the same `AuthService.signOut()` as the header button (no new logic) and shows its own error text if it fails; the header button stays.
- **Preserved:** `AuthProvider` and its reducer, the LOADING / AUTHENTICATED / UNAUTHENTICATED behaviour, the auth service and error mapping, `validateEmail` / `validatePassword`, `parseProfileInput`, the profile service, avatar handling (`referrerPolicy`, https-only URL, fallback), and every message. Nothing was added to storage and no credential or profile data is logged or kept. No service, provider, state-machine, profile or database file was touched.
- **Verified:** TypeScript, lint, 308 tests, build; real signed-in hosted-dev app at 360 / 768 / 1280 (no overflow, targets of at least 44px; auth content 440px wide and centred on larger screens, profile content 720 / 880px); profile display name saved and read back in the identity card, 51-character name and an http:// avatar URL rejected with the existing messages, then the name was cleared again; Sign out from Profile returned to the sign-in screen and the stored session token was gone; sign-in form validation (empty email, missing password), switching to Create account (password autocomplete changes, error cleared, 8-character rule shown), Google button present (not clicked); a real wrong-password sign-in showed "Incorrect email or password."; signing in with the right password showed the sign-in form first and then the shell, never the shell before the session resolved.
- **Not verified:** the Supabase-not-configured screen (would need the environment changed); a visible LOADING frame (session resolution was too fast to catch); Google sign-in and email-confirmation flows end to end (they leave the app or need a new account); avatar image display with a real https URL; other users' profiles.

### Final — integration and polish (2026-10-07)
- **Audit:** every screen was compared for headings, page headers, card padding, button hierarchy, state wording, dialogs, widths and leftover CSS. Most of it was already consistent: every wallet page uses `PageHeader`, `State`, `Money`, `Dialog`, the same button variants (primary for the main action, secondary for Edit / Rename / Keep server version, danger for confirm-delete, ghost for Cancel, Close and mode switches), the same 720 / 880px content widths and the same stale, pending and conflict wording. Inline Cancel is a ghost button on every screen; the brief lists Cancel as secondary, but it is consistent everywhere and was left alone.
- **Polish made (presentation only):**
  1. *Heading hierarchy.* Inside a wallet the shell's wallet name and the section title were both `h1` at the same size. `PageHeader` now takes `level` (1 or 2); Transactions, Accounts and Categories (and Budgets when opened inside the wallet shell) use level 2, so the wallet name is the page heading and the section is a smaller `h2`. Budgets opened from the Dashboard stays `h1`. The Transactions date headings went from `h2` to `h3`.
  2. *Dead CSS removed.* `button.secondary`, `button.link`, `.list` (+ its `li` rules), `.pill` (+ variants) and the unused `.field` selector (nothing renders them any more); the "not yet migrated" comment became "identity".
  3. *CSS grouping.* The shared `.note` (+ `.info`, `.good`) and `.btn.text-danger` rules, which had been added inside the Dashboard, Transactions and Profile blocks, now sit with the feedback and button rules. No value changed.
  4. *Line endings.* `TransactionsPage.tsx` had mixed CRLF/LF lines since Gate 3 and is back to its original CRLF, so this commit shows it as a whole-file change; ignoring line endings the change is 3 lines.
- **Left alone on purpose:** `.center` (still used by the `OfflineProvider` loading line, offline code is out of scope); both Sign out buttons; the old four-link wallet list stays gone; the conflict-after-save quirk in Transactions is still there (a failed edit save with a conflict clears the edit target but keeps the typed values, so the next submit would create a new transaction) and is documented as a separate future fix; `src/domain/finance/budget.ts` has mixed line endings from before Phase B and was not touched.
- **Verified:** TypeScript, lint, 308 tests, build; real signed-in hosted-dev smoke test: every screen (Home, Wallets, a wallet's Transactions, Accounts, Categories, Budgets, Profile) at 360 / 768 / 1280 with no horizontal overflow, no control under 44px and content 360 / 720 / 880px wide; the last card clears the fixed bottom nav at 360; baseline unchanged (Balance ₱8749.50, Budgeted ₱200.00, Spent ₱250.50, Remaining -₱50.50, Cash ₱1249.50, Bank ₱7500.00); the transaction dialog opened, saved, reopened for edit and saved, and the row was deleted; the offline badge and "✓ Synced" returned on reconnect; Sign out from the header and from Profile both returned to the sign-in form, and signing in again showed the shell. After signing out and back in the app lands on the page that was open before (Profile here), because the shell keeps its page state; that is existing behaviour.
- **Not re-verified in this pass:** the Budgets / Accounts / Categories dialogs and the conflict flow (all exercised in their own gates; the only code touched here is heading markup and CSS).

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
