// Hosted verification for Phase 5C (transfers). NOT part of `npm test` (touches the real dev project).
// Run: npx vitest run --config supabase/hosted/vitest.hosted.config.ts
// Normal users = anon-key clients that sign up/in. The Management API (`supabase db query --linked`) is used
// only for setup the app has no path for (adding a member), schema inspection, and cleanup.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { rpcDel, rpcUpd } from './mutate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { accountBalance } from '../../src/domain/finance'
import { assertDevProject } from './guard.mjs'

assertDevProject() // refuses unless .env.local, the linked project and the approved dev list agree

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
)
const URL = env.VITE_SUPABASE_URL!
const KEY = env.VITE_SUPABASE_ANON_KEY!
const dir = mkdtempSync(join(tmpdir(), 'mwverify-'))

function sql<T = Record<string, unknown>>(q: string): T[] {
  const f = join(dir, 'q.sql')
  writeFileSync(f, q)
  const out = execFileSync('npx', ['supabase', 'db', 'query', '--linked', '-f', f], { encoding: 'utf8', shell: true })
  return JSON.parse(out.slice(out.indexOf('{'))).rows
}

const tag = `mwxf${Date.now()}`
const PW = `Tx!${Math.random().toString(36).slice(2)}Aa1`
const anon = () => createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } })
type U = { c: SupabaseClient; id: string }
async function user(n: string): Promise<U> {
  const c = anon()
  const { data, error } = await c.auth.signUp({ email: `reambillo.russel+${tag}${n}@gmail.com`, password: PW })
  if (error || !data.session) throw new Error(`signup ${n}: ${error?.message ?? 'no session (email confirm on?)'}`)
  return { c, id: data.user!.id }
}
const wallet = async (u: U, name: string) => {
  const { data, error } = await u.c.rpc('create_wallet', { p_name: name })
  if (error) throw error
  return (data as { id: string }).id
}
const mkAcct = async (u: U, w: string, name: string, opening = 0, type = 'cash') => {
  const id = crypto.randomUUID()
  const { error } = await u.c.from('accounts').insert({ id, wallet_id: w, name, type, opening_balance_minor: opening })
  if (error) throw error
  return id
}
const catOf = async (u: U, w: string) => {
  const { data } = await u.c.from('categories').select('id').eq('wallet_id', w).eq('name', 'Groceries').single()
  return data!.id as string
}
const D = '2026-10-10'
const tx = (u: { c: SupabaseClient }, account_id: string, category_id: string | null, o: Record<string, unknown> = {}) => {
  const id = crypto.randomUUID()
  return u.c.from('transactions').insert({ id, account_id, category_id, type: 'expense', amount_minor: 50000, date: D, ...o }).select().then((r) => ({ id, ...r }))
}
const upd = (u: U, id: string, patch: Record<string, unknown>) => rpcUpd(u.c, id, patch)
const del = (u: U, id: string) => rpcDel(u.c, id)
const count = (u: { c: SupabaseClient }, id?: string) =>
  (id ? u.c.from('transactions').select('id').eq('id', id) : u.c.from('transactions').select('id')).then((r) => r.data?.length ?? 0)

let A: U, B: U, D2: U, C: U, N: { c: SupabaseClient }
let WA: string, WB: string, catA: string
const created: string[] = []

beforeAll(async () => {
  A = await user('a')
  B = await user('b')
  D2 = await user('d')
  C = await user('c')
  N = { c: anon() }
  WA = await wallet(A, `${tag}-WalletA`)
  WB = await wallet(C, `${tag}-WalletB`)
  created.push(WA, WB)
  // Membership has no client path yet (invitations are a later phase): setup via admin SQL.
  sql(`insert into public.wallet_members (wallet_id, user_id, role) values ('${WA}','${B.id}','member'),('${WA}','${D2.id}','member')`)
  await mkAcct(A, WA, 'Cash A')
  await mkAcct(C, WB, 'Cash B')
  catA = await catOf(A, WA)
  await catOf(C, WB)
}, 120_000)

