-- Phase 14: copy the OAuth avatar (Google sends `picture`, some providers `avatar_url`) into profiles.avatar_url at signup.
-- The value is user-controllable metadata, so it is copied only when it already satisfies profiles_avatar_url_https;
-- otherwise it is dropped (never fail the signup). Existing profiles are not touched.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_avatar text := coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture');
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', new.raw_user_meta_data ->> 'name'),
    case when v_avatar ~ '^https://[^\s]+$' and char_length(v_avatar) <= 2048 then v_avatar end
  );
  return new;
end $$;
