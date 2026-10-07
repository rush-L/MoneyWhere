// Hosted verification for Phase 14: profile grants and OAuth-avatar copy. NOT part of `npm test`.
// Run: npx vitest run --config supabase/hosted/vitest.hosted.config.ts supabase/hosted/profiles.verify.ts
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { afterAll, describe, expect, it } from 'vitest'
import { assertDevProject } from './guard.mjs'

assertDevProject() // refuses unless .env.local, the linked project and the approved dev list agree

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
)
const dir = mkdtempSync(join(tmpdir(), 'mwpro-'))
function sql<T = Record<string, unknown>>(q: string): T[] {
  const f = join(dir, 'q.sql')
  writeFileSync(f, q)
  const out = execFileSync('npx', ['supabase', 'db', 'query', '--linked', '-f', f], { encoding: 'utf8', shell: true })
  return JSON.parse(out.slice(out.indexOf('{'))).rows
}
const tag = `mwpro${Date.now()}`
const PW = `Pro!${Math.random().toString(36).slice(2)}Aa1`
const client = () => createClient(env.VITE_SUPABASE_URL!, env.VITE_SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } })
const ids: string[] = []
async function signUp(n: string, data: Record<string, unknown>) {
  const c = client()
  const { data: d, error } = await c.auth.signUp({ email: `reambillo.russel+${tag}${n}@gmail.com`, password: PW, options: { data } })
  if (error || !d.session) throw new Error(`signup ${n}: ${error?.message ?? 'no session'}`)
  ids.push(d.user!.id)
  return { c, id: d.user!.id }
}

afterAll(() => {
  if (ids.length) sql(`delete from auth.users where id in (${ids.map((i) => `'${i}'`).join(',')})`)
  console.log('CLEANUP leftover', sql(`select count(*)::int u from auth.users where email like '%${tag}%'`)[0])
}, 120_000)

describe('profile avatar copied from OAuth metadata (hosted trigger)', () => {
  it('valid https picture is copied; unsafe or missing is dropped and signup still succeeds', async () => {
    const a = await signUp('a', { picture: 'https://lh3.example/a.png', name: 'Pic User' })
    const b = await signUp('b', { picture: 'javascript:alert(1)' })
    const c = await signUp('c', {})
    const get = async (u: { c: ReturnType<typeof client>; id: string }) => (await u.c.from('profiles').select('display_name, avatar_url').eq('id', u.id).single()).data
    expect(await get(a)).toEqual({ display_name: 'Pic User', avatar_url: 'https://lh3.example/a.png' })
    expect((await get(b))?.avatar_url).toBeNull()
    expect((await get(c))?.avatar_url).toBeNull()
  }, 60_000)
})

describe('profiles table privileges on the live project', () => {
  it('authenticated: select + update(display_name, avatar_url) only; no truncate/insert/delete; anon: nothing', async () => {
    const u = await signUp('d', {})
    expect((await u.c.from('profiles').update({ display_name: 'New' }).eq('id', u.id).select('id')).data).toHaveLength(1)
    expect((await u.c.from('profiles').update({ created_at: new Date().toISOString() }).eq('id', u.id)).error).not.toBeNull()
    expect((await u.c.from('profiles').delete().eq('id', u.id)).error).not.toBeNull()
    expect((await u.c.from('profiles').insert({ id: crypto.randomUUID() })).error).not.toBeNull()
    const anon = await client().from('profiles').select('id')
    expect(anon.error?.code).toBe('42501') // permission denied (was: RLS silently returned no rows)
    const priv = sql<{ grantee: string; p: string }>(`select grantee, privilege_type p from information_schema.role_table_grants where table_schema='public' and table_name='profiles' and grantee in ('anon','authenticated')`)
    expect(priv).toEqual([{ grantee: 'authenticated', p: 'SELECT' }])
  }, 60_000)
})
