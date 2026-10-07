# MoneyWhere

Money-tracking PWA. Spec: `01-APP-SPEC.md` · Roadmap: `02-ROADMAP.md` · History: `03-CHANGELOG.md`.

```
npm install
cp .env.example .env.local     # fill VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (public values only)
npm run dev | build | preview | test | lint | typecheck
```

Layout: `src/domain/` is pure TypeScript (no React/Supabase/DOM; enforced by ESLint). All money is integer
minor units (`10050` = ₱100.50). UI imports from `domain`, never the reverse.

## Environments

| | Supabase project | `VITE_AUTH_REDIRECT_URL` |
|---|---|---|
| Local dev (`.env.local`) | development project | unset (defaults to `http://localhost:5173`) |
| Vercel Preview | development project | unset (each preview deployment uses its own origin) |
| Vercel Production | **separate production project** | the canonical production origin, no trailing slash |

The three `VITE_*` variables are the only configuration the app reads. They are baked in at build time (change one, redeploy) and contain public values only: the project URL and the anon key. The `service_role` key, SMTP credentials and the Google client secret must never be put in the repository, in `VITE_*` variables or in Vercel's environment; they live in the Supabase dashboard only.

**Keep dev and production isolated.** The hosted test suites (`supabase/hosted/*`) and `supabase/hosted/cleanup.mjs` use the project that `supabase link` points at (`supabase/.temp/project-ref`) and `.env.local`. Do not link the production project in this working copy. As a backstop, every hosted script (`supabase/hosted/*.verify.ts` and `cleanup.mjs`) first runs `supabase/hosted/guard.mjs`, which refuses unless `.env.local`, the linked project and the approved development list (`sitlhdkfihzmdzxfrliv`) all agree; a production project can never pass it. For production migrations pass the project explicitly (`npx supabase db push --project-ref <production-ref> --dry-run`, then without `--dry-run`) or use a separate checkout, and never run the hosted suites or `cleanup.mjs --apply` against production.

## Supabase setup (once per project)

Apply the migrations (`supabase/migrations`, forward-only): `npx supabase login`, then `npx supabase db push --project-ref <ref> --dry-run` to preview and the same without `--dry-run` to apply.

### Auth
1. **Authentication, URL Configuration:** *Site URL* is the project's own origin (production: the canonical custom domain). *Redirect URLs* lists only what that project needs: production = the production origin and `<origin>/**`, no localhost; development = `http://localhost:5173` and any preview origins you use.
2. **Providers, Email:** enabled. Production uses **Confirm email on**; sign-up then shows "Check your email to confirm your account, then sign in." Set the minimum password length to 8 or more (the app also enforces 8).
3. **Anonymous sign-ins:** off.
4. **SMTP (production):** configure custom SMTP with a verified sender under *Authentication, SMTP settings*. Supabase's built-in mailer is for development only (rate-limited, not for real users). Credentials go in the dashboard, not in this repository.
5. **Providers, Google:** create a Web OAuth client in Google Cloud Console (a separate client for production). Authorized redirect URI = `https://<project-ref>.supabase.co/auth/v1/callback` of the same project; authorized JavaScript origin = the app origin (optional for this redirect flow). Paste the client ID and secret into that Supabase project's Google provider and enable it. Publish the OAuth consent screen ("In production") or only listed test users can sign in.

Common Google errors: `Unsupported provider` = provider not enabled in Supabase; `redirect_uri_mismatch` = the callback URL above is missing from *Authorized redirect URIs* (not *JavaScript origins*) of the Google OAuth client.

If the project uses a custom Supabase domain, add it to the `connect-src` directive in `vercel.json`.

## Deploying (Vercel)

- Framework preset Vite; build command `npm run build`; output directory `dist`. Node 24 (`engines.node` in `package.json`).
- Set the variables from the table above for Production and Preview. `vercel.json` adds the security headers (nosniff, frame denial, referrer and permissions policies, and a Content-Security-Policy that allows only the app's own origin plus `https://*.supabase.co` and `wss://*.supabase.co` for the API and Realtime). No rewrites are needed: the app has no client-side routes.
- The service worker caches the app shell only and updates automatically on the next visit after a deploy.

### Production verification checklist
1. The app loads over HTTPS from the canonical origin and no development origin appears in the Supabase redirect list or in `VITE_AUTH_REDIRECT_URL`.
2. Sign-up with a dedicated test address: the confirmation email arrives from the configured sender and its link returns to the production origin signed in.
3. Email/password sign-in, sign-out and sign-in again; Google sign-in.
4. Profile, a wallet and Transactions load; create, edit and delete one temporary transaction; remove the test data afterwards.
5. The browser console shows no Content-Security-Policy violations, Realtime shows "Live", and the app can be installed as a PWA.

Verified against a hosted project on 2026-10-06 (the development project), including what was *not* checked: see `supabase/VERIFICATION.md`. Production has not been configured or verified yet.

Tests: `npm test` also runs `supabase/tests/*` — the real migrations/RLS executed in in-process Postgres (PGlite) with a stubbed `auth` schema.
