-- Phase 14: profiles still carried Supabase's default table grants. authenticated could TRUNCATE the table (RLS does
-- not apply to TRUNCATE) and anon held SELECT/TRIGGER/REFERENCES/TRUNCATE. Every other table was already reset with
-- `revoke all` in its own migration; this does the same for profiles.
-- Resulting access: authenticated = SELECT + UPDATE (display_name, avatar_url) only; anon = nothing.
-- Rollback (forward migration): grant the removed privileges back; none is used by the app.
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name, avatar_url) on public.profiles to authenticated;
