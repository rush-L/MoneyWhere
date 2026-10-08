// Hosted verification for Phase D6 (ownership transfer). NOT part of `npm test` (touches the real dev project).
// Run: npx vitest run --config supabase/hosted/vitest.hosted.config.ts supabase/hosted/ownership
// Users are real anon-key clients; membership is built through the real invitation RPCs. The Management API is used
// only to inspect state and to clean up.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertDevProject } from './guard.mjs'

assertDevProject()

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
)
const dir = mkdtempSync(join(tmpdir(), 'mwverify-'))
function sql<T = Record<string, unknown>>(q: string): T[] {
  const f = join(dir, 'q.sql')
  writeFileSync(f, q)
  const out = execFileSync('npx', ['supabase', 'db', 'query', '--linked', '-f', f], { encoding: 'utf8', shell: true })
  return JSON.parse(out.slice(out.indexOf('{'))).rows
}

const tag = `mwown${Date.now()}`
const PW = `Tx!${Math.random().toString(36).slice(2)}Aa1`
const anon = () => createClient(env.VITE_SUPABASE_URL!, env.VITE_SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } })
type U = { c: SupabaseClient; id: string }
async function user(n: string): Promise<U> {
  const c = anon()
  const { data, error } = await c.auth.signUp({ email: `reambillo.russel+${tag}${n}@gmail.com`, password: PW })
  if (error || !data.session) throw new Error(`signup ${n}: ${error?.message ?? 'no session'}`)
  return { c, id: data.user!.id }
}
const mkWallet = async (u: U, name: string) => {
  const { data, error } = await u.c.rpc('create_wallet', { p_name: name })
  if (error) throw error
  return (data as { id: string }).id
}
const join_ = async (owner: U, w: string, m: U) => {
  const inv = await owner.c.rpc('create_wallet_invitation', { p_wallet_id: w })
  if (inv.error) throw inv.error
  const r = await m.c.rpc('accept_wallet_invitation', { p_token: (inv.data as { token: string }).token })
  if (r.error || !(r.data as { ok: boolean }).ok) throw new Error('join failed')
}
const xfer = (u: U, w: string, to: string) => u.c.rpc('transfer_wallet_ownership', { p_wallet_id: w, p_new_owner: to })
const roles = (w: string) => Object.fromEntries(sql<{ user_id: string; role: string }>(`select user_id, role from public.wallet_members where wallet_id='${w}'`).map((r) => [r.user_id, r.role]))

let A: U, B: U, C: U, D: U, F: U, G: U, N: { c: SupabaseClient }
let WA: string, WC: string
const created: string[] = []

beforeAll(async () => {
  ;[A, B, C, D, F, G] = [await user('a'), await user('b'), await user('c'), await user('d'), await user('f'), await user('g')]
  N = { c: anon() }
  WA = await mkWallet(A, `${tag}-WA`)
  WC = await mkWallet(C, `${tag}-WC`)
  created.push(WA, WC)
  for (const m of [B, D, F]) await join_(A, WA, m)
  await join_(C, WC, G)
  // history: one account/category/budget/transaction each from A and B
  const acct = crypto.randomUUID()
  expect((await A.c.from('accounts').insert({ id: acct, wallet_id: WA, name: 'Cash', type: 'cash', opening_balance_minor: 0 })).error).toBeNull()
  const cat = (await A.c.from('categories').select('id').eq('wallet_id', WA).limit(1).single()).data!.id as string
  expect((await A.c.from('budgets').insert({ id: crypto.randomUUID(), wallet_id: WA, category_id: cat, month: '2026-10-01', amount_minor: 5000 })).error).toBeNull()
  for (const u of [A, B]) expect((await u.c.from('transactions').insert({ id: crypto.randomUUID(), account_id: acct, category_id: cat, type: 'expense', amount_minor: 100, date: '2026-10-05' })).error).toBeNull()
  expect((await A.c.rpc('remove_wallet_member', { p_wallet_id: WA, p_user_id: F.id })).error).toBeNull() // F -> former member
}, 180_000)

afterAll(() => {
  const ids = created.map((i) => `'${i}'`).join(',')
  const uids = [A, B, C, D, F, G].filter(Boolean).map((u) => `'${u.id}'`).join(',')
  if (ids) sql(`delete from public.wallets where id in (${ids})`)
  if (uids) sql(`delete from auth.users where id in (${uids})`)
  console.log('CLEANUP leftover', sql(`select (select count(*) from public.wallets where name like '${tag}%')::int w, (select count(*) from auth.users where email like '%${tag}%')::int u`)[0], 'tag', tag)
}, 120_000)

