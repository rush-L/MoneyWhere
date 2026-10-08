// Hosted verification for Phase D7 (Who Paid / Received by). NOT part of `npm test` (touches the real dev project).
// Run: npx vitest run --config supabase/hosted/vitest.hosted.config.ts supabase/hosted/who_paid
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

const tag = `mwpaid${Date.now()}`
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

type Tx = { id: string; type: string; created_by: string; paid_by_user_id: string | null; version: number; amount_minor: number }
const get = (c: SupabaseClient, id: string) => c.from('transactions').select('*').eq('id', id).single<Tx>().then((r) => r.data!)
const basePayload = (o: Record<string, unknown> = {}) => ({
  type: 'expense', account_id: acct, destination_account_id: null, category_id: cat, amount_minor: 100, date: '2026-10-05', note: null, ...o,
})
const insert = (c: SupabaseClient, o: Record<string, unknown> = {}) => {
  const id = crypto.randomUUID()
  return c.from('transactions').insert({ id, ...basePayload(), ...o }).then((r) => ({ id, error: r.error }))
}
const edit = async (c: SupabaseClient, id: string, p: Record<string, unknown>) => {
  const cur = await get(c, id)
  return c.rpc('apply_transaction_mutation', { p_mutation_id: crypto.randomUUID(), p_op: 'UPDATE', p_transaction_id: id, p_expected_version: cur.version, p_payload: p, p_own_only: false })
}
const status = (r: { data: unknown }) => (r.data as { status: string } | null)?.status

let A: U, B: U, C: U, D: U, F: U
let N: { c: SupabaseClient }
let WA: string, WD: string
let acct: string, acctD: string, cat: string, catD: string, acct2: string
const created: string[] = []

beforeAll(async () => {
  ;[A, B, C, D, F] = [await user('a'), await user('b'), await user('c'), await user('d'), await user('f')]
  N = { c: anon() }
  WA = await mkWallet(A, `${tag}-WA`)
  WD = await mkWallet(D, `${tag}-WD`)
  created.push(WA, WD)
  for (const m of [B, C, F]) await join_(A, WA, m)
  acct = crypto.randomUUID(); acct2 = crypto.randomUUID(); acctD = crypto.randomUUID()
  for (const [id, w, u] of [[acct, WA, A], [acct2, WA, A], [acctD, WD, D]] as const)
    expect((await u.c.from('accounts').insert({ id, wallet_id: w, name: 'Cash', type: 'cash', opening_balance_minor: 0 })).error).toBeNull()
  cat = (await A.c.from('categories').select('id').eq('wallet_id', WA).limit(1).single()).data!.id as string
  catD = (await D.c.from('categories').select('id').eq('wallet_id', WD).limit(1).single()).data!.id as string
  expect((await A.c.rpc('remove_wallet_member', { p_wallet_id: WA, p_user_id: F.id })).error).toBeNull() // F -> former member
}, 240_000)

afterAll(() => {
  const ids = created.map((i) => `'${i}'`).join(',')
  const uids = [A, B, C, D, F].filter(Boolean).map((u) => `'${u.id}'`).join(',')
  if (ids) sql(`delete from public.wallets where id in (${ids})`)
  if (uids) sql(`delete from auth.users where id in (${uids})`)
  console.log('CLEANUP leftover', sql(`select (select count(*) from public.wallets where name like '${tag}%')::int w, (select count(*) from auth.users where email like '%${tag}%')::int u`)[0], 'tag', tag)
}, 120_000)

describe('defaults and alternate payer / recipient (hosted)', () => {
  for (const type of ['expense', 'income'] as const) {
    const o = type === 'income' ? { type, category_id: null } : { type }
    it(`${type}: defaults to the creator`, async () => {
      const { id, error } = await insert(A.c, o)
      expect(error).toBeNull()
      const t = await get(A.c, id)
      expect([t.created_by, t.paid_by_user_id]).toEqual([A.id, A.id])
    })
    it(`${type}: Alice records Bella, created_by stays Alice`, async () => {
      const { id, error } = await insert(A.c, { ...o, paid_by_user_id: B.id })
      expect(error).toBeNull()
      const t = await get(A.c, id)
      expect([t.created_by, t.paid_by_user_id]).toEqual([A.id, B.id])
    })
  }
  it('a plain member may record another current member', async () => {
    const { id, error } = await insert(B.c, { paid_by_user_id: C.id })
    expect(error).toBeNull()
    expect((await get(B.c, id)).paid_by_user_id).toBe(C.id)
  })
})

describe('invalid payers are rejected on create (hosted)', () => {
  it('outsider, other-wallet member, former member, unknown id, non-uuid, anonymous', async () => {
    for (const bad of [D.id, F.id, crypto.randomUUID(), 'not-a-uuid']) {
      const r = await insert(A.c, { paid_by_user_id: bad })
      expect(r.error, `payer ${bad}`).toBeTruthy()
      expect((await A.c.from('transactions').select('id').eq('id', r.id)).data).toHaveLength(0)
    }
    expect((await insert(N.c, { paid_by_user_id: A.id })).error).toBeTruthy()
  })
  it('cross-wallet: D cannot use WA data, nor name WA members in WD', async () => {
    expect((await insert(D.c, { paid_by_user_id: A.id, account_id: acctD, category_id: catD })).error).toBeTruthy()
    expect((await insert(D.c, { paid_by_user_id: B.id, account_id: acctD, category_id: catD })).error).toBeTruthy()
    expect((await insert(D.c)).error).toBeTruthy() // WA account
    const own = await insert(D.c, { account_id: acctD, category_id: catD })
    expect(own.error).toBeNull()
    expect((await get(D.c, own.id)).paid_by_user_id).toBe(D.id)
  })
  it('created_by cannot be supplied', async () => {
    expect((await insert(A.c, { created_by: B.id })).error).toBeTruthy()
  })
})