afterAll(() => {
  // Wallet delete cascades to members/accounts/categories/transactions; users go last (transactions.created_by has no cascade).
  const ids = created.map((i) => `'${i}'`).join(',')
  const uids = [A, B, D2, C].filter(Boolean).map((u) => `'${u.id}'`).join(',')
  if (ids) sql(`delete from public.wallets where id in (${ids})`)
  if (uids) sql(`delete from auth.users where id in (${uids})`)
  const left = sql<{ w: number; u: number }>(
    `select (select count(*) from public.wallets where name like '${tag}%')::int w, (select count(*) from auth.users where email like '%${tag}%')::int u`,
  )[0]
  console.log('CLEANUP leftover', left, 'tag', tag)
}, 120_000)

const xfer = (u: { c: SupabaseClient }, from: string, to: string | null, o: Record<string, unknown> = {}) =>
  tx(u, from, null, { type: 'transfer', destination_account_id: to, ...o })
const bal = async (u: U, w: string, accId: string) => {
  const { data: accs } = await u.c.from('accounts').select('id, opening_balance_minor').eq('wallet_id', w)
  const { data: txs } = await u.c.from('transactions').select('id, type, amount_minor, account_id, destination_account_id, category_id, date').eq('wallet_id', w)
  const a = accs!.find((x) => x.id === accId)!
  return accountBalance(accId, Number(a.opening_balance_minor), txs as never)
}
const msg = (r: { error: { message: string } | null }) => r.error?.message ?? 'NO ERROR'

