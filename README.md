# MoneyWhere

Money-tracking PWA. Spec: `01-APP-SPEC.md` · Roadmap: `02-ROADMAP.md` · History: `03-CHANGELOG.md`.

```
npm install
cp .env.example .env.local     # fill VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (public values only)
npm run dev | build | preview | test | lint | typecheck
```

Layout: `src/domain/` is pure TypeScript (no React/Supabase/DOM; enforced by ESLint). All money is integer
minor units (`10050` = ₱100.50). UI imports from `domain`, never the reverse.

## Auth setup (Supabase dashboard)
1. **Auth → URL Configuration:** set *Site URL* to the deployed origin and add every origin you use (e.g. `http://localhost:5173`, the Vercel URL) to *Redirect URLs*. Optionally set `VITE_AUTH_REDIRECT_URL`.
2. **Auth → Providers → Email:** enabled by default. If *Confirm email* is on, sign-up shows "check your email".
3. **Auth → Providers → Google:** create an OAuth client (Web) in Google Cloud Console; authorized redirect URI = `https://<project-ref>.supabase.co/auth/v1/callback`; paste Client ID/Secret into Supabase and enable.
4. Apply migrations: `npx supabase login`, then `npx supabase link --project-ref <ref>`, `npx supabase db push --dry-run` (preview), `npx supabase db push`.

Verified against a hosted project on 2026-10-06, including what was *not* checked: see `supabase/VERIFICATION.md`.

Common Google errors: `Unsupported provider` = provider not enabled in Supabase; `redirect_uri_mismatch` = the callback URL above is missing from *Authorized redirect URIs* (not *JavaScript origins*) of the Google OAuth client.

Tests: `npm test` also runs `supabase/tests/*` — the real migrations/RLS executed in in-process Postgres (PGlite) with a stubbed `auth` schema.
