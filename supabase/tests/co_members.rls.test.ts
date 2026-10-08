// Phase D5: co-member visibility and former-member privacy. Real migrations + RLS in PGlite with a stubbed `auth` schema.
import { PGlite } from '@electric-sql/pglite'
import { readdirSync, readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'

const A = '11111111-1111-4111-8111-111111111111' // owner of WA
const B = '22222222-2222-4222-8222-222222222222' // member of WA
const C = '33333333-3333-4333-8333-333333333333' // owner of WC, outsider to WA
const D = '44444444-4444-4444-8444-444444444444' // member of WA, leaves by themselves
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
type Row = { user_id: string; role: string; joined_at: string; display_name: string | null; avatar_url: string | null }
const list = (uid: string | null, wallet: string) => as(uid, () => db.query<Row>('select * from public.list_wallet_members($1)', [wallet])).then((r) => r.rows)
const createWallet = (uid: string, name: string) =>
  as(uid, () => db.query<{ id: string }>('select * from public.create_wallet($1)', [name])).then((r) => r.rows[0]!.id)
const byId = (rows: Row[], id: string) => rows.find((r) => r.user_id === id)

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
  const names: Record<string, [string, string | null]> = {
    [A]: ['Alice Owner', 'https://img.example/a.png'],
    [B]: ['Bob Member', null],
    [C]: ['Carol Outsider', 'https://img.example/c.png'],
    [D]: ['Dan Leaver', null],
  }
  for (const [u, [name]] of Object.entries(names)) {
    await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [u, `${name.split(' ')[0]!.toLowerCase()}@private.example`, JSON.stringify({ display_name: name })])
  }
  await db.query(`update public.profiles set avatar_url = $2 where id = $1`, [A, names[A]![1]])
  await db.query(`update public.profiles set avatar_url = $2 where id = $1`, [C, names[C]![1]])
  WA = await createWallet(A, 'Household')
  WC = await createWallet(C, 'Private')
  await db.query(`insert into public.wallet_members values ($1, $2, 'member'), ($1, $3, 'member')`, [WA, B, D])
})

describe('current co-member visibility', () => {
  it('the owner sees every current member with role, display name and avatar', async () => {
    const rows = await list(A, WA)
    expect(rows.map((r) => r.user_id).sort()).toEqual([A, B, D].sort())
    expect(byId(rows, A)).toMatchObject({ role: 'owner', display_name: 'Alice Owner', avatar_url: 'https://img.example/a.png' })
    expect(byId(rows, B)).toMatchObject({ role: 'member', display_name: 'Bob Member', avatar_url: null })
  })
  it('a member sees the same co-members, including the owner', async () => {
    const rows = await list(B, WA)
    expect(rows.map((r) => r.user_id).sort()).toEqual([A, B, D].sort())
    expect(byId(rows, A)?.role).toBe('owner')
    expect(rows.filter((r) => r.role === 'owner')).toHaveLength(1)
  })
  it('exposes only role, joined date, display name and avatar: no email or auth data', async () => {
    const r = await as(B, () => db.query('select * from public.list_wallet_members($1)', [WA]))
    expect(r.fields.map((f) => f.name)).toEqual(['user_id', 'role', 'joined_at', 'display_name', 'avatar_url'])
    expect(JSON.stringify(r.rows)).not.toMatch(/private\.example|@/)
  })
  it('a profile edit shows immediately (current identity, not a copy)', async () => {
    await as(B, () => db.query(`update public.profiles set display_name = 'Bobby' where id = $1`, [B]))
    expect(byId(await list(A, WA), B)?.display_name).toBe('Bobby')
    await as(B, () => db.query(`update public.profiles set display_name = 'Bob Member' where id = $1`, [B]))
  })
})

