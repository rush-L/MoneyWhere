// Real migrations + RLS in in-process Postgres (PGlite) with a stubbed `auth` schema.
import { PGlite } from '@electric-sql/pglite'
import { readdirSync, readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'

const A = '11111111-1111-4111-8111-111111111111' // owner of WA
const B = '22222222-2222-4222-8222-222222222222' // member of WA
const C = '33333333-3333-4333-8333-333333333333' // outsider, owns WC
const dir = new URL('../migrations/', import.meta.url)
let db: PGlite
let WA: string
let WC: string

async function as<T>(uid: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${uid ? 'authenticated' : 'anon'}`)
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid ?? ''])
  try {
    return await fn()
  } finally {
    await db.exec('reset role')
  }
}
const createWallet = (uid: string, name: string) =>
  as(uid, () => db.query<{ id: string }>('select * from public.create_wallet($1)', [name])).then((r) => r.rows[0]!.id)
const idOf = (wallet: string, name: string) =>
  db.query<{ id: string }>(`select id from public.categories where wallet_id = $1 and name = $2`, [wallet, name]).then((r) => r.rows[0]!.id)
const addBudget = (uid: string | null, wallet: string, category: string, amount: number | string = 800000, month = '2026-10-01') =>
  as(uid, () =>
    db.query<{ id: string }>(
      `insert into public.budgets (wallet_id, category_id, month, amount_minor) values ($1, $2, $3, $4) returning id`,
      [wallet, category, month, amount],
    ),
  ).then((r) => r.rows[0]!.id)
const count = (uid: string | null, wallet: string) =>
  as(uid, () => db.query<{ n: number }>(`select count(*)::int n from public.budgets where wallet_id = $1`, [wallet])).then((r) => r.rows[0]!.n)

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema realtime; create table realtime.messages (topic text, extension text); alter table realtime.messages enable row level security;
    create table realtime.sent (topic text, event text, payload jsonb, private boolean);
    create function realtime.topic() returns text language sql stable as $$ select nullif(current_setting('realtime.topic', true), '') $$;
    create function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void language sql as $$ insert into realtime.sent values (topic, event, payload, private) $$;
    grant usage on schema realtime to authenticated; grant select on realtime.messages to authenticated;
    create schema auth;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant execute on functions to anon, authenticated, public;
  `)
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(new URL(f, dir), 'utf8'))
  }
  for (const u of [A, B, C]) await db.query(`insert into auth.users (id) values ($1)`, [u])
  WA = await createWallet(A, 'Household')
  WC = await createWallet(C, 'Private')
  await db.query(`insert into public.wallet_members (wallet_id, user_id, role) values ($1, $2, 'member')`, [WA, B])
})

describe('budgets RLS', () => {
  it('owner creates, reads, updates the amount and deletes', async () => {
    const food = await idOf(WA, 'Food')
    const id = await addBudget(A, WA, food, 800000, '2026-08-01')
    expect(await count(A, WA)).toBeGreaterThanOrEqual(1)
    expect((await as(A, () => db.query(`update public.budgets set amount_minor = 900000 where id = $1`, [id]))).affectedRows).toBe(1)
    expect((await as(A, () => db.query(`delete from public.budgets where id = $1`, [id]))).affectedRows).toBe(1)
  })
  it('member reads but cannot create, update or delete', async () => {
    const id = await addBudget(A, WA, await idOf(WA, 'Bills'), 100)
    expect(await count(B, WA)).toBeGreaterThanOrEqual(1)
    await expect(addBudget(B, WA, await idOf(WA, 'Lifestyle'))).rejects.toThrow(/row-level security/)
    expect((await as(B, () => db.query(`update public.budgets set amount_minor = 1 where id = $1`, [id]))).affectedRows).toBe(0)
    expect((await as(B, () => db.query(`delete from public.budgets where id = $1`, [id]))).affectedRows).toBe(0)
    expect((await db.query<{ amount_minor: number }>(`select amount_minor from public.budgets where id = $1`, [id])).rows[0]!.amount_minor).toBe(100)
  })
  it('outsider cannot read, create, update or delete', async () => {
    expect(await count(C, WA)).toBe(0)
    await expect(addBudget(C, WA, await idOf(WA, 'Lifestyle'))).rejects.toThrow(/row-level security/)
    expect((await as(C, () => db.query(`update public.budgets set amount_minor = 1 where wallet_id = $1`, [WA]))).affectedRows).toBe(0)
    expect((await as(C, () => db.query(`delete from public.budgets where wallet_id = $1`, [WA]))).affectedRows).toBe(0)
    // and an owner of another wallet cannot insert into WA
    await expect(addBudget(C, WA, await idOf(WA, 'Food'), 5, '2026-07-01')).rejects.toThrow(/row-level security/)
  })
  it('anon cannot access', async () => {
    await expect(as(null, () => db.query(`select * from public.budgets`))).rejects.toThrow(/permission denied/)
    await expect(addBudget(null, WA, await idOf(WA, 'Food'))).rejects.toThrow(/permission denied/)
  })
  it('wallet, category and month are not updatable', async () => {
    const id = await addBudget(A, WA, await idOf(WA, 'Food'), 1, '2026-06-01')
    for (const col of ['wallet_id', 'category_id', 'month']) {
      await expect(as(A, () => db.query(`update public.budgets set ${col} = ${col} where id = $1`, [id]))).rejects.toThrow(/permission denied/)
    }
  })
})

