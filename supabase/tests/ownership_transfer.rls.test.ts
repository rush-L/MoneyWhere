// Phase D6: ownership transfer. Real migrations + RLS in PGlite with a stubbed `auth` schema.
import { PGlite } from '@electric-sql/pglite'
import { readdirSync, readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'

const A = '11111111-1111-4111-8111-111111111111' // owner of WA
const B = '22222222-2222-4222-8222-222222222222' // member of WA
const C = '33333333-3333-4333-8333-333333333333' // owner of WC, outsider to WA
const D = '44444444-4444-4444-8444-444444444444' // member of WA (and WC)
const F = '66666666-6666-4666-8666-666666666666' // former member of WA
const NOBODY = '99999999-9999-4999-8999-999999999999'
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
const rpc = async <T = unknown>(uid: string | null, sql: string, params: unknown[] = []) =>
  (await as(uid, () => db.query<{ r: T }>(`select ${sql} as r`, params))).rows[0]!.r
const transfer = (uid: string | null, wallet: string, to: string | null) => rpc(uid, 'public.transfer_wallet_ownership($1, $2)', [wallet, to])
const createWallet = (uid: string, name: string) =>
  as(uid, () => db.query<{ id: string }>('select * from public.create_wallet($1)', [name])).then((r) => r.rows[0]!.id)
const roles = async (wallet: string) =>
  Object.fromEntries((await db.query<{ user_id: string; role: string }>('select user_id, role from public.wallet_members where wallet_id = $1', [wallet])).rows.map((r) => [r.user_id, r.role]))
const owners = async (wallet: string) => (await db.query(`select 1 from public.wallet_members where wallet_id = $1 and role = 'owner'`, [wallet])).rows.length
const invite = (uid: string, wallet: string) => rpc<{ token: string }>(uid, 'public.create_wallet_invitation($1)', [wallet])
const listMembers = (uid: string, wallet: string) =>
  as(uid, () => db.query<{ user_id: string; role: string }>('select user_id, role from public.list_wallet_members($1)', [wallet])).then((r) => r.rows)
const snapshot = async () => ({
  wallets: (await db.query('select * from public.wallets order by id')).rows,
  accounts: (await db.query('select * from public.accounts order by id')).rows,
  categories: (await db.query('select * from public.categories order by id')).rows,
  budgets: (await db.query('select * from public.budgets order by id')).rows,
  tx: (await db.query('select * from public.transactions order by id')).rows,
})

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
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) await db.exec(readFileSync(new URL(f, dir), 'utf8'))
  for (const u of [A, B, C, D, F]) await db.query(`insert into auth.users (id) values ($1)`, [u])
  WA = await createWallet(A, 'Household')
  WC = await createWallet(C, 'Private')
  for (const u of [B, D, F]) await db.query(`insert into public.wallet_members values ($1, $2, 'member')`, [WA, u])
  await db.query(`insert into public.wallet_members values ($1, $2, 'member')`, [WC, D])
  const acct = (await db.query<{ id: string }>(`insert into public.accounts (id, wallet_id, name, type) values (gen_random_uuid(), $1, 'Cash', 'cash') returning id`, [WA])).rows[0]!.id
  const cat = (await db.query<{ id: string }>('select id from public.categories where wallet_id = $1 limit 1', [WA])).rows[0]!.id
  await db.query(`insert into public.budgets (wallet_id, category_id, month, amount_minor) values ($1, $2, '2026-10-01', 5000)`, [WA, cat])
  for (const u of [A, B]) {
    await as(u, () => db.query(`insert into public.transactions (id, account_id, category_id, type, amount_minor, date) values (gen_random_uuid(), $1, $2, 'expense', 100, '2026-10-05')`, [acct, cat]))
  }
  await rpc(A, 'public.remove_wallet_member($1, $2)', [WA, F]) // F is now a former member
})

describe('rejections leave state untouched', () => {
  it('a member cannot transfer (to self or anyone)', async () => {
    await expect(transfer(B, WA, B)).rejects.toThrow(/not allowed/)
    await expect(transfer(B, WA, D)).rejects.toThrow(/not allowed/)
  })
  it('an outsider (owner of another wallet) cannot transfer', async () => {
    await expect(transfer(C, WA, B)).rejects.toThrow(/not allowed/)
  })
  it('anon cannot execute it', async () => {
    await expect(transfer(null, WA, B)).rejects.toThrow(/permission denied/)
  })
  it('target must be a current member: outsider, former member, unknown id, null', async () => {
    await expect(transfer(A, WA, C)).rejects.toThrow(/member not found/)
    await expect(transfer(A, WA, F)).rejects.toThrow(/member not found/)
    await expect(transfer(A, WA, NOBODY)).rejects.toThrow(/member not found/)
    await expect(transfer(A, WA, null)).rejects.toThrow(/choose another member/)
  })
  it('cross-wallet: a member of a different wallet is not a valid target, and the wrong wallet is not yours', async () => {
    await expect(transfer(C, WC, B)).rejects.toThrow(/member not found/) // B is not in WC
    await expect(transfer(C, WA, D)).rejects.toThrow(/not allowed/) // C owns WC, not WA
  })
  it('owner cannot transfer to themselves; unknown wallet is refused', async () => {
    await expect(transfer(A, WA, A)).rejects.toThrow(/choose another member/)
    await expect(transfer(A, NOBODY, B)).rejects.toThrow(/not allowed/)
  })
  it('after every failure the original state is intact', async () => {
    expect(await roles(WA)).toEqual({ [A]: 'owner', [B]: 'member', [D]: 'member' })
    expect(await owners(WA)).toBe(1)
  })
})