describe('edit through apply_transaction_mutation (hosted)', () => {
  it('Bella to Charlie changes only paid_by_user_id and bumps the version', async () => {
    const { id } = await insert(A.c, { paid_by_user_id: B.id })
    const before = await get(A.c, id)
    expect(status(await edit(A.c, id, basePayload({ paid_by_user_id: C.id })))).toBe('APPLIED')
    const after = await get(A.c, id)
    expect([after.created_by, after.paid_by_user_id, after.amount_minor]).toEqual([A.id, C.id, before.amount_minor])
    expect(after.version).toBe(before.version + 1)
  })
  it('created_by in the payload is ignored', async () => {
    const { id } = await insert(A.c, { paid_by_user_id: B.id })
    await edit(A.c, id, basePayload({ paid_by_user_id: C.id, created_by: C.id }))
    expect((await get(A.c, id)).created_by).toBe(A.id)
  })
  it('outsider, other-wallet, former, unknown and non-uuid payers are rejected; row unchanged', async () => {
    const { id } = await insert(A.c, { paid_by_user_id: B.id })
    for (const bad of [D.id, F.id, crypto.randomUUID(), 'not-a-uuid'])
      expect((await edit(A.c, id, basePayload({ paid_by_user_id: bad }))).error, `payer ${bad}`).toBeTruthy()
    expect((await get(A.c, id)).paid_by_user_id).toBe(B.id)
    expect((await N.c.rpc('apply_transaction_mutation', { p_mutation_id: crypto.randomUUID(), p_op: 'UPDATE', p_transaction_id: id, p_expected_version: 1, p_payload: basePayload({ paid_by_user_id: C.id }), p_own_only: false })).error).toBeTruthy() // anonymous
  })
  it('authorization unchanged: a member cannot re-attribute the owner’s transaction; the owner can re-attribute a member’s', async () => {
    const { id } = await insert(A.c)
    expect(status(await edit(B.c, id, basePayload({ paid_by_user_id: B.id })))).toBe('FORBIDDEN')
    const mine = await insert(B.c)
    expect(status(await edit(A.c, mine.id, basePayload({ paid_by_user_id: C.id })))).toBe('APPLIED')
    const t = await get(A.c, mine.id)
    expect([t.created_by, t.paid_by_user_id]).toEqual([B.id, C.id])
  })
})

describe('transfers (hosted)', () => {
  it('a transfer has no payer even if one is sent, and stays payer-less through edits', async () => {
    const x = { type: 'transfer', category_id: null, destination_account_id: acct2 }
    const { id, error } = await insert(A.c, { ...x, paid_by_user_id: B.id })
    expect(error).toBeNull()
    expect((await get(A.c, id)).paid_by_user_id).toBeNull()
    expect(status(await edit(A.c, id, basePayload({ ...x, paid_by_user_id: C.id })))).toBe('APPLIED')
    expect((await get(A.c, id)).paid_by_user_id).toBeNull()
  })
})

describe('former member history and D6 ownership (hosted)', () => {
  it('Bella leaves: created_by/paid_by unchanged; an unrelated edit keeps her; she cannot be assigned again; D5 hides her', async () => {
    const { id } = await insert(A.c, { paid_by_user_id: B.id })
    const mine = await insert(B.c, { paid_by_user_id: B.id })
    expect((await A.c.rpc('remove_wallet_member', { p_wallet_id: WA, p_user_id: B.id })).error).toBeNull()
    for (const tid of [id, mine.id]) {
      const t = await get(A.c, tid)
      expect(t.paid_by_user_id).toBe(B.id)
    }
    expect((await get(A.c, id)).created_by).toBe(A.id)
    expect(status(await edit(A.c, id, basePayload({ paid_by_user_id: B.id, amount_minor: 250 })))).toBe('APPLIED')
    expect((await get(A.c, id)).paid_by_user_id).toBe(B.id)
    expect((await insert(A.c, { paid_by_user_id: B.id })).error).toBeTruthy()
    expect((await edit(A.c, id, basePayload({ paid_by_user_id: F.id }))).error).toBeTruthy()
    const members = (await A.c.rpc('list_wallet_members', { p_wallet_id: WA })).data as { user_id: string }[]
    expect(members.map((m) => m.user_id).sort()).toEqual([A.id, C.id].sort()) // no former-member profile is returned
  })
  it('D6 ownership transfer still works and leaves payer attribution untouched', async () => {
    const { id } = await insert(A.c, { paid_by_user_id: C.id })
    expect((await A.c.rpc('transfer_wallet_ownership', { p_wallet_id: WA, p_new_owner: C.id })).error).toBeNull()
    const t = await get(C.c, id)
    expect([t.created_by, t.paid_by_user_id]).toEqual([A.id, C.id])
    expect(status(await edit(C.c, id, basePayload({ paid_by_user_id: A.id })))).toBe('APPLIED') // new owner may re-attribute
    expect((await get(C.c, id)).created_by).toBe(A.id)
  })
})
