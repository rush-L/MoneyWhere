// Phase 11B: transaction version + apply_transaction_mutation, against real migrations + RLS in PGlite.
import { PGlite } from '@electric-sql/pglite'
import { readdirSync, readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'

const A = '11111111-1111-4111-8111-111111111111' // owner of WA
const B = '22222222-2222-4222-8222-222222222222' // member of WA
const C = '33333333-3333-4333-8333-333333333333' // outsider
const dir = new URL('../migrations/', import.meta.url)
let db: PGlite
let WA: string
let accA: string
let food: string

async function as<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  await db.exec('set role authenticated')
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid])
  try {
    return await fn()
  } finally {
    await db.exec('reset role')
  }
}
const add = (uid: string, o: Record<string, unknown> = {}) =>
  as(uid, () =>
    db.query<{ id: string; version: string }>(
      `insert into public.transactions (id, account_id, category_id, type, amount_minor, date, note)
       values (gen_random_uuid(), $1, $2, 'expense', $3, '2026-10-10', $4) returning id, version`,
      [accA, food, o.amount ?? 50000, o.note ?? null],
    ),
  ).then((r) => r.rows[0]!)
const payload = (o: Record<string, unknown> = {}) => ({
  type: 'expense', account_id: accA, destination_account_id: null, category_id: food, amount_minor: 60000, date: '2026-10-10', note: null, ...o,
})
type R = { status: string; version?: number; reason?: string }
const mutate = (uid: string, op: string, id: string, expected: number | null, p: unknown = payload(), o: { mid?: string; own?: boolean } = {}) =>
  as(uid, () =>
    db.query<{ r: R }>(`select public.apply_transaction_mutation($1, $2, $3, $4, $5::jsonb, $6) as r`, [
      o.mid ?? crypto.randomUUID(), op, id, expected, op === 'UPDATE' ? JSON.stringify(p) : null, o.own ?? false,
    ]),
  ).then((r) => r.rows[0]!.r)
const row = (id: string) => db.query<{ amount_minor: string; version: string }>(`select amount_minor, version from public.transactions where id = $1`, [id]).then((r) => r.rows[0])

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema realtime; create table realtime.messages (topic text, extension text); alter table realtime.messages enable row level security;
    create function realtime.topic() returns text language sql stable as $$ select nullif(current_setting('realtime.topic', true), '') $$;
    create function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void language sql as $$ select 1 $$;
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
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) await db.exec(readFileSync(new URL(f, dir), 'utf8'))
  for (const u of [A, B, C]) await db.query(`insert into auth.users (id) values ($1)`, [u])
  WA = await as(A, () => db.query<{ id: string }>('select * from public.create_wallet($1)', ['Household'])).then((r) => r.rows[0]!.id)
  await db.query(`insert into public.wallet_members (wallet_id, user_id, role) values ($1, $2, 'member')`, [WA, B])
  accA = await as(A, () => db.query<{ id: string }>(`insert into public.accounts (id, wallet_id, name, type) values (gen_random_uuid(), $1, 'Cash', 'cash') returning id`, [WA])).then((r) => r.rows[0]!.id)
  food = await db.query<{ id: string }>(`select id from public.categories where wallet_id = $1 and name = 'Groceries'`, [WA]).then((r) => r.rows[0]!.id)
})

describe('transactions.version', () => {
  // The trigger is exercised as the superuser: clients cannot UPDATE directly any more (see transactions.rls.test.ts).
  it('starts at 1, bumps once per real change, never on a no-op', async () => {
    const t = await add(A)
    expect(Number(t.version)).toBe(1)
    await db.query(`update public.transactions set amount_minor = 70000 where id = $1`, [t.id])
    expect(Number((await row(t.id))!.version)).toBe(2)
    await db.query(`update public.transactions set amount_minor = 70000, note = null where id = $1`, [t.id])
    expect(Number((await row(t.id))!.version)).toBe(2)
    await db.query(`update public.transactions set note = 'x', amount_minor = 1 where id = $1`, [t.id]) // two columns, still one bump
    expect(Number((await row(t.id))!.version)).toBe(3)
  })
  it('clients cannot write version', async () => {
    const t = await add(A)
    await expect(as(A, () => db.query(`update public.transactions set version = 99 where id = $1`, [t.id]))).rejects.toThrow(/permission denied/)
    await expect(
      as(A, () => db.query(`insert into public.transactions (id, account_id, category_id, type, amount_minor, date, version) values (gen_random_uuid(), $1, $2, 'expense', 1, '2026-10-10', 9)`, [accA, food])),
    ).rejects.toThrow(/permission denied/)
  })
})