describe('budgets constraints', () => {
  it('rejects a subcategory', async () => {
    await expect(addBudget(A, WA, await idOf(WA, 'Groceries'))).rejects.toThrow(/top-level/)
  })
  it('rejects a category from another wallet', async () => {
    await expect(addBudget(A, WA, await idOf(WC, 'Food'))).rejects.toThrow(/foreign key/)
  })
  it('rejects a duplicate wallet/category/month, allows another month or category', async () => {
    const food = await idOf(WA, 'Food')
    await addBudget(A, WA, food, 100, '2026-03-01')
    await expect(addBudget(A, WA, food, 200, '2026-03-01')).rejects.toThrow(/duplicate key/)
    await addBudget(A, WA, food, 200, '2026-04-01')
    await addBudget(A, WA, await idOf(WA, 'Transportation'), 200, '2026-03-01')
  })
  it('rejects zero, negative, fractional and unsafe amounts', async () => {
    const t = await idOf(WA, 'Transportation')
    for (const [i, amt] of [0, -5, '9007199254740992'].entries()) await expect(addBudget(A, WA, t, amt, `2025-0${i + 1}-01`)).rejects.toThrow(/check constraint/)
    await expect(addBudget(A, WA, t, '10.5', '2025-05-01')).rejects.toThrow()
    await addBudget(A, WA, t, '9007199254740991', '2025-06-01')
  })
  it('rejects a month that is not the first day', async () => {
    await expect(addBudget(A, WA, await idOf(WA, 'Bills'), 1, '2026-10-15')).rejects.toThrow(/check constraint/)
  })
  it('rejects an invalid month value', async () => {
    await expect(addBudget(A, WA, await idOf(WA, 'Bills'), 1, '2026-13-01')).rejects.toThrow()
  })
})

describe('budgets and category deletion', () => {
  it('a category with a budget cannot be deleted, directly or via its parent; without one it can', async () => {
    const bills = await idOf(WA, 'Bills')
    await addBudget(A, WA, bills, 1, '2026-01-01')
    await expect(as(A, () => db.query(`delete from public.categories where id = $1`, [bills]))).rejects.toThrow(/foreign key/)
    // deleting the budget unblocks it
    await db.query(`delete from public.budgets where category_id = $1`, [bills])
    expect((await as(A, () => db.query(`delete from public.categories where id = $1`, [bills]))).affectedRows).toBe(1)
  })
  it('deleting a wallet still cascades through its budgets', async () => {
    const W = await createWallet(A, 'Temp')
    await addBudget(A, W, await idOf(W, 'Food'))
    await db.query(`delete from public.wallets where id = $1`, [W])
    expect((await db.query<{ n: number }>(`select count(*)::int n from public.budgets where wallet_id = $1`, [W])).rows[0]!.n).toBe(0)
  })
})