const history = () =>
  JSON.stringify(sql(`select (select json_agg(t order by t.id) from public.transactions t where wallet_id='${WA}') tx,
                             (select json_agg(a order by a.id) from public.accounts a where wallet_id='${WA}') ac,
                             (select json_agg(c order by c.id) from public.categories c where wallet_id='${WA}') ca,
                             (select json_agg(b order by b.id) from public.budgets b where wallet_id='${WA}') bu,
                             (select to_json(w) from public.wallets w where id='${WA}') w`))

describe('rejections (hosted)', () => {
  it('member, outsider and anon cannot transfer; bad targets are rejected; state unchanged', async () => {
    expect((await xfer(B, WA, B.id)).error?.code).toBe('42501')
    expect((await xfer(B, WA, D.id)).error?.code).toBe('42501')
    expect((await xfer(C, WA, B.id)).error?.code).toBe('42501')
    expect((await xfer(N as U, WA, B.id)).error).toBeTruthy()
    expect((await xfer(A, WA, C.id)).error?.code).toBe('P0002') // outsider
    expect((await xfer(A, WA, G.id)).error?.code).toBe('P0002') // member of ANOTHER wallet
    expect((await xfer(A, WA, F.id)).error?.code).toBe('P0002') // former member
    expect((await xfer(A, WA, A.id)).error?.code).toBe('22023') // already owner
    expect((await xfer(A, crypto.randomUUID(), B.id)).error?.code).toBe('42501') // no such wallet
    expect(await roles(WA)).toEqual({ [A.id]: 'owner', [B.id]: 'member', [D.id]: 'member' })
    expect((await B.c.from('wallet_members').update({ role: 'owner' }).eq('wallet_id', WA).eq('user_id', B.id)).error).toBeTruthy()
  })
})

describe('transfer A -> B (hosted)', () => {
  let before: string
  it('succeeds; roles swap; one owner; history unchanged', async () => {
    before = history()
    expect((await xfer(A, WA, B.id)).error).toBeNull()
    expect(await roles(WA)).toEqual({ [A.id]: 'member', [B.id]: 'owner', [D.id]: 'member' })
    expect(history()).toBe(before)
    const tx = sql<{ created_by: string; paid_by_user_id: string }>(`select created_by, paid_by_user_id from public.transactions where wallet_id='${WA}'`)
    expect(tx.map((t) => t.created_by).sort()).toEqual([A.id, B.id].sort())
    expect(tx.every((t) => t.created_by === t.paid_by_user_id)).toBe(true)
  })
  it('D5 list shows both as current members with swapped roles', async () => {
    const r = await A.c.rpc('list_wallet_members', { p_wallet_id: WA })
    expect(r.error).toBeNull()
    expect(Object.fromEntries((r.data as { user_id: string; role: string }[]).map((m) => [m.user_id, m.role]))).toEqual({ [A.id]: 'member', [B.id]: 'owner', [D.id]: 'member' })
  })
  it('new owner has owner rights; previous owner lost them but stays a member', async () => {
    expect((await B.c.rpc('create_wallet_invitation', { p_wallet_id: WA })).error).toBeNull()
    expect((await A.c.rpc('create_wallet_invitation', { p_wallet_id: WA })).error?.code).toBe('42501')
    expect((await A.c.rpc('remove_wallet_member', { p_wallet_id: WA, p_user_id: D.id })).error?.code).toBe('42501')
    expect((await xfer(A, WA, D.id)).error?.code).toBe('42501')
    expect((await A.c.from('accounts').insert({ id: crypto.randomUUID(), wallet_id: WA, name: 'X', type: 'cash', opening_balance_minor: 0 })).error).toBeTruthy()
    expect((await A.c.from('wallets').select('id').eq('id', WA)).data).toHaveLength(1)
  })
})

describe('concurrency (hosted, separate connections)', () => {
  it('two simultaneous transfers by the same owner: exactly one wins, exactly one owner remains', async () => {
    const [r1, r2] = await Promise.all([xfer(B, WA, A.id), xfer(B, WA, D.id)])
    const ok = [r1, r2].filter((r) => !r.error)
    expect(ok).toHaveLength(1)
    expect([r1, r2].find((r) => r.error)!.error!.code).toBe('42501')
    const rs = await roles(WA)
    expect(Object.values(rs).filter((r) => r === 'owner')).toHaveLength(1)
    expect(Object.keys(rs).sort()).toEqual([A.id, B.id, D.id].sort())
    expect(rs[B.id]).toBe('member')
  })
})
