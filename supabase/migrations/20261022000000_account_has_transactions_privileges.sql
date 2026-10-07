-- Pre-production hardening: account_has_transactions(uuid) is SECURITY DEFINER and was executable by PUBLIC and anon
-- (Supabase also grants execute on new functions to anon directly), so it was callable through the Data API without a
-- session as a yes/no "does this account id have transactions" check.
-- Only signed-in users need it: it is called by the accounts delete policy and by the accounts history trigger
-- (accounts_guard_history), and both run as the calling role (`authenticated`). anon has no access to accounts at all.
-- The function body, return value and security mode are unchanged. service_role keeps Supabase's default access.
revoke execute on function public.account_has_transactions(uuid) from public, anon;
grant execute on function public.account_has_transactions(uuid) to authenticated;
