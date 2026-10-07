import { describe, expect, it } from 'vitest'
import { parseProfileInput, profileFromRow } from './profile'

describe('profileFromRow', () => {
  it('maps snake_case row to domain', () => {
    expect(
      profileFromRow({ id: 'u', display_name: 'Al', avatar_url: null, created_at: 'c', updated_at: 'u2' }),
    ).toEqual({ id: 'u', displayName: 'Al', avatarUrl: null, createdAt: 'c', updatedAt: 'u2' })
  })
})

describe('parseProfileInput', () => {
  it('trims and nulls empties', () => {
    expect(parseProfileInput({ displayName: '  ', avatarUrl: '' })).toEqual({ ok: true, value: { display_name: null, avatar_url: null } })
    expect(parseProfileInput({ displayName: ' Al ', avatarUrl: 'https://i.test/a.png' })).toEqual({
      ok: true,
      value: { display_name: 'Al', avatar_url: 'https://i.test/a.png' },
    })
  })
  it('rejects long names and non-https / malformed avatar URLs', () => {
    expect(parseProfileInput({ displayName: 'x'.repeat(51), avatarUrl: '' }).ok).toBe(false)
    for (const url of ['http://a.test/x.png', 'javascript:alert(1)', 'not a url', 'data:image/png;base64,AAAA'])
      expect(parseProfileInput({ displayName: '', avatarUrl: url }).ok).toBe(false)
  })
})
