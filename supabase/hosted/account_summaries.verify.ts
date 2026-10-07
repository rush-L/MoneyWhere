// Hosted verification for Phase 8 (account_summaries RPC). NOT part of `npm test` (touches the real dev project).
// Run: npx vitest run --config supabase/hosted/vitest.hosted.config.ts
// Normal users = anon-key clients that sign up/in. The Management API (`supabase db query --linked`) is used
// only for setup the app has no path for (adding a member), schema inspection, and cleanup.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
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

const tag = `mwas${Date.now()}`
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

let A: U, B: U, C: U, N: { c: SupabaseClient }
let WA: string, WB: string
const created: string[] = []

beforeAll(async () => {
  A = await user('a')
  B = await user('b')
  C = await user('c')
  N = { c: anon() }
  WA = await wallet(A, `${tag}-WalletA`)
  WB = await wallet(C, `${tag}-WalletB`)
  created.push(WA, WB)
  // Membership has no client path yet (invitations are a later phase): setup via admin SQL.
  sql(`insert into public.wallet_members (wallet_id, user_id, role) values ('${WA}','${B.id}','member')`)
  await catOf(C, WB)
}, 120_000)

afterAll(() => {
  // Wallet delete cascades to members/accounts/categories/transactions; users go last (transactions.created_by has no cascade).
  const ids = created.map((i) => `'${i}'`).join(',')
  const uids = [A, B, C].filter(Boolean).map((u) => `'${u.id}'`).join(',')
  if (ids) sql(`delete from public.wallets where id in (${ids})`)
  if (uids) sql(`delete from auth.users where id in (${uids})`)
  const left = sql<{ w: number; u: number }>(
    `select (select count(*) from public.wallets where name like '${tag}%')::int w, (select count(*) from auth.users where email like '%${tag}%')::int u`,
  )[0]
  console.log('CLEANUP leftover', left, 'tag', tag)
}, 120_000)


const summ = (u: { c: SupabaseClient }, w: string) => u.c.rpc('account_summaries', { p_wallet_id: w })

describe('account_summaries on the hosted project', () => {
  let a1: string, a2: string, b1: string
  beforeAll(async () => {
    a1 = await mkAcct(A, WA, 'Acc A', 2_000_000, 'bank')
    a2 = await mkAcct(A, WA, 'Acc B', 500_000, 'e_wallet')
    b1 = await mkAcct(C, WB, 'Other wallet', 100, 'cash')
    const cat = await catOf(A, WA)
    expect((await tx(A, a1, null, { type: 'income', amount_minor: 500_000 })).error).toBeNull()
    expect((await tx(A, a1, cat, { amount_minor: 200_000 })).error).toBeNull()
    expect((await tx(A, a1, null, { type: 'transfer', destination_account_id: a2, amount_minor: 300_000 })).error).toBeNull()
  })

  it('owner: spec dataset gives A 20,000 / B 8,000 and equals domain accountBalance()', async () => {
    const { data, error } = await summ(A, WA)
    expect(error).toBeNull()
    const got = Object.fromEntries((data as { account_name: string; current_balance_minor: number }[]).map((r) => [r.account_name, r.current_balance_minor]))
    expect(got).toEqual({ 'Acc A': 2_000_000, 'Acc B': 800_000 })
    const { data: txs } = await A.c.from('transactions').select('id, type, amount_minor, account_id, destination_account_id, category_id, date').eq('wallet_id', WA)
    const dom = (id: string, o: number) => accountBalance(id, o, (txs as never[]).map((t: { amount_minor: unknown }) => ({ ...(t as object), amount_minor: Number(t.amount_minor) })) as never)
    expect([dom(a1, 2_000_000), dom(a2, 500_000)]).toEqual([2_000_000, 800_000])
    expect(typeof (data as { current_balance_minor: unknown }[])[0]!.current_balance_minor).toBe('number')
  })
  it('wallet scoping: only the requested wallet accounts', async () => {
    const ids = ((await summ(A, WA)).data as { account_id: string }[]).map((r) => r.account_id).sort()
    expect(ids).toEqual([a1, a2].sort())
    expect(((await summ(C, WB)).data as { account_id: string }[]).map((r) => r.account_id)).toEqual([b1])
  })
  it('member can read; outsider and anonymous cannot', async () => {
    expect(((await summ(B, WA)).data as unknown[]).length).toBe(2)
    const out = await summ(C, WA)
    console.log('OUTSIDER', JSON.stringify(out))
    expect(out.data).toEqual([])
    expect(((await summ(A, WB)).data as unknown[]).length).toBe(0)
    const anonRes = await summ(N, WA)
    console.log('ANON', JSON.stringify(anonRes.error))
    expect(anonRes.error).not.toBeNull()
    expect(anonRes.data).toBeNull()
  })
})
