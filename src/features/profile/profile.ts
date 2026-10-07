export interface ProfileRow {
  id: string
  display_name: string | null
  avatar_url: string | null
  created_at: string
  updated_at: string
}

export interface Profile {
  id: string
  displayName: string | null
  avatarUrl: string | null
  createdAt: string
  updatedAt: string
}

export function profileFromRow(r: ProfileRow): Profile {
  return { id: r.id, displayName: r.display_name, avatarUrl: r.avatar_url, createdAt: r.created_at, updatedAt: r.updated_at }
}

export interface ProfileInput {
  displayName: string
  avatarUrl: string
}

/** Validates form input and returns DB-ready values (empty -> null). Mirrors the DB CHECK constraints. */
export function parseProfileInput(
  input: ProfileInput,
): { ok: true; value: { display_name: string | null; avatar_url: string | null } } | { ok: false; error: string } {
  const name = input.displayName.trim()
  if (name.length > 50) return { ok: false, error: 'Display name must be 50 characters or fewer.' }
  const url = input.avatarUrl.trim()
  if (url) {
    let valid = url.length <= 2048 && !/\s/.test(url)
    try {
      valid = valid && new URL(url).protocol === 'https:'
    } catch {
      valid = false
    }
    if (!valid) return { ok: false, error: 'Avatar must be a valid https:// image URL.' }
  }
  return { ok: true, value: { display_name: name || null, avatar_url: url || null } }
}
