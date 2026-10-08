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
const ids = (r: { rows: unknown[] }) => (r.rows as { id: string }[]).map((x) => x.id)
const createWallet = (uid: string, name: string) =>
  as(uid, () => db.query<{ id: string }>('select * from public.create_wallet($1)', [name])).then((r) => r.rows[0]!.id)

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
  // Simulate an accepted invitation (the invitation flow itself is tested in membership.rls.test.ts): B joins WA as member.
  await db.query(`insert into public.wallet_members (wallet_id, user_id, role) values ($1, $2, 'member')`, [WA, B])
})

describe('create_wallet', () => {
  it('creates wallet and owner membership atomically, defaults PHP / shared_log', async () => {
    const w = await db.query<{ currency: string; mode: string; created_by: string }>('select * from public.wallets where id = $1', [WA])
    expect(w.rows[0]).toMatchObject({ currency: 'PHP', mode: 'shared_log', created_by: A })
    const m = await db.query<{ user_id: string; role: string }>('select user_id, role from public.wallet_members where wallet_id = $1 and role = $2', [WA, 'owner'])
    expect(m.rows).toEqual([{ user_id: A, role: 'owner' }])
  })
  it('anon cannot call it; bad names rejected', async () => {
    await expect(as(null, () => db.query(`select * from public.create_wallet('x')`))).rejects.toThrow(/permission denied/)
    await expect(as(A, () => db.query(`select * from public.create_wallet('   ')`))).rejects.toThrow(/name/)
    await expect(as(A, () => db.query(`select * from public.create_wallet($1)`, ['x'.repeat(51)]))).rejects.toThrow(/name/)
  })
  it('clients cannot insert wallets or memberships directly', async () => {
    await expect(as(A, () => db.query(`insert into public.wallets (name, created_by) values ('x', $1)`, [A]))).rejects.toThrow(/permission denied/)
    await expect(as(C, () => db.query(`insert into public.wallet_members values ($1, $2, 'member')`, [WA, C]))).rejects.toThrow(/permission denied/)
    await expect(as(C, () => db.query(`update public.wallet_members set role = 'owner' where wallet_id = $1`, [WC]))).rejects.toThrow(/permission denied/)
  })
  it('only one owner per wallet', async () => {
    await expect(db.query(`insert into public.wallet_members values ($1, $2, 'owner')`, [WA, C])).rejects.toThrow(/one_owner/)
  })
})

describe('reading', () => {
  it('members see their wallets only', async () => {
    expect(ids(await as(A, () => db.query('select id from public.wallets')))).toEqual([WA])
    expect(ids(await as(B, () => db.query('select id from public.wallets')))).toEqual([WA])
    expect(ids(await as(C, () => db.query('select id from public.wallets')))).toEqual([WC])
  })
  it('outsider cannot read another wallet or its members; anon has no access', async () => {
    expect((await as(C, () => db.query('select 1 from public.wallets where id = $1', [WA]))).rows).toHaveLength(0)
    expect((await as(C, () => db.query('select 1 from public.wallet_members where wallet_id = $1', [WA]))).rows).toHaveLength(0)
    await expect(as(null, () => db.query('select 1 from public.wallets'))).rejects.toThrow(/permission denied/)
  })
  it('members see co-members', async () => {
    const r = await as(B, () => db.query<{ user_id: string }>('select user_id from public.wallet_members where wallet_id = $1 order by role', [WA]))
    expect(r.rows.map((x) => x.user_id).sort()).toEqual([A, B].sort())
  })
})

describe('owner vs member permissions', () => {
  it('owner can rename; updated_at moves; protected columns locked', async () => {
    const r = await as(A, () => db.query(`update public.wallets set name = 'Home' where id = $1`, [WA]))
    expect(r.affectedRows).toBe(1)
    await expect(as(A, () => db.query(`update public.wallets set currency = 'PHP' where id = $1`, [WA]))).rejects.toThrow(/permission denied/)
    await expect(as(A, () => db.query(`update public.wallets set created_by = $2 where id = $1`, [WA, B]))).rejects.toThrow(/permission denied/)
  })
  it('member cannot rename or delete the wallet (0 rows)', async () => {
    expect((await as(B, () => db.query(`update public.wallets set name = 'Hacked' where id = $1`, [WA]))).affectedRows).toBe(0)
    expect((await as(B, () => db.query('delete from public.wallets where id = $1', [WA]))).affectedRows).toBe(0)
    const w = await db.query<{ name: string }>('select name from public.wallets where id = $1', [WA])
    expect(w.rows[0]?.name).toBe('Home')
  })
  it('outsider cannot rename or delete (0 rows)', async () => {
    expect((await as(C, () => db.query(`update public.wallets set name = 'Hacked' where id = $1`, [WA]))).affectedRows).toBe(0)
    expect((await as(C, () => db.query('delete from public.wallets where id = $1', [WA]))).affectedRows).toBe(0)
  })
  it('nobody can delete memberships directly (remove / leave are RPCs, see membership.rls.test.ts)', async () => {
    for (const uid of [A, B, C]) {
      await expect(as(uid, () => db.query('delete from public.wallet_members where wallet_id = $1 and user_id = $2', [WA, B]))).rejects.toThrow(/permission denied/)
    }
  })
  it('owner cannot leave; a member can leave and then loses access', async () => {
    await expect(as(A, () => db.query('select public.leave_wallet($1)', [WA]))).rejects.toThrow(/owner cannot leave/)
    await as(B, () => db.query('select public.leave_wallet($1)', [WA]))
    expect((await as(B, () => db.query('select 1 from public.wallets where id = $1', [WA]))).rows).toHaveLength(0)
  })
  it('owner can delete the wallet; memberships cascade', async () => {
    expect((await as(C, () => db.query('delete from public.wallets where id = $1', [WC]))).affectedRows).toBe(1)
    const m = await db.query('select 1 from public.wallet_members where wallet_id = $1', [WC])
    expect(m.rows).toHaveLength(0)
  })
})