describe('apply_transaction_mutation', () => {
  it('UPDATE with the expected version applies and bumps once', async () => {
    const t = await add(B)
    expect(await mutate(B, 'UPDATE', t.id, 1)).toEqual({ status: 'APPLIED', version: 2 })
    expect(await row(t.id)).toMatchObject({ amount_minor: 60000, version: 2 })
  })
  it('stale UPDATE is a CONFLICT and the server row is untouched', async () => {
    const t = await add(B)
    expect((await mutate(A, 'UPDATE', t.id, 1, payload({ amount_minor: 70000 }))).status).toBe('APPLIED') // owner edits first
    expect(await mutate(B, 'UPDATE', t.id, 1, payload({ amount_minor: 60000 }), { own: true })).toEqual({ status: 'CONFLICT', reason: 'version_mismatch', version: 2 })
    expect(await row(t.id)).toMatchObject({ amount_minor: 70000, version: 2 })
  })
  it('stale DELETE is a CONFLICT and the row survives', async () => {
    const t = await add(B)
    await mutate(A, 'UPDATE', t.id, 1)
    expect((await mutate(B, 'DELETE', t.id, 1, null, { own: true })).status).toBe('CONFLICT')
    expect(await row(t.id)).toBeTruthy()
  })
  it('DELETE with the expected version removes the row', async () => {
    const t = await add(B)
    expect((await mutate(B, 'DELETE', t.id, 1, null, { own: true })).status).toBe('APPLIED')
    expect(await row(t.id)).toBeUndefined()
  })
  it('DELETE of a missing row is ALREADY_GONE; UPDATE of a missing row is a CONFLICT and does not recreate it', async () => {
    const id = crypto.randomUUID()
    expect((await mutate(A, 'DELETE', id, 1)).status).toBe('ALREADY_GONE')
    expect(await mutate(A, 'UPDATE', id, 1)).toEqual({ status: 'CONFLICT', reason: 'not_found' })
    expect(await row(id)).toBeUndefined()
  })
  it('replaying an applied mutation id is ALREADY_APPLIED and does nothing, even after someone else edited', async () => {
    const t = await add(B)
    const mid = crypto.randomUUID()
    expect((await mutate(B, 'UPDATE', t.id, 1, payload({ amount_minor: 60000 }), { mid })).status).toBe('APPLIED')
    await mutate(A, 'UPDATE', t.id, 2, payload({ amount_minor: 90000 })) // owner's later edit
    expect(await mutate(B, 'UPDATE', t.id, 1, payload({ amount_minor: 60000 }), { mid })).toEqual({ status: 'ALREADY_APPLIED', version: 2 })
    expect(await row(t.id)).toMatchObject({ amount_minor: 90000, version: 3 })
  })
  it('a replayed DELETE is idempotent', async () => {
    const t = await add(B)
    const mid = crypto.randomUUID()
    await mutate(B, 'DELETE', t.id, 1, null, { mid })
    expect((await mutate(B, 'DELETE', t.id, 1, null, { mid })).status).toBe('ALREADY_APPLIED')
  })
  it('a mutation id cannot be reused for another transaction or by another user', async () => {
    const t1 = await add(B)
    const t2 = await add(B)
    const mid = crypto.randomUUID()
    await mutate(B, 'UPDATE', t1.id, 1, payload(), { mid })
    await expect(mutate(B, 'UPDATE', t2.id, 1, payload(), { mid })).rejects.toThrow(/reused/)
    await expect(mutate(A, 'UPDATE', t2.id, 1, payload(), { mid })).rejects.toThrow(/duplicate key/) // A cannot see B's ledger row; the PK still holds
  })
  it('member cannot touch the owner\'s row; owner can touch any online; unauthorised never changes data', async () => {
    const mine = await add(A)
    expect((await mutate(B, 'UPDATE', mine.id, 1)).status).toBe('FORBIDDEN')
    expect((await mutate(B, 'DELETE', mine.id, 1)).status).toBe('FORBIDDEN')
    expect(await row(mine.id)).toMatchObject({ amount_minor: 50000, version: 1 })
    const theirs = await add(B)
    expect((await mutate(A, 'UPDATE', theirs.id, 1)).status).toBe('APPLIED') // owner, online path
  })
  it('offline replay (own_only) refuses another user\'s row even for the owner', async () => {
    const theirs = await add(B)
    expect((await mutate(A, 'UPDATE', theirs.id, 1, payload(), { own: true })).status).toBe('FORBIDDEN')
    expect((await mutate(A, 'DELETE', theirs.id, 1, null, { own: true })).status).toBe('FORBIDDEN')
    expect(await row(theirs.id)).toMatchObject({ version: 1 })
  })
  it('outsiders see nothing: UPDATE conflicts, DELETE is already gone, data untouched', async () => {
    const t = await add(A)
    expect((await mutate(C, 'UPDATE', t.id, 1)).status).toBe('CONFLICT')
    expect((await mutate(C, 'DELETE', t.id, 1)).status).toBe('ALREADY_GONE')
    expect(await row(t.id)).toMatchObject({ amount_minor: 50000, version: 1 })
  })
  it('payload cannot spoof server fields; constraint violations raise', async () => {
    const t = await add(B)
    await mutate(B, 'UPDATE', t.id, 1, { ...payload(), created_by: A, wallet_id: crypto.randomUUID(), paid_by_user_id: A, version: 50 })
    const r = await db.query<{ created_by: string; paid_by_user_id: string; wallet_id: string; version: string }>(
      `select created_by, paid_by_user_id, wallet_id, version from public.transactions where id = $1`, [t.id])
    expect(r.rows[0]).toMatchObject({ created_by: B, paid_by_user_id: A, wallet_id: WA, version: 2 }) // payer A is a current member (D7); the rest cannot be spoofed
    await expect(mutate(B, 'UPDATE', t.id, 2, payload({ amount_minor: 0 }))).rejects.toThrow(/check/)
  })
  it('needs a session, rejects bad ops, and clients cannot write the ledger directly', async () => {
    await db.exec('set role anon')
    await expect(db.query(`select public.apply_transaction_mutation(gen_random_uuid(), 'DELETE', gen_random_uuid(), 1)`)).rejects.toThrow(/permission denied/)
    await db.exec('reset role')
    await expect(mutate(A, 'DROP', crypto.randomUUID(), 1)).rejects.toThrow(/invalid operation/)
    await expect(as(A, () => db.query(`update public.transaction_mutations set applied_version = 1`))).rejects.toThrow(/permission denied/)
    await expect(as(A, () => db.query(`delete from public.transaction_mutations`))).rejects.toThrow(/permission denied/)
  })
  it('clients cannot write the ledger or delete transactions directly', async () => {
    await expect(as(A, () => db.query(`insert into public.transaction_mutations (mutation_id, transaction_id, op, applied_version) values (gen_random_uuid(), gen_random_uuid(), 'UPDATE', 1)`))).rejects.toThrow(/permission denied/)
    await expect(as(A, () => db.query(`delete from public.transactions`))).rejects.toThrow(/permission denied/)
  })
  it('each user reads only their own ledger rows', async () => {
    const t = await add(B)
    await mutate(B, 'UPDATE', t.id, 1)
    expect((await as(A, () => db.query(`select 1 from public.transaction_mutations where transaction_id = $1`, [t.id]))).rows).toHaveLength(0)
    expect((await as(B, () => db.query(`select 1 from public.transaction_mutations where transaction_id = $1`, [t.id]))).rows).toHaveLength(1)
  })
})