describe('transfers on the hosted project', () => {
  let bpi: string, gcash: string, bpiB: string
  beforeAll(async () => {
    bpi = await mkAcct(A, WA, 'BPI', 2_000_000, 'bank')
    gcash = await mkAcct(A, WA, 'GCash', 500_000, 'e_wallet')
    bpiB = await mkAcct(C, WB, 'BPI-B', 100, 'bank')
  })

  it('basic: BPI -> GCash 3,000 moves balances; deleting reverses it; totals unaffected', async () => {
    const r = await xfer(A, bpi, gcash, { amount_minor: 300_000 })
    expect(r.error).toBeNull()
    const row = r.data![0]
    expect(row.paid_by_user_id).toBeNull()
    expect(row.created_by).toBe(A.id)
    expect(row.wallet_id).toBe(WA)
    expect(row.category_id).toBeNull()
    expect([await bal(A, WA, bpi), await bal(A, WA, gcash)]).toEqual([1_700_000, 800_000])
    expect((await del(A, r.id)).data).toHaveLength(1)
    expect([await bal(A, WA, bpi), await bal(A, WA, gcash)]).toEqual([2_000_000, 500_000])
  })
  it('integrity: same account, category, zero, negative, missing destination all rejected', async () => {
    const bad = [
      await xfer(A, bpi, bpi, { amount_minor: 100 }),
      await xfer(A, bpi, gcash, { amount_minor: 100, category_id: catA }),
      await xfer(A, bpi, gcash, { amount_minor: 0 }),
      await xfer(A, bpi, gcash, { amount_minor: -100 }),
      await xfer(A, bpi, null, { amount_minor: 100 }),
    ]
    console.log('REJECTIONS', JSON.stringify(bad.map(msg)))
    for (const r of bad) expect(r.error).not.toBeNull()
    expect(await count(A)).toBe(0)
  })
  it('cross-wallet source / destination rejected', async () => {
    const r1 = await xfer(A, bpi, bpiB, { amount_minor: 100 })
    const r2 = await xfer(A, bpiB, gcash, { amount_minor: 100 })
    const r3 = await xfer(C, bpiB, bpi, { amount_minor: 100 })
    console.log('CROSS', JSON.stringify([msg(r1), msg(r2), msg(r3)]))
    for (const r of [r1, r2, r3]) expect(r.error).not.toBeNull()
    expect(await count(A)).toBe(0)
    expect(await count(C)).toBe(0)
  })
  it('spoofing wallet_id / created_by / paid_by_user_id is rejected', async () => {
    for (const [k, v] of [['wallet_id', WA], ['created_by', A.id], ['paid_by_user_id', A.id]] as const) {
      const r = await xfer(B, bpi, gcash, { amount_minor: 100, [k]: v })
      expect(r.error, k).not.toBeNull()
    }
  })
  it('permissions: member creates/edits/deletes own; cannot touch owner or other member; owner manages all; outsider/anon nothing', async () => {
    const own = await xfer(B, bpi, gcash, { amount_minor: 1000 })
    expect(own.error).toBeNull()
    expect(own.data![0].created_by).toBe(B.id)
    const ownerTx = await xfer(A, gcash, bpi, { amount_minor: 2000 })
    const dTx = await xfer(D2, gcash, bpi, { amount_minor: 3000 })
    expect(await count(B)).toBe(3) // members read all wallet transfers
    expect((await upd(B, own.id, { amount_minor: 1500 })).data).toHaveLength(1)
    expect((await upd(B, ownerTx.id, { amount_minor: 1 })).data).toHaveLength(0)
    expect((await upd(B, dTx.id, { amount_minor: 1 })).data).toHaveLength(0)
    expect((await del(B, ownerTx.id)).data).toHaveLength(0)
    expect((await del(B, dTx.id)).data).toHaveLength(0)
    expect(await count(C)).toBe(0)
    expect(await count(N)).toBe(0)
    expect((await xfer(N, bpi, gcash, { amount_minor: 100 })).error).not.toBeNull()
    expect((await upd(A, dTx.id, { amount_minor: 4000, note: 'owner edit' })).data).toHaveLength(1)
    expect((await upd(A, own.id, { destination_account_id: bpi, account_id: gcash })).data).toHaveLength(1)
    expect((await del(B, own.id)).data).toHaveLength(1)
    expect((await del(A, dTx.id)).data).toHaveLength(1)
    expect((await del(A, ownerTx.id)).data).toHaveLength(1)
    expect(await count(A)).toBe(0)
  })
  it('account locking: BOTH source and destination lock; unlock after delete', async () => {
    const t = await xfer(A, bpi, gcash, { amount_minor: 100_000 })
    for (const a of [bpi, gcash]) {
      const [typeEdit, openEdit, nameEdit, delAcc] = await Promise.all([
        A.c.from('accounts').update({ type: 'cash' }).eq('id', a).select(),
        A.c.from('accounts').update({ opening_balance_minor: 1 }).eq('id', a).select(),
        A.c.from('accounts').update({ name: `renamed-${a.slice(0, 4)}`, holder: 'H' }).eq('id', a).select(),
        A.c.from('accounts').delete().eq('id', a).select(),
      ])
      console.log('LOCK', a.slice(0, 4), JSON.stringify([msg(typeEdit), msg(openEdit)]))
      expect(typeEdit.error?.message).toMatch(/has transactions/)
      expect(openEdit.error?.message).toMatch(/has transactions/)
      expect(nameEdit.data).toHaveLength(1)
      expect(delAcc.data ?? []).toHaveLength(0)
    }
    expect((await del(A, t.id)).data).toHaveLength(1)
    const ok = await A.c.from('accounts').update({ type: 'bank' }).eq('id', gcash).select()
    expect(ok.error).toBeNull()
  })
  it('schema + cascade: shape CHECKs, destination FK, wallet delete removes transfers', async () => {
    const defs = sql<{ def: string }>(`select pg_get_constraintdef(oid) def from pg_constraint where conrelid='public.transactions'::regclass`).map((r) => r.def).join('\n')
    console.log('XFER CONSTRAINTS', defs.split('\n').filter((l) => /destination|transfer/.test(l)).join(' | '))
    expect(defs).toMatch(/FOREIGN KEY \(wallet_id, destination_account_id\) REFERENCES accounts\(wallet_id, id\)/)
    expect(defs).toMatch(/account_id <> destination_account_id/)
    const p = sql<{ is_nullable: string }>(`select is_nullable from information_schema.columns where table_name='transactions' and column_name='paid_by_user_id'`)
    expect(p[0]!.is_nullable).toBe('YES')
    const W = await wallet(A, `${tag}-Temp`)
    created.push(W)
    const [a1, a2] = [await mkAcct(A, W, 'x'), await mkAcct(A, W, 'y')]
    expect((await xfer(A, a1, a2, { amount_minor: 5 })).error).toBeNull()
    sql(`delete from public.wallets where id = '${W}'`)
    const left = sql<{ n: number }>(`select count(*)::int n from public.transactions where wallet_id = '${W}'`)[0]!.n
    expect(left).toBe(0)
  })
})
