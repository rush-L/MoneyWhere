// Hosted verification for Phase 6 (budgets). NOT part of `npm test` (touches the real dev project).
// Run: npx vitest run --config supabase/hosted/vitest.hosted.config.ts supabase/hosted/budgets
// Normal users = anon-key clients that sign up/in. The Management API (`supabase db query --linked`) is used
// only for setup the app has no path for (adding a member), schema inspection, and cleanup.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { calculateBudgetStatus, spendingByBudgetCategory } from '../../src/domain/finance'
import { createBudgetService } from '../../src/features/budgets/budgetService'
import { createCategoryService } from '../../src/features/categories/categoryService'

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

const tag = `mwbud${Date.now()}`
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

let A: U, B: U, C: U, N: { c: SupabaseClient }
let WA: string, WC: string
const created: string[] = []
const OCT = '2026-10-01'
const catId = async (u: U, w: string, name: string) =>
  (await u.c.from('categories').select('id').eq('wallet_id', w).eq('name', name).single()).data!.id as string
const bud = (u: { c: SupabaseClient }, w: string, category_id: string, o: Record<string, unknown> = {}) =>
  u.c.from('budgets').insert({ id: crypto.randomUUID(), wallet_id: w, category_id, month: OCT, amount_minor: 800_000, ...o }).select()

beforeAll(async () => {
  A = await user('a')
  B = await user('b')
  C = await user('c')
  N = { c: anon() }
  WA = await wallet(A, `${tag}-WalletA`)
  WC = await wallet(C, `${tag}-WalletC`)
  created.push(WA, WC)
  // Membership has no client path yet (invitations are a later phase): setup via admin SQL.
  sql(`insert into public.wallet_members (wallet_id, user_id, role) values ('${WA}','${B.id}','member')`)
}, 120_000)

afterAll(() => {
  const ids = created.map((i) => `'${i}'`).join(',')
  const uids = [A, B, C].filter(Boolean).map((u) => `'${u.id}'`).join(',')
  if (ids) sql(`delete from public.wallets where id in (${ids})`)
  if (uids) sql(`delete from auth.users where id in (${uids})`)
  const left = sql<{ w: number; u: number }>(
    `select (select count(*) from public.wallets where name like '${tag}%')::int w, (select count(*) from auth.users where email like '%${tag}%')::int u`,
  )[0]
  console.log('CLEANUP leftover', left, 'tag', tag)
}, 120_000)

