-- Phase 2: profile correctness fixes on top of 20261006000000_profiles.sql.

-- 1. Input constraints (also stops javascript:/data: avatar URLs).
alter table public.profiles
  add constraint profiles_display_name_len check (display_name is null or char_length(btrim(display_name)) between 1 and 50),
  add constraint profiles_avatar_url_https check (avatar_url is null or (avatar_url ~ '^https://[^\s]+$' and char_length(avatar_url) <= 2048));

-- 2. Clients may only write the two editable columns (not id / created_at / updated_at).
revoke update on public.profiles from anon, authenticated;
grant update (display_name, avatar_url) on public.profiles to authenticated;
revoke insert, delete on public.profiles from anon, authenticated;

-- 3. updated_at maintenance.
create function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger profiles_touch_updated_at before update on public.profiles
  for each row execute function public.touch_updated_at();