describe('Phase 12B: SECURITY DEFINER authorization', () => {
  const owner = async (fn: string) => (await db.query<{ proowner: string; prosecdef: boolean; proconfig: string[] }>(
    `select proowner::regrole::text proowner, prosecdef, proconfig from pg_proc where proname = $1`, [fn])).rows[0]!
  it('is definer with an empty search_path', async () => {
    const f = await owner('apply_transaction_mutation')
    expect(f.prosecdef).toBe(true)
    expect(f.proconfig).toContain('search_path=""')
  })
  it('a transaction cannot be moved into a wallet the caller does not belong to (foreign account), by anyone', async () => {
    const WB = await as(C, () => db.query<{ id: string }>('select * from public.create_wallet($1)', ['Other'])).then((r) => r.rows[0]!.id)
    const accB = await as(C, () => db.query<{ id: string }>(`insert into public.accounts (id, wallet_id, name, type) values (gen_random_uuid(), $1, 'Cash', 'cash') returning id`, [WB])).then((r) => r.rows[0]!.id)
    const t = await add(B)
    await expect(mutate(B, 'UPDATE', t.id, 1, payload({ account_id: accB }))).rejects.toThrow(/cannot move between wallets/)
    // C owns WB but is not a member of WA: the row is invisible to them, so nothing happens and nothing is disclosed
    expect(await mutate(C, 'UPDATE', t.id, 1, payload({ account_id: accB }))).toEqual({ status: 'CONFLICT', reason: 'not_found' })
    expect(await row(t.id)).toMatchObject({ amount_minor: 50000, version: 1 })
    expect((await db.query<{ wallet_id: string }>(`select wallet_id from public.transactions where id = $1`, [t.id])).rows[0]!.wallet_id).toBe(WA)
  })
  it('a member of both wallets also cannot move their own row between them', async () => {
    const WB = await as(C, () => db.query<{ id: string }>('select * from public.create_wallet($1)', ['Two'])).then((r) => r.rows[0]!.id)
    await db.query(`insert into public.wallet_members (wallet_id, user_id, role) values ($1, $2, 'member')`, [WB, B])
    const accB = await as(C, () => db.query<{ id: string }>(`insert into public.accounts (id, wallet_id, name, type) values (gen_random_uuid(), $1, 'Cash', 'cash') returning id`, [WB])).then((r) => r.rows[0]!.id)
    const t = await add(B)
    await expect(mutate(B, 'UPDATE', t.id, 1, payload({ account_id: accB }))).rejects.toThrow(/cannot move between wallets/)
  })
  it('non-members learn nothing: no version, wallet or owner in any reply', async () => {
    const t = await add(A)
    await mutate(A, 'UPDATE', t.id, 1) // v2, so a version-bearing CONFLICT would be distinguishable
    for (const own of [true, false]) {
      expect(await mutate(C, 'UPDATE', t.id, 1, payload(), { own })).toEqual({ status: 'CONFLICT', reason: 'not_found' })
      expect(await mutate(C, 'DELETE', t.id, 1, null, { own })).toEqual({ status: 'ALREADY_GONE' })
    }
    expect(await row(t.id)).toBeTruthy()
  })
  it('a member without permission gets FORBIDDEN (no version either); an authorised stale caller gets the version', async () => {
    const t = await add(A)
    expect(await mutate(B, 'UPDATE', t.id, 99)).toEqual({ status: 'FORBIDDEN' })
    expect(await mutate(A, 'UPDATE', t.id, 99)).toEqual({ status: 'CONFLICT', reason: 'version_mismatch', version: 1 })
  })
  it('a replayed mutation id is scoped to its user: the same id from another user never returns ALREADY_APPLIED', async () => {
    const t = await add(B)
    const mid = crypto.randomUUID()
    await mutate(B, 'UPDATE', t.id, 1, payload(), { mid })
    await expect(mutate(A, 'DELETE', t.id, 2, null, { mid })).rejects.toThrow(/duplicate key/)
    expect(await row(t.id)).toBeTruthy() // the failed attempt rolled back whole
  })
  it('a former member who created a row can no longer mutate it', async () => {
    const t = await add(B)
    await db.query(`delete from public.wallet_members where wallet_id = $1 and user_id = $2`, [WA, B])
    expect(await mutate(B, 'UPDATE', t.id, 1)).toEqual({ status: 'CONFLICT', reason: 'not_found' })
    await db.query(`insert into public.wallet_members (wallet_id, user_id, role) values ($1, $2, 'member')`, [WA, B])
  })
})
