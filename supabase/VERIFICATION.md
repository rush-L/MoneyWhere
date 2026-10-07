# Verification report: Auth & Profile against hosted Supabase

Date: 2026-10-06 · Project ref: `sitlhdkfihzmdzxfrliv` (hosted, free tier) · Test setting: *Confirm email* **off**.

Who checked what is stated per item. "Claude" = run by the assistant with output captured; "Manual" = done by the project owner in a browser.

## 1. Migrations: verified (Claude)
- `supabase link`, then `db push --dry-run` listed exactly `20261006000000_profiles.sql` and `20261006010000_profiles_hardening.sql`.
- `db push` applied both. `migration list` shows both as local and remote.

## 2. Remote schema: verified (Claude, read-only queries)
| Item | Result |
|---|---|
| `public.profiles` RLS | enabled (`relrowsecurity = true`) |
| Policies | `profiles_select_own` (SELECT), `profiles_update_own` (UPDATE), both `id = auth.uid()`; no INSERT/DELETE policy |
| Triggers | `profiles_touch_updated_at` on `profiles`; `on_auth_user_created` on `auth.users` |
| Constraints | PK `id`; FK to `auth.users(id)` ON DELETE CASCADE; `display_name` 1-50 chars; `avatar_url` `https://` and <= 2048 chars |
| Column grants | `authenticated` UPDATE on `display_name`, `avatar_url` only; `anon` no write |

## 3. Live behaviour with two real users: 15/15 passed (Claude, supabase-js with the publishable key)
Sign-up A and B return sessions; trigger creates one profile each (name from `display_name` metadata, fallback `name`); each user reads only their own row; A updates own profile and `updated_at` moves forward; A updating B's row changes 0 rows and B is unchanged; updating `created_at` or `id` is denied; client insert and delete are denied; `javascript:` avatar and 51-char name are rejected by the CHECKs; anon reads nothing.

## 4. Browser flow: Manual
Sign-up, sign-in, refresh persistence, profile edit (persists after refresh), sign-out, sign-in again: all worked.
**Loading state: failed first time.** On Slow 3G the page was blank white until the JS bundle arrived, because the only "Loading…" was React code. Fixed with a static "Loading…" placeholder inside `#root` in `index.html`; re-tested manually, shows immediately.

## 5. Google sign-in: verified
- Manual: "Continue with Google" completed and returned signed in.
- Claude: query shows an `auth.users` row with provider `google` and a `profiles` row with `display_name` "Russel Reambillo".
- Setup problems met and fixed: provider not enabled in Supabase (`Unsupported provider`); redirect URI missing from the Google OAuth client (`redirect_uri_mismatch`).

## Not verified / known gaps
- Email confirmation flow (tested with *Confirm email* off only).
- Google `avatar_url` is not copied to `profiles` (trigger only copies the name); `has_avatar = false`.
- `anon` and `authenticated` still hold table-level TRUNCATE/TRIGGER/REFERENCES (Supabase default; not reachable through the API; a revoke migration is optional).
- Only `http://localhost:5173` was tested; production Site URL / Redirect URLs not configured. Google consent screen is in Testing mode (only listed test users can sign in).
- Test users (`reambillo.russel+mwa…`, `+mwb…`, and the manual sign-up) remain in the project; delete them under Authentication -> Users.