describe('budgets on the hosted project', () => {
  it('schema: RLS on, policies, constraints', () => {
    const rls = sql<{ r: boolean }>(`select relrowsecurity r from pg_class where oid='public.budgets'::regclass`)[0]!.r
    const pol = sql<{ polname: string }>(`select polname from pg_policy where polrelid='public.budgets'::regclass`).map((p) => p.polname).sort()
    const defs = sql<{ def: string }>(`select pg_get_constraintdef(oid) def from pg_constraint where conrelid='public.budgets'::regclass`).map((r) => r.def).join(' | ')
    console.log('BUDGET POLICIES', pol.join(','), '| CONSTRAINTS', defs)
    expect(rls).toBe(true)
    expect(pol).toEqual(['budgets_delete_owner', 'budgets_insert_owner', 'budgets_select_member', 'budgets_update_owner'])
    expect(defs).toMatch(/UNIQUE \(wallet_id, category_id, month\)/)
    expect(defs).toMatch(/FOREIGN KEY \(wallet_id, category_id\) REFERENCES categories\(wallet_id, id\)/)
  })

  it('permissions: owner CRUD, member read-only, outsider and anon denied', async () => {
    const food = await catId(A, WA, 'Food')
    const r = await bud(A, WA, food, { month: '2026-08-01' })
    expect(r.error).toBeNull()
    const id = r.data![0].id as string
    expect((await B.c.from('budgets').select('id').eq('id', id)).data).toHaveLength(1)
    expect((await bud(B, WA, await catId(A, WA, 'Bills'))).error).not.toBeNull()
    expect((await B.c.from('budgets').update({ amount_minor: 1 }).eq('id', id).select()).data).toHaveLength(0)
    expect((await B.c.from('budgets').delete().eq('id', id).select()).data).toHaveLength(0)
    expect((await C.c.from('budgets').select('id').eq('id', id)).data).toHaveLength(0)
    expect((await bud(C, WA, food, { month: '2026-07-01' })).error).not.toBeNull()
    expect((await C.c.from('budgets').update({ amount_minor: 1 }).eq('id', id).select()).data).toHaveLength(0)
    expect((await C.c.from('budgets').delete().eq('id', id).select()).data).toHaveLength(0)
    expect((await N.c.from('budgets').select('id')).error).not.toBeNull()
    expect((await bud(N, WA, food)).error).not.toBeNull()
    expect((await A.c.from('budgets').update({ amount_minor: 900_000 }).eq('id', id).select()).data).toHaveLength(1)
    expect((await A.c.from('budgets').update({ month: '2026-09-01' }).eq('id', id).select()).error).not.toBeNull()
    expect((await A.c.from('budgets').delete().eq('id', id).select()).data).toHaveLength(1)
  })

  it('constraints: subcategory, cross-wallet, duplicate, amount, month', async () => {
    const food = await catId(A, WA, 'Food')
    const bad = [
      await bud(A, WA, await catId(A, WA, 'Groceries')),
      await bud(A, WA, await catId(C, WC, 'Food')),
      await bud(A, WA, food, { amount_minor: 0 }),
      await bud(A, WA, food, { amount_minor: -1 }),
      await bud(A, WA, food, { amount_minor: 10.5 }),
      await bud(A, WA, food, { month: '2026-10-15' }),
      await bud(A, WA, food, { month: '2026-13-01' }),
    ]
    console.log('BAD', JSON.stringify(bad.map((b) => b.error?.message ?? 'NO ERROR')))
    for (const b of bad) expect(b.error).not.toBeNull()
    expect((await bud(A, WA, food)).error).toBeNull()
    const dup = await bud(A, WA, food)
    expect(dup.error?.code).toBe('23505')
  })

  it('category with a budget cannot be deleted; rollup, exclusions and month isolation', async () => {
    const food = await catId(A, WA, 'Food')
    const del = await A.c.from('categories').delete().eq('id', food).select()
    console.log('CATEGORY DELETE', del.error?.code, del.error?.message)
    expect(del.error?.code).toBe('23503')

    const acct = async (n: string, opening: number) => {
      const id = crypto.randomUUID()
      expect((await A.c.from('accounts').insert({ id, wallet_id: WA, name: n, type: 'cash', opening_balance_minor: opening })).error).toBeNull()
      return id
    }
    const [a1, a2] = [await acct('One', 1_000_000), await acct('Two', 0)]
    const t = async (o: Record<string, unknown>) => {
      const r = await A.c.from('transactions').insert({ id: crypto.randomUUID(), account_id: a1, date: '2026-10-10', ...o }).select()
      expect(r.error).toBeNull()
    }
    await t({ type: 'expense', category_id: await catId(A, WA, 'Groceries'), amount_minor: 300_000 })
    await t({ type: 'expense', category_id: await catId(A, WA, 'Coffee'), amount_minor: 50_000 })
    await t({ type: 'transfer', destination_account_id: a2, amount_minor: 200_000 })
    await t({ type: 'income', amount_minor: 999_999 })
    await t({ type: 'expense', category_id: food, amount_minor: 123_456, date: '2026-11-01' })
    await t({ type: 'expense', category_id: food, amount_minor: 654_321, date: '2026-09-30' })
    // another wallet's expense must not leak in
    const cA = crypto.randomUUID()
    expect((await C.c.from('accounts').insert({ id: cA, wallet_id: WC, name: 'C', type: 'cash', opening_balance_minor: 0 })).error).toBeNull()
    expect((await C.c.from('transactions').insert({ id: crypto.randomUUID(), account_id: cA, category_id: await catId(C, WC, 'Food'), type: 'expense', amount_minor: 777_777, date: '2026-10-10' })).error).toBeNull()

    const svc = createBudgetService(A.c)
    const cats = await createCategoryService(A.c).list(WA)
    const budgets = await svc.list(WA, OCT)
    const status = (rows: Awaited<ReturnType<typeof svc.spending>>) => {
      const b = budgets.find((x) => x.categoryId === food)!
      return calculateBudgetStatus(b.amountMinor, spendingByBudgetCategory(rows, cats, OCT).get(food) ?? 0)
    }
    const oct = await svc.spending(WA, OCT)
    console.log('OCT rows fetched', oct.length, 'status', JSON.stringify(status(oct)))
    expect(oct).toHaveLength(2) // the server already excluded income, transfer, other months, other wallets
    expect(status(oct)).toMatchObject({ budget: 800_000, spent: 350_000, remaining: 450_000, percentUsed: 43.75, over: false })
    // the member sees the same numbers
    expect(status(await createBudgetService(B.c).spending(WA, OCT))).toMatchObject({ spent: 350_000 })
    // November has only the 1 Nov expense
    expect(spendingByBudgetCategory(await svc.spending(WA, '2026-11-01'), cats, '2026-11-01').get(food)).toBe(123_456)
    // over budget
    await t({ type: 'expense', category_id: food, amount_minor: 600_000 })
    expect(status(await svc.spending(WA, OCT))).toMatchObject({ spent: 950_000, remaining: -150_000, over: true })
  })
})