describe('direct mutation of ownership is closed', () => {
  it('clients cannot UPDATE / INSERT / DELETE wallet_members', async () => {
    await expect(as(B, () => db.query(`update public.wallet_members set role = 'owner' where wallet_id = $1 and user_id = $2`, [WA, B]))).rejects.toThrow(/permission denied/)
    await expect(as(B, () => db.query(`insert into public.wallet_members values ($1, $2, 'owner')`, [WA, F]))).rejects.toThrow(/permission denied/)
    await expect(as(A, () => db.query(`delete from public.wallet_members where wallet_id = $1 and user_id = $2`, [WA, B]))).rejects.toThrow(/permission denied/)
  })
  it('the function is executable by authenticated only', async () => {
    const r = await db.query<{ anon: boolean; auth: boolean; pub: boolean }>(
      `select has_function_privilege('anon', 'public.transfer_wallet_ownership(uuid, uuid)', 'execute') as anon,
              has_function_privilege('authenticated', 'public.transfer_wallet_ownership(uuid, uuid)', 'execute') as auth,
              has_function_privilege('public', 'public.transfer_wallet_ownership(uuid, uuid)', 'execute') as pub`,
    )
    expect(r.rows[0]).toEqual({ anon: false, auth: true, pub: false })
  })
})

describe('successful transfer A -> B', () => {
  let before: Awaited<ReturnType<typeof snapshot>>
  beforeAll(async () => {
    before = await snapshot()
    await transfer(A, WA, B)
  })
  it('swaps roles; exactly one owner; both stay members; nobody else changes', async () => {
    expect(await roles(WA)).toEqual({ [A]: 'member', [B]: 'owner', [D]: 'member' })
    expect(await owners(WA)).toBe(1)
  })
  it('wallet, accounts, categories, budgets and transactions (created_by, paid_by_user_id) are unchanged', async () => {
    expect(before.tx.length).toBe(2)
    expect(await snapshot()).toEqual(before)
  })
  it('the other wallet is unaffected', async () => {
    expect(await roles(WC)).toEqual({ [C]: 'owner', [D]: 'member' })
  })
  it('D5 member list: new owner is owner, previous owner is a member, no one is lost', async () => {
    const list = await listMembers(A, WA)
    expect(Object.fromEntries(list.map((m) => [m.user_id, m.role]))).toEqual({ [A]: 'member', [B]: 'owner', [D]: 'member' })
  })
  it('new owner gains owner rights; previous owner loses them but stays a member', async () => {
    expect((await invite(B, WA)).token).toMatch(/^[0-9a-f]{64}$/)
    await expect(invite(A, WA)).rejects.toThrow(/not allowed/)
    await expect(rpc(A, 'public.remove_wallet_member($1, $2)', [WA, D])).rejects.toThrow(/not allowed/)
    await expect(transfer(A, WA, D)).rejects.toThrow(/not allowed/)
    await expect(as(A, () => db.query(`insert into public.accounts (wallet_id, name, type) values ($1, 'X', 'cash')`, [WA]))).rejects.toThrow(/row-level security/)
    expect((await as(A, () => db.query('select id from public.wallets where id = $1', [WA]))).rows.length).toBe(1) // member read still works
    expect((await as(A, () => db.query('select id from public.transactions'))).rows.length).toBe(2)
  })
  it('the new owner cannot leave; a transfer back works symmetrically', async () => {
    await expect(rpc(B, 'public.leave_wallet($1)', [WA])).rejects.toThrow(/owner cannot leave/)
    await transfer(B, WA, A)
    expect(await roles(WA)).toEqual({ [A]: 'owner', [B]: 'member', [D]: 'member' })
  })
})

describe('stale membership cannot regain ownership', () => {
  it('a removed member cannot be promoted and cannot transfer', async () => {
    await rpc(A, 'public.remove_wallet_member($1, $2)', [WA, D])
    await expect(transfer(A, WA, D)).rejects.toThrow(/member not found/)
    await expect(transfer(D, WA, D)).rejects.toThrow(/not allowed/)
    expect(await owners(WA)).toBe(1)
  })
})

describe('concurrency', () => {
  it('a second transfer by the former owner is refused, leaving exactly one owner', async () => {
    await db.query(`insert into public.wallet_members values ($1, $2, 'member')`, [WA, D])
    // PGlite is a single session: this proves the post-lock re-check, not true lock timing (see changelog).
    await transfer(A, WA, B)
    await expect(transfer(A, WA, D)).rejects.toThrow(/not allowed/)
    expect(await roles(WA)).toEqual({ [A]: 'member', [B]: 'owner', [D]: 'member' })
    expect(await owners(WA)).toBe(1)
  })
})
