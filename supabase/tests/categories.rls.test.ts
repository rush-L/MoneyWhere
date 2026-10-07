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

const DEFAULTS: Record<string, string[]> = {
  Food: ['Groceries', 'Restaurants', 'Coffee'],
  Transportation: ['Fuel', 'Public Transportation', 'Ride Sharing'],
  Bills: ['Electricity', 'Water', 'Internet', 'Phone'],
  Lifestyle: ['Entertainment', 'Shopping', 'Hobbies'],
}
const names = (uid: string | null, wallet: string) =>
  as(uid, () => db.query<{ name: string }>(`select name from public.categories where wallet_id = $1`, [wallet])).then((r) => r.rows.map((x) => x.name))
const addCat = (uid: string | null, wallet: string, name: string, parent: string | null = null) =>
  as(uid, () =>
    db.query<{ id: string }>(`insert into public.categories (wallet_id, parent_id, name) values ($1, $2, $3) returning id`, [wallet, parent, name]),
  ).then((r) => r.rows[0]!.id)
const idOf = (wallet: string, name: string) =>
  db.query<{ id: string }>(`select id from public.categories where wallet_id = $1 and name = $2`, [wallet, name]).then((r) => r.rows[0]!.id)

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

describe('default categories', () => {
  it('a new wallet gets exactly the starter set, under the right parents', async () => {
    const rows = (
      await db.query<{ name: string; parent: string | null }>(
        `select c.name, p.name as parent from public.categories c left join public.categories p on p.id = c.parent_id where c.wallet_id = $1`,
        [WA],
      )
    ).rows
    expect(rows.filter((r) => !r.parent).map((r) => r.name).sort()).toEqual(Object.keys(DEFAULTS).sort())
    for (const [parent, kids] of Object.entries(DEFAULTS)) {
      expect(rows.filter((r) => r.parent === parent).map((r) => r.name).sort()).toEqual([...kids].sort())
    }
    expect(rows.length).toBe(17)
  })
  it('each wallet gets its own copy', async () => {
    expect((await names(C, WC)).length).toBe(17)
  })
  it('clients cannot call the seed function', async () => {
    await expect(as(A, () => db.query(`select public.seed_default_categories($1)`, [WA]))).rejects.toThrow(/permission denied/)
  })
})

describe('categories RLS', () => {
  it('owner reads and creates in own wallet', async () => {
    await addCat(A, WA, 'Pets')
    expect(await names(A, WA)).toContain('Pets')
  })
  it('members read but cannot create, rename or delete', async () => {
    expect(await names(B, WA)).toContain('Food')
    await expect(addCat(B, WA, 'Nope')).rejects.toThrow(/row-level security/)
    const u = await as(B, async () => db.query(`update public.categories set name = 'hacked' where id = $1`, [await idOf(WA, 'Food')]))
    expect(u.affectedRows).toBe(0)
    const d = await as(B, async () => db.query(`delete from public.categories where id = $1`, [await idOf(WA, 'Coffee')]))
    expect(d.affectedRows).toBe(0)
    expect(await names(A, WA)).toContain('Coffee')
  })
  it('outsiders cannot read, create, rename or delete in another wallet', async () => {
    expect(await names(C, WA)).toEqual([]) // C is not a member of WA
    await expect(addCat(C, WA, 'Nope')).rejects.toThrow(/row-level security/)
    await expect(addCat(A, WC, 'Nope')).rejects.toThrow(/row-level security/)
    expect((await as(C, () => db.query(`update public.categories set name = 'x' where wallet_id = $1`, [WA]))).affectedRows).toBe(0)
    expect((await as(C, () => db.query(`delete from public.categories where wallet_id = $1`, [WA]))).affectedRows).toBe(0)
    expect(await names(A, WC)).toEqual([])
    expect((await names(A, WA)).length).toBeGreaterThanOrEqual(17)
  })
  it('anon can neither read nor create', async () => {
    await expect(as(null, () => db.query(`select * from public.categories`))).rejects.toThrow(/permission denied/)
    await expect(addCat(null, WA, 'Nope')).rejects.toThrow(/permission denied/)
  })
  it('owner renames and deletes; updated_at moves', async () => {
    const id = await addCat(A, WA, 'Temp')
    const stamp = async () => new Date((await db.query<{ updated_at: string }>(`select updated_at from public.categories where id = $1`, [id])).rows[0]!.updated_at).getTime()
    const before = await stamp()
    await new Promise((r) => setTimeout(r, 5))
    expect((await as(A, () => db.query(`update public.categories set name = 'Temp2' where id = $1`, [id]))).affectedRows).toBe(1)
    expect(await stamp()).toBeGreaterThan(before)
    expect((await as(A, () => db.query(`delete from public.categories where id = $1`, [id]))).affectedRows).toBe(1)
  })
  it('wallet_id and parent_id are not updatable', async () => {
    const id = await idOf(WA, 'Coffee')
    await expect(as(A, () => db.query(`update public.categories set wallet_id = $1 where id = $2`, [WC, id]))).rejects.toThrow(/permission denied/)
    await expect(as(A, () => db.query(`update public.categories set parent_id = null where id = $1`, [id]))).rejects.toThrow(/permission denied/)
  })
})

describe('categories constraints', () => {
  it('rejects empty, whitespace-only and over-long names; accepts 50', async () => {
    for (const n of ['', '   ', 'x'.repeat(51)]) await expect(addCat(A, WA, n)).rejects.toThrow(/check constraint/)
    await addCat(A, WA, 'y'.repeat(50))
  })
  it('rejects duplicates within a wallet, case/whitespace-insensitively, at any level', async () => {
    await expect(addCat(A, WA, 'food')).rejects.toThrow(/duplicate key/)
    await expect(addCat(A, WA, '  Groceries ')).rejects.toThrow(/duplicate key/)
    await expect(addCat(A, WA, 'Coffee', await idOf(WA, 'Bills'))).rejects.toThrow(/duplicate key/)
  })
  it('renaming onto an existing name is rejected', async () => {
    await expect(as(A, async () => db.query(`update public.categories set name = 'Food' where id = $1`, [await idOf(WA, 'Bills')]))).rejects.toThrow(/duplicate key/)
  })
  it('the same name is fine in a different wallet', async () => {
    await addCat(C, WC, 'Pets')
    await addCat(A, WA, 'Pets2')
    await addCat(C, WC, 'Pets2')
  })
  it('subcategories need a parent in the same wallet and cannot nest', async () => {
    await expect(addCat(A, WA, 'Cross', await idOf(WC, 'Food'))).rejects.toThrow(/foreign key/)
    await expect(addCat(A, WA, 'Deep', await idOf(WA, 'Coffee'))).rejects.toThrow(/subcategories cannot have subcategories/)
  })
  it('deleting a parent deletes its subcategories; deleting the wallet deletes everything', async () => {
    const wid = await createWallet(A, 'Temp wallet')
    await as(A, () => db.query(`delete from public.categories where wallet_id = $1 and name = 'Food'`, [wid]))
    const left = await names(A, wid)
    expect(left).not.toContain('Coffee')
    expect(left).toContain('Bills')
    await as(A, () => db.query(`delete from public.wallets where id = $1`, [wid]))
    expect((await db.query(`select 1 from public.categories where wallet_id = $1`, [wid])).rows.length).toBe(0)
  })
})
