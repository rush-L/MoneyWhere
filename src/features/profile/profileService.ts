import type { SupabaseClient } from '@supabase/supabase-js'
import { profileFromRow, type Profile, type ProfileRow } from './profile'

/** Message is always safe to show to the user. */
export class ProfileError extends Error {}

function fail(message: string, err: unknown): never {
  console.error('[profile]', err)
  throw new ProfileError(message)
}

// Identity always comes from the session (`userId`); RLS enforces it server-side regardless.
export function createProfileService(client: SupabaseClient) {
  return {
    async get(userId: string): Promise<Profile> {
      const { data, error } = await client.from('profiles').select('*').eq('id', userId).maybeSingle<ProfileRow>()
      if (error) fail('Could not load your profile. Please try again.', error)
      if (!data) fail('Your profile was not found. Please sign out and back in.', 'no profile row')
      return profileFromRow(data)
    },
    async update(userId: string, v: { display_name: string | null; avatar_url: string | null }): Promise<Profile> {
      const { data, error } = await client.from('profiles').update(v).eq('id', userId).select('*').maybeSingle<ProfileRow>()
      if (error) fail('Could not save your profile. Please try again.', error)
      if (!data) fail('Could not save your profile. Please sign in again.', 'update matched 0 rows')
      return profileFromRow(data)
    },
  }
}

export type ProfileService = ReturnType<typeof createProfileService>
