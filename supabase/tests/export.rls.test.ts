// Phase D10: the data export is built only from the reads the app already makes as the signed-in user. These tests run
// those exact reads under each role and show what the loader can receive: nothing from a wallet the user is not in,
// and no email or other profile data of co-members.
import { PGlite } from '@electric-sql/pglite'
import { readdirSync, readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'

const A = '11111111-1111-4111-8111-111111111111' // owner of WA
const B = '22222222-2222-4222-8222-222222222222' // member of WA
const C = '33333333-3333-4333-8333-333333333333' // owner of WC, outsider to WA
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
const q = <T extends object>(uid: string | null, sql: string, args: unknown[] = []) => as(uid, () => db.query<T>(sql, args)).then((r) => r.rows)
const run = (uid: string, sql: string, args: unknown[] = []) => as(uid, () => db.query(sql, args))

/** The loader's reads, in the order exportService.ts makes them (the wallet list mirrors walletService.list). */
const readWallets = (uid: string) =>
  q<{ id: string }>(uid, `select w.id from public.wallets w join public.wallet_members m on m.wallet_id = w.id where m.user_id = $1`, [uid])
const readProfiles = (uid: string) => q<{ id: string; display_name: string | null }>(uid, 'select id, display_name from public.profiles')
const read = (uid: string, wallet: string) => ({
  members: () => q<{ user_id: string }>(uid, 'select * from public.list_wallet_members($1)', [wallet]),
  accounts: () => q<{ account_id: string }>(uid, 'select * from public.account_summaries($1)', [wallet]),
  categories: () => q<{ id: string }>(uid, 'select id from public.categories where wallet_id = $1', [wallet]),
  budgets: () => q<{ id: string }>(uid, 'select id from public.budgets where wallet_id = $1', [wallet]),
  transactions: () => q<{ id: string }>(uid, 'select id from public.transactions where wallet_id = $1', [wallet]),
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
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(new URL(f, dir), 'utf8'))
  }
  for (const [u, name] of [[A, 'Alice'], [B, 'Bob'], [C, 'Carol']] as const) {
    await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [u, `${name.toLowerCase()}@private.example`, JSON.stringify({ display_name: name })])
  }
  const wallet = (uid: string, name: string) => q<{ id: string }>(uid, 'select * from public.create_wallet($1)', [name]).then((r) => r[0]!.id)
  WA = await wallet(A, 'Household')
  WC = await wallet(C, 'Private')
  await db.query(`insert into public.wallet_members values ($1, $2, 'member')`, [WA, B])
  for (const [uid, w] of [[A, WA], [C, WC]] as const) {
    const acct = (await q<{ id: string }>(uid, `insert into public.accounts (id, wallet_id, name, type) values (gen_random_uuid(), $1, 'Cash', 'cash') returning id`, [w]))[0]!.id
    const cat = (await q<{ id: string }>(uid, `select id from public.categories where wallet_id = $1 and parent_id is null and name = 'Food'`, [w]))[0]!.id
    await run(uid, `insert into public.budgets (id, wallet_id, category_id, month, amount_minor) values (gen_random_uuid(), $1, $2, '2026-10-01', 100)`, [w, cat])
    await run(uid, `insert into public.transactions (id, account_id, category_id, type, amount_minor, date) values (gen_random_uuid(), $1, $2, 'expense', 5, '2026-10-10')`, [acct, cat])
  }
})

describe('the export loader only ever receives what the user may already read', () => {
  it('a member reads every collection of their wallet, including transactions the owner created', async () => {
    const r = read(B, WA)
    expect((await r.members()).map((m) => m.user_id).sort()).toEqual([A, B].sort())
    expect(await r.accounts()).toHaveLength(1)
    expect((await r.categories()).length).toBeGreaterThan(0)
    expect(await r.budgets()).toHaveLength(1)
    expect(await r.transactions()).toHaveLength(1)
  })
  it('an outsider gets nothing of another wallet: empty reads, and a refused member list', async () => {
    const r = read(C, WA)
    expect(await r.accounts()).toEqual([])
    expect(await r.categories()).toEqual([])
    expect(await r.budgets()).toEqual([])
    expect(await r.transactions()).toEqual([])
    await expect(r.members()).rejects.toThrow(/not allowed/)
  })
  it('the wallet list is only the wallets the user belongs to', async () => {
    expect((await readWallets(B)).map((w) => w.id)).toEqual([WA])
    expect((await readWallets(C)).map((w) => w.id)).toEqual([WC])
  })
  it('signed out, none of it is readable', async () => {
    await expect(q(null, 'select id from public.transactions')).rejects.toThrow(/permission denied/)
    await expect(q(null, 'select * from public.list_wallet_members($1)', [WA])).rejects.toThrow(/permission denied/)
  })
})

describe('no other user\'s identity data', () => {
  it('profiles are readable only for oneself, even for a co-member', async () => {
    expect((await readProfiles(B)).map((p) => p.id)).toEqual([B])
  })
  it('the member list carries no email: only id, role, join date, display name and avatar', async () => {
    const r = await as(B, () => db.query('select * from public.list_wallet_members($1)', [WA]))
    expect(r.fields.map((f) => f.name)).toEqual(['user_id', 'role', 'joined_at', 'display_name', 'avatar_url'])
    expect(JSON.stringify(r.rows)).not.toMatch(/private\.example|@/)
  })
})
