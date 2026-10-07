// Real migrations + RLS in in-process Postgres (PGlite) with a stubbed `auth` schema.
import { PGlite } from '@electric-sql/pglite'
import { readdirSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
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
const addAccount = (uid: string, wallet: string, over: Record<string, unknown> = {}) => {
  const v = { id: randomUUID(), wallet_id: wallet, name: 'GCash', type: 'e_wallet', opening_balance_minor: 1000000, holder: 'Russel', ...over }
  const keys = Object.keys(v)
  return as(uid, () =>
    db.query<{ id: string; updated_at: string }>(
      `insert into public.accounts (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')}) returning *`,
      Object.values(v),
    ),
  )
}

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

describe('accounts', () => {
  it('owner creates; currency comes from the wallet and cannot be client-supplied', async () => {
    const r = await addAccount(A, WA)
    expect(r.rows[0]).toMatchObject({ currency: 'PHP', wallet_id: WA, holder: 'Russel' })
    await expect(addAccount(A, WA, { currency: 'USD' })).rejects.toThrow(/permission denied/)
  })
  it('holder is optional', async () => {
    expect((await addAccount(A, WA, { holder: null })).rows[0]).toMatchObject({ holder: null })
  })
  it('members can read but not create or update; outsiders see and do nothing', async () => {
    const mine = (await addAccount(A, WA, { name: 'Bank' })).rows[0]!
    const seen = (uid: string) => as(uid, () => db.query(`select id from public.accounts where wallet_id = $1`, [WA])).then((r) => r.rows.length)
    expect(await seen(B)).toBeGreaterThan(0)
    expect(await seen(C)).toBe(0)
    await expect(addAccount(B, WA)).rejects.toThrow(/row-level security/)
    await expect(addAccount(C, WA)).rejects.toThrow(/row-level security/)
    await expect(as(null, () => db.query(`select * from public.accounts`))).rejects.toThrow(/permission denied/)
    for (const uid of [B, C]) {
      const u = await as(uid, () => db.query(`update public.accounts set name = 'hacked' where id = $1`, [mine.id]))
      expect(u.affectedRows).toBe(0)
    }
  })
  it('owner can edit all editable fields before transactions; updated_at moves; wallet/currency stay fixed', async () => {
    const a = (await addAccount(A, WA, { name: 'Old' })).rows[0]!
    const u = await as(A, () =>
      db.query<{ name: string; type: string; opening_balance_minor: number; updated_at: string }>(
        `update public.accounts set name = 'New', type = 'bank', opening_balance_minor = 5, holder = null where id = $1 returning *`, [a.id]),
    )
    expect(u.rows[0]).toMatchObject({ name: 'New', type: 'bank', opening_balance_minor: 5 })
    expect(new Date(u.rows[0]!.updated_at).getTime()).toBeGreaterThanOrEqual(new Date(a.updated_at).getTime())
    for (const col of ["currency = 'USD'", `wallet_id = '${WC}'`]) {
      await expect(as(A, () => db.query(`update public.accounts set ${col} where id = $1`, [a.id]))).rejects.toThrow(/permission denied/)
    }
    // the type/negative-balance CHECK still applies on edit
    await expect(as(A, () => db.query(`update public.accounts set opening_balance_minor = -1 where id = $1`, [a.id]))).rejects.toThrow(/check/)
  })
  it('members and outsiders cannot delete; owner can delete before transactions', async () => {
    const a = (await addAccount(A, WA, { name: 'Gone' })).rows[0]!
    for (const uid of [B, C]) {
      expect((await as(uid, () => db.query(`delete from public.accounts where id = $1`, [a.id]))).affectedRows).toBe(0)
    }
    expect((await as(A, () => db.query(`delete from public.accounts where id = $1`, [a.id]))).affectedRows).toBe(1)
  })
  it('once the account has transactions: name/holder editable, type/opening balance/delete blocked', async () => {
    const a = (await addAccount(A, WA, { name: 'Used' })).rows[0]!
    // simulate the future transactions migration replacing the existence check
    await db.exec(`create or replace function public.account_has_transactions(p_account_id uuid) returns boolean
      language sql stable security definer set search_path = '' as $$ select true $$`)
    try {
      expect((await as(A, () => db.query(`update public.accounts set name = 'Renamed', holder = 'Y' where id = $1`, [a.id]))).affectedRows).toBe(1)
      await expect(as(A, () => db.query(`update public.accounts set type = 'bank' where id = $1`, [a.id]))).rejects.toThrow(/has transactions/)
      await expect(as(A, () => db.query(`update public.accounts set opening_balance_minor = 1 where id = $1`, [a.id]))).rejects.toThrow(/has transactions/)
      // unchanged values in a no-op write are fine
      expect((await as(A, () => db.query(`update public.accounts set type = type where id = $1`, [a.id]))).affectedRows).toBe(1)
      expect((await as(A, () => db.query(`delete from public.accounts where id = $1`, [a.id]))).affectedRows).toBe(0)
    } finally {
      await db.exec(`create or replace function public.account_has_transactions(p_account_id uuid) returns boolean
        language sql stable security definer set search_path = '' as $$ select false $$`)
    }
  })
  it('constraints: types, name, holder, negative balances, range, unknown wallet', async () => {
    await expect(addAccount(A, WA, { type: 'crypto' })).rejects.toThrow(/check/)
    await expect(addAccount(A, WA, { name: '   ' })).rejects.toThrow(/check/)
    await expect(addAccount(A, WA, { holder: 'x'.repeat(51) })).rejects.toThrow(/check/)
    await expect(addAccount(A, WA, { opening_balance_minor: -1 })).rejects.toThrow(/check/)
    expect((await addAccount(A, WA, { type: 'loan', opening_balance_minor: -50000 })).rows).toHaveLength(1)
    await expect(addAccount(A, WA, { opening_balance_minor: '9007199254740992' })).rejects.toThrow(/check/)
    await expect(addAccount(A, randomUUID())).rejects.toThrow(/row-level security/)
  })
  it('all five types are accepted; duplicate id rejected', async () => {
    for (const type of ['cash', 'e_wallet', 'bank', 'credit_card', 'loan']) await addAccount(A, WA, { type, opening_balance_minor: 0 })
    const id = randomUUID()
    await addAccount(A, WA, { id })
    await expect(addAccount(A, WA, { id })).rejects.toThrow(/duplicate/)
  })
  it('account_has_transactions is not callable by anon or PUBLIC; authenticated keeps execute', async () => {
    const fn = `'public.account_has_transactions(uuid)'`
    const priv = await db.query<{ anon: boolean; auth: boolean; public_acl: boolean }>(
      `select has_function_privilege('anon', ${fn}, 'execute') as anon,
              has_function_privilege('authenticated', ${fn}, 'execute') as auth,
              exists (select 1 from pg_proc p, aclexplode(p.proacl) a where p.oid = ${fn}::regprocedure and a.grantee = 0) as public_acl`)
    expect(priv.rows[0]).toEqual({ anon: false, auth: true, public_acl: false })
    // anon cannot call it, with or without a real account id
    const a = (await addAccount(A, WA, { name: 'Probe' })).rows[0]!
    for (const id of [a.id, randomUUID()]) {
      await expect(as(null, () => db.query(`select public.account_has_transactions($1)`, [id]))).rejects.toThrow(/permission denied for function/)
    }
    // a signed-in user still can (the policy and trigger below run as the caller); the function itself is unchanged
    const r = await as(B, () => db.query<{ r: boolean }>(`select public.account_has_transactions($1) as r`, [a.id]))
    expect(r.rows[0]!.r).toBe(false)
  })
  it('the delete policy and history trigger really do need authenticated execute (negative control)', async () => {
    const a = (await addAccount(A, WA, { name: 'Control' })).rows[0]!
    await db.exec(`revoke execute on function public.account_has_transactions(uuid) from authenticated`)
    try {
      await expect(as(A, () => db.query(`delete from public.accounts where id = $1`, [a.id]))).rejects.toThrow(/permission denied for function/)
      await expect(as(A, () => db.query(`update public.accounts set type = 'bank' where id = $1`, [a.id]))).rejects.toThrow(/permission denied for function/)
    } finally {
      await db.exec(`grant execute on function public.account_has_transactions(uuid) to authenticated`)
    }
    // restored: the owner path works again, a member still cannot delete
    expect((await as(B, () => db.query(`delete from public.accounts where id = $1`, [a.id]))).affectedRows).toBe(0)
    expect((await as(A, () => db.query(`update public.accounts set type = 'bank' where id = $1`, [a.id]))).affectedRows).toBe(1)
    expect((await as(A, () => db.query(`delete from public.accounts where id = $1`, [a.id]))).affectedRows).toBe(1)
  })
  it('deleting the wallet removes its accounts', async () => {
    const w = await createWallet(A, 'Temp')
    await addAccount(A, w)
    await as(A, () => db.query(`delete from public.wallets where id = $1`, [w]))
    expect((await db.query(`select 1 from public.accounts where wallet_id = $1`, [w])).rows).toHaveLength(0)
  })
})
