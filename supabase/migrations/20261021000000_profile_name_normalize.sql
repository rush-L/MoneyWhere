-- Phase C-3: a Google (or other OAuth) display name longer than 50 characters, or a blank one, violated
-- profiles_display_name_len inside the signup trigger and failed the whole signup. Normalise the incoming name instead.
-- The constraint is unchanged (btrim(display_name) must be 1-50 characters).
--   * name within the limit: stored exactly as before
--   * longer than 50 after trimming: trimmed, then cut to its first 50 characters
--   * missing or blank: no display name (NULL), the user can set one in Profile
-- Avatar handling is identical to 20261020000000_profile_avatar_from_oauth.sql. Existing profiles are not touched.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := coalesce(new.raw_user_meta_data ->> 'display_name', new.raw_user_meta_data ->> 'name');
  v_avatar text := coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture');
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    case
      when v_name is null or char_length(btrim(v_name)) = 0 then null
      when char_length(btrim(v_name)) <= 50 then v_name
      else left(btrim(v_name), 50)
    end,
    case when v_avatar ~ '^https://[^\s]+$' and char_length(v_avatar) <= 2048 then v_avatar end
  );
  return new;
end $$;