describe('boundaries: no enumeration of other users', () => {
  it('an outsider cannot list this wallet; a member of another wallet cannot either (cross-wallet)', async () => {
    await expect(list(C, WA)).rejects.toThrow(/not allowed/)
    await expect(list(B, WC)).rejects.toThrow(/not allowed/)
  })
  it('anon and signed-out callers cannot call it', async () => {
    await expect(list(null, WA)).rejects.toThrow(/permission denied/)
  })
  it('an unknown wallet looks the same as a foreign one', async () => {
    await expect(list(A, '99999999-9999-4999-8999-999999999999')).rejects.toThrow(/not allowed/)
  })
  it('results never include users outside the wallet', async () => {
    expect((await list(A, WA)).some((r) => r.user_id === C)).toBe(false)
    expect((await list(C, WC)).map((r) => r.user_id)).toEqual([C])
  })
  it('profiles itself stays own-row only: no policy was broadened', async () => {
    const own = await as(A, () => db.query<{ id: string }>('select id from public.profiles'))
    expect(own.rows.map((r) => r.id)).toEqual([A])
    expect((await as(A, () => db.query('select id from public.profiles where id = $1', [B]))).rows).toHaveLength(0) // a co-member's row is still unreadable directly
    const pol = await db.query<{ policyname: string; cmd: string }>(`select policyname, cmd from pg_policies where tablename = 'profiles' order by policyname`)
    expect(pol.rows).toEqual([{ policyname: 'profiles_select_own', cmd: 'SELECT' }, { policyname: 'profiles_update_own', cmd: 'UPDATE' }])
    await expect(as(null, () => db.query('select id from public.profiles'))).rejects.toThrow(/permission denied/)
  })
  it('the function is security definer with a pinned search_path, and anon/public cannot execute it', async () => {
    const r = await db.query<{ secdef: boolean; cfg: string[]; anon: boolean; pub: boolean; auth: boolean }>(
      `select prosecdef as secdef, proconfig as cfg, has_function_privilege('anon', oid, 'execute') as anon,
              has_function_privilege('authenticated', oid, 'execute') as auth,
              (select coalesce(bool_or(a.grantee = 0), false) from aclexplode(coalesce(proacl, acldefault('f', proowner))) a) as pub
         from pg_proc where proname = 'list_wallet_members'`,
    )
    expect(r.rows[0]).toMatchObject({ secdef: true, anon: false, pub: false, auth: true })
    expect(r.rows[0]!.cfg).toContain('search_path=""')
  })
})

describe('former members: history stays, identity is not exposed', () => {
  let tx: string
  it('setup: B and D each created a transaction in WA', async () => {
    const acct = (await db.query<{ id: string }>(`insert into public.accounts (id, wallet_id, name, type) values (gen_random_uuid(), $1, 'Cash', 'cash') returning id`, [WA])).rows[0]!.id
    const cat = (await db.query<{ id: string }>('select id from public.categories where wallet_id = $1 limit 1', [WA])).rows[0]!.id
    for (const u of [B, D]) {
      await as(u, () => db.query(`insert into public.transactions (id, account_id, category_id, type, amount_minor, date) values (gen_random_uuid(), $1, $2, 'expense', 100, '2026-10-05')`, [acct, cat]))
    }
    tx = (await db.query<{ id: string }>('select id from public.transactions where created_by = $1', [B])).rows[0]!.id
    expect((await db.query('select 1 from public.transactions where wallet_id = $1', [WA])).rows).toHaveLength(2)
  })
  it('before: B is listed with a name, so B\'s transaction resolves to a current identity', async () => {
    expect(byId(await list(A, WA), B)?.display_name).toBe('Bob Member')
  })
  it('after the owner removes B: B is gone from the list for everyone, the transaction is untouched', async () => {
    await as(A, () => db.query('select public.remove_wallet_member($1, $2)', [WA, B]))
    for (const viewer of [A, D]) {
      const rows = await list(viewer, WA)
      expect(byId(rows, B)).toBeUndefined()
      expect(JSON.stringify(rows)).not.toContain('Bob')
    }
    const t = await db.query<{ created_by: string; paid_by_user_id: string }>('select created_by, paid_by_user_id from public.transactions where id = $1', [tx])
    expect(t.rows[0]).toEqual({ created_by: B, paid_by_user_id: B }) // ids intact: history is not rewritten
  })
  it("B's profile is not reachable through any wallet path after removal", async () => {
    expect((await as(A, () => db.query('select * from public.profiles where id = $1', [B]))).rows).toHaveLength(0)
    expect((await as(D, () => db.query('select * from public.profiles where id = $1', [B]))).rows).toHaveLength(0)
    await expect(list(B, WA)).rejects.toThrow(/not allowed/) // and B cannot read the wallet's members any more
  })
  it('a member who leaves by themselves is treated the same', async () => {
    expect(byId(await list(A, WA), D)?.display_name).toBe('Dan Leaver')
    await as(D, () => db.query('select public.leave_wallet($1)', [WA]))
    expect(byId(await list(A, WA), D)).toBeUndefined()
    expect((await db.query('select 1 from public.transactions where created_by = $1', [D])).rows).toHaveLength(1)
  })
  it('re-joining later makes the person visible again (membership is the authority)', async () => {
    await db.query(`insert into public.wallet_members values ($1, $2, 'member')`, [WA, B])
    expect(byId(await list(A, WA), B)?.display_name).toBe('Bob Member')
    await db.query(`delete from public.wallet_members where wallet_id = $1 and user_id = $2`, [WA, B])
  })
  it('ownership is untouched: A is still the only owner', async () => {
    expect((await list(A, WA)).filter((r) => r.role === 'owner').map((r) => r.user_id)).toEqual([A])
  })
})
