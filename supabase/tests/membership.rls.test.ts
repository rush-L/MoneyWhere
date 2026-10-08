// Phase D4: invitations, remove/leave and rate limiting. Real migrations + RLS in PGlite with a stubbed `auth` schema.
import { PGlite } from '@electric-sql/pglite'
import { readdirSync, readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'

const A = '11111111-1111-4111-8111-111111111111' // owner of WA
const B = '22222222-2222-4222-8222-222222222222' // member of WA (joins by invitation)
const C = '33333333-3333-4333-8333-333333333333' // owner of WC, outsider to WA
const D = '44444444-4444-4444-8444-444444444444' // invitee / rate-limit subject
const E = '55555555-5555-4555-8555-555555555555' // second invitee
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
const rpc = async <T = Record<string, unknown>>(uid: string | null, sql: string, params: unknown[] = []) =>
  (await as(uid, () => db.query<{ r: T }>(`select ${sql} as r`, params))).rows[0]!.r
const createWallet = (uid: string, name: string) =>
  as(uid, () => db.query<{ id: string }>('select * from public.create_wallet($1)', [name])).then((r) => r.rows[0]!.id)
const invite = (uid: string | null, wallet: string) =>
  rpc<{ id: string; token: string; expires_at: string }>(uid, 'public.create_wallet_invitation($1)', [wallet])
const accept = (uid: string | null, token: string) => rpc<{ ok: boolean; wallet_id?: string; joined?: boolean }>(uid, 'public.accept_wallet_invitation($1)', [token])
const preview = (uid: string | null, token: string) => rpc<{ ok: boolean; wallet_name?: string; already_member?: boolean }>(uid, 'public.preview_wallet_invitation($1)', [token])
const members = async (wallet: string) =>
  (await db.query<{ user_id: string; role: string }>('select user_id, role from public.wallet_members where wallet_id = $1 order by role', [wallet])).rows
const isMember = async (wallet: string, uid: string) => (await members(wallet)).some((m) => m.user_id === uid)
const reset = () => db.query('delete from public.membership_rate_events')

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
  for (const u of [A, B, C, D, E]) await db.query(`insert into auth.users (id) values ($1)`, [u])
  WA = await createWallet(A, 'Household')
  WC = await createWallet(C, 'Private')
})

describe('creating invitations', () => {
  it('owner can invite; the token is 64 hex chars and expiry is 7 days', async () => {
    const inv = await invite(A, WA)
    expect(inv.token).toMatch(/^[0-9a-f]{64}$/)
    const r = await db.query<{ days: number }>(`select extract(epoch from (expires_at - created_at)) / 86400 as days from public.wallet_invitations where id = $1`, [inv.id])
    expect(Number(r.rows[0]!.days)).toBe(7)
  })
  it('a member cannot invite', async () => {
    await db.query(`insert into public.wallet_members values ($1, $2, 'member')`, [WA, B])
    await expect(invite(B, WA)).rejects.toThrow(/not allowed/)
  })
  it('an outsider (owner of another wallet) cannot invite to this wallet', async () => {
    await expect(invite(C, WA)).rejects.toThrow(/not allowed/)
  })
  it('anon and signed-out callers cannot invite', async () => {
    await expect(invite(null, WA)).rejects.toThrow(/permission denied/)
  })
  it('an unknown wallet looks the same as a foreign one', async () => {
    await expect(invite(A, '99999999-9999-4999-8999-999999999999')).rejects.toThrow(/not allowed/)
  })
})

describe('token storage', () => {
  it('stores only sha256(token); the plaintext appears in no column', async () => {
    const inv = await invite(A, WA)
    const row = await db.query<{ same: boolean; leaked: boolean; hex: string }>(
      `select token_hash = sha256(convert_to($2, 'utf8')) as same,
              row_to_json(i)::text like '%' || $2 || '%' as leaked,
              encode(token_hash, 'hex') as hex
         from public.wallet_invitations i where id = $1`,
      [inv.id, inv.token],
    )
    expect(row.rows[0]).toMatchObject({ same: true, leaked: false })
    expect(row.rows[0]!.hex).not.toBe(inv.token)
  })
  it('tokens are unique per invitation', async () => {
    const [x, y] = [await invite(A, WA), await invite(A, WA)]
    expect(x.token).not.toBe(y.token)
  })
})

describe('direct table access is closed', () => {
  it('clients cannot insert, update or delete invitations or touch the rate table', async () => {
    const inv = await invite(A, WA)
    await expect(as(A, () => db.query(`insert into public.wallet_invitations (wallet_id, created_by, token_hash) values ($1, $2, sha256('x'))`, [WA, A]))).rejects.toThrow(/permission denied/)
    await expect(as(A, () => db.query(`update public.wallet_invitations set revoked_at = now() where id = $1`, [inv.id]))).rejects.toThrow(/permission denied/)
    await expect(as(A, () => db.query(`delete from public.wallet_invitations where id = $1`, [inv.id]))).rejects.toThrow(/permission denied/)
    await expect(as(A, () => db.query(`select * from public.membership_rate_events`))).rejects.toThrow(/permission denied/)
    await expect(as(A, () => db.query(`delete from public.membership_rate_events`))).rejects.toThrow(/permission denied/)
  })
  it('the token hash column is unreadable, even for the owner', async () => {
    await expect(as(A, () => db.query(`select token_hash from public.wallet_invitations`))).rejects.toThrow(/permission denied/)
    await expect(as(A, () => db.query(`select * from public.wallet_invitations`))).rejects.toThrow(/permission denied/)
    await expect(as(A, () => db.query(`select accepted_by from public.wallet_invitations`))).rejects.toThrow(/permission denied/)
  })
  it('only the owner of the wallet sees its invitations', async () => {
    const q = 'select id, wallet_id from public.wallet_invitations'
    expect((await as(A, () => db.query(q))).rows.length).toBeGreaterThan(0)
    expect((await as(B, () => db.query(q))).rows).toHaveLength(0) // member
    expect((await as(C, () => db.query(q))).rows).toHaveLength(0) // another wallet's owner
    await expect(as(null, () => db.query(q))).rejects.toThrow(/permission denied/)
  })
  it('clients cannot insert members, change roles or delete memberships directly', async () => {
    await expect(as(D, () => db.query(`insert into public.wallet_members values ($1, $2, 'member')`, [WA, D]))).rejects.toThrow(/permission denied/)
    await expect(as(B, () => db.query(`update public.wallet_members set role = 'owner' where wallet_id = $1 and user_id = $2`, [WA, B]))).rejects.toThrow(/permission denied/)
    await expect(as(B, () => db.query(`delete from public.wallet_members where wallet_id = $1 and user_id = $2`, [WA, B]))).rejects.toThrow(/permission denied/)
    await expect(as(A, () => db.query(`delete from public.wallet_members where wallet_id = $1 and user_id = $2`, [WA, B]))).rejects.toThrow(/permission denied/)
  })
  it('the rate helper is not callable by clients', async () => {
    await expect(rpc(A, `public.membership_rate_check('x', 1, interval '1 hour')`)).rejects.toThrow(/permission denied/)
  })
})

describe('accepting invitations', () => {
  it('preview shows the wallet name without consuming; a valid signed-in recipient joins as a member', async () => {
    await reset()
    const { token } = await invite(A, WA)
    expect(await preview(D, token)).toEqual({ ok: true, wallet_name: 'Household', already_member: false })
    expect(await isMember(WA, D)).toBe(false)
    expect(await accept(D, token)).toEqual({ ok: true, wallet_id: WA, joined: true })
    expect((await members(WA)).find((m) => m.user_id === D)?.role).toBe('member')
  })
  it('a signed-out caller cannot preview or accept', async () => {
    const { token } = await invite(A, WA)
    await expect(accept(null, token)).rejects.toThrow(/permission denied/)
    await expect(preview(null, token)).rejects.toThrow(/permission denied/)
  })
  it('a used invitation cannot be replayed, by anyone', async () => {
    const { token } = await invite(A, WA)
    expect((await accept(E, token)).ok).toBe(true)
    expect(await accept(C, token)).toEqual({ ok: false })
    expect(await preview(C, token)).toEqual({ ok: false })
    expect(await isMember(WA, C)).toBe(false)
    await db.query(`delete from public.wallet_members where wallet_id = $1 and user_id = $2`, [WA, E])
    expect(await accept(E, token)).toEqual({ ok: false }) // even after leaving, the used link stays dead
    expect(await isMember(WA, E)).toBe(false)
  })
  it('an expired invitation is rejected', async () => {
    const { id, token } = await invite(A, WA)
    await db.query(`update public.wallet_invitations set created_at = now() - interval '8 days', expires_at = now() - interval '1 day' where id = $1`, [id])
    expect(await accept(C, token)).toEqual({ ok: false })
    expect(await preview(C, token)).toEqual({ ok: false })
    expect(await isMember(WA, C)).toBe(false)
  })
  it('a revoked invitation is rejected', async () => {
    const { id, token } = await invite(A, WA)
    await rpc(A, 'public.revoke_wallet_invitation($1)', [id])
    expect(await accept(C, token)).toEqual({ ok: false })
    expect(await isMember(WA, C)).toBe(false)
  })
  it('unknown and malformed tokens are rejected with the same generic result', async () => {
    expect(await accept(C, 'a'.repeat(64))).toEqual({ ok: false })
    expect(await accept(C, 'not-a-token')).toEqual({ ok: false })
    expect(await accept(C, '')).toEqual({ ok: false })
    expect(await preview(C, "' or 1=1 --")).toEqual({ ok: false })
  })
  it('an existing member accepting is a no-op that does not consume the invitation', async () => {
    const { id, token } = await invite(A, WA)
    expect(await accept(B, token)).toEqual({ ok: true, wallet_id: WA, joined: false })
    const row = await db.query<{ accepted_at: string | null }>('select accepted_at from public.wallet_invitations where id = $1', [id])
    expect(row.rows[0]!.accepted_at).toBeNull()
    expect(await accept(C, token)).toMatchObject({ ok: true, joined: true }) // still usable by someone else
    await db.query(`delete from public.wallet_members where wallet_id = $1 and user_id = $2`, [WA, C])
  })
  it('the owner accepting their own link does not change ownership', async () => {
    const { token } = await invite(A, WA)
    expect(await accept(A, token)).toMatchObject({ ok: true, joined: false })
    expect((await members(WA)).filter((m) => m.role === 'owner')).toEqual([{ user_id: A, role: 'owner' }])
  })
  // Sequential replay only: PGlite is one session, so true concurrency (the FOR UPDATE row lock) is not exercised here.
  it('sequential replay: the first accept joins, every later accept (same or other user) is rejected, the invitation is consumed once', async () => {
    await db.query(`delete from public.wallet_members where wallet_id = $1 and user_id in ($2, $3, $4)`, [WA, C, D, E]) // clean slate
    const { id, token } = await invite(A, WA)
    expect(await accept(C, token)).toEqual({ ok: true, wallet_id: WA, joined: true })
    expect(await accept(E, token)).toEqual({ ok: false })
    expect(await accept(D, token)).toEqual({ ok: false })
    expect((await members(WA)).filter((m) => [C, D, E].includes(m.user_id)).map((m) => m.user_id)).toEqual([C])
    const row = await db.query<{ accepted_by: string }>('select accepted_by from public.wallet_invitations where id = $1 and accepted_at is not null', [id])
    expect(row.rows).toEqual([{ accepted_by: C }])
    await db.query(`delete from public.wallet_members where wallet_id = $1 and user_id = $2`, [WA, C])
  })
  it('an invitation dies with its wallet', async () => {
    const w = await createWallet(C, 'Temp')
    const { token } = await invite(C, w)
    await db.query('delete from public.wallets where id = $1', [w])
    expect(await accept(E, token)).toEqual({ ok: false })
  })
})

describe('revoking invitations', () => {
  it('owner can revoke a pending invitation; revoking twice or an accepted one fails', async () => {
    const x = await invite(A, WA)
    await rpc(A, 'public.revoke_wallet_invitation($1)', [x.id])
    await expect(rpc(A, 'public.revoke_wallet_invitation($1)', [x.id])).rejects.toThrow(/invitation not found/)
    const y = await invite(A, WA)
    await accept(E, y.token)
    await expect(rpc(A, 'public.revoke_wallet_invitation($1)', [y.id])).rejects.toThrow(/invitation not found/)
    await db.query(`delete from public.wallet_members where wallet_id = $1 and user_id = $2`, [WA, E])
  })
  it('a member cannot revoke', async () => {
    const x = await invite(A, WA)
    await expect(rpc(B, 'public.revoke_wallet_invitation($1)', [x.id])).rejects.toThrow(/invitation not found/)
    expect(await accept(D, x.token)).toMatchObject({ ok: true }) // still valid
    await db.query(`delete from public.wallet_members where wallet_id = $1 and user_id = $2`, [WA, D])
  })
  it("another wallet's owner cannot revoke or list this wallet's invitations (cross-wallet)", async () => {
    const x = await invite(A, WA)
    await expect(rpc(C, 'public.revoke_wallet_invitation($1)', [x.id])).rejects.toThrow(/invitation not found/)
    const seen = await as(C, () => db.query('select id from public.wallet_invitations where wallet_id = $1', [WA]))
    expect(seen.rows).toHaveLength(0)
  })
  it('anon cannot revoke', async () => {
    const x = await invite(A, WA)
    await expect(rpc(null, 'public.revoke_wallet_invitation($1)', [x.id])).rejects.toThrow(/permission denied/)
  })
})

describe('removing members and leaving', () => {
  it('owner can remove a member, who then loses access', async () => {
    expect(await isMember(WA, B)).toBe(true)
    await rpc(A, 'public.remove_wallet_member($1, $2)', [WA, B])
    expect(await isMember(WA, B)).toBe(false)
    expect((await as(B, () => db.query('select 1 from public.wallets where id = $1', [WA]))).rows).toHaveLength(0)
    await db.query(`insert into public.wallet_members values ($1, $2, 'member')`, [WA, B])
  })
  it('a member cannot remove another member or the owner', async () => {
    await db.query(`insert into public.wallet_members values ($1, $2, 'member')`, [WA, D])
    await expect(rpc(B, 'public.remove_wallet_member($1, $2)', [WA, D])).rejects.toThrow(/not allowed/)
    await expect(rpc(B, 'public.remove_wallet_member($1, $2)', [WA, A])).rejects.toThrow(/not allowed/)
    expect(await isMember(WA, D)).toBe(true)
    expect(await isMember(WA, A)).toBe(true)
    await db.query(`delete from public.wallet_members where wallet_id = $1 and user_id = $2`, [WA, D])
  })
  it('a non-member cannot administer this wallet (cross-wallet)', async () => {
    await expect(rpc(C, 'public.remove_wallet_member($1, $2)', [WA, B])).rejects.toThrow(/not allowed/)
    await expect(rpc(C, 'public.leave_wallet($1)', [WA])).rejects.toThrow(/not a member/)
    expect(await isMember(WA, B)).toBe(true)
  })
  it('the owner cannot remove themselves, and removing an unknown member fails', async () => {
    await expect(rpc(A, 'public.remove_wallet_member($1, $2)', [WA, A])).rejects.toThrow(/owner cannot be removed/)
    await expect(rpc(A, 'public.remove_wallet_member($1, $2)', [WA, E])).rejects.toThrow(/member not found/)
  })
  it('a member can leave; the owner cannot', async () => {
    await expect(rpc(A, 'public.leave_wallet($1)', [WA])).rejects.toThrow(/owner cannot leave/)
    expect(await isMember(WA, A)).toBe(true)
    await rpc(B, 'public.leave_wallet($1)', [WA])
    expect(await isMember(WA, B)).toBe(false)
    await db.query(`insert into public.wallet_members values ($1, $2, 'member')`, [WA, B])
  })
  it('anon cannot remove or leave', async () => {
    await expect(rpc(null, 'public.remove_wallet_member($1, $2)', [WA, B])).rejects.toThrow(/permission denied/)
    await expect(rpc(null, 'public.leave_wallet($1)', [WA])).rejects.toThrow(/permission denied/)
  })
  it('ownership is unchanged by any of this: exactly one owner, still A', async () => {
    expect((await members(WA)).filter((m) => m.role === 'owner')).toEqual([{ user_id: A, role: 'owner' }])
    expect((await members(WC)).filter((m) => m.role === 'owner')).toEqual([{ user_id: C, role: 'owner' }])
  })
  it("history survives: a removed member's transactions keep created_by", async () => {
    const acct = (await db.query<{ id: string }>(`insert into public.accounts (id, wallet_id, name, type) values (gen_random_uuid(), $1, 'Cash', 'cash') returning id`, [WA])).rows[0]!.id
    const cat = (await db.query<{ id: string }>('select id from public.categories where wallet_id = $1 limit 1', [WA])).rows[0]!.id
    await as(B, () => db.query(`insert into public.transactions (id, account_id, category_id, type, amount_minor, date) values (gen_random_uuid(), $1, $2, 'expense', 100, '2026-10-05')`, [acct, cat]))
    await rpc(A, 'public.remove_wallet_member($1, $2)', [WA, B])
    const t = await db.query<{ created_by: string; paid_by_user_id: string }>('select created_by, paid_by_user_id from public.transactions where wallet_id = $1', [WA])
    expect(t.rows[0]).toEqual({ created_by: B, paid_by_user_id: B })
    await db.query(`insert into public.wallet_members values ($1, $2, 'member')`, [WA, B])
  })
})

describe('rate limiting', () => {
  it('invitation creation: 21st in an hour is rejected; limits are per user', async () => {
    await reset()
    for (let i = 0; i < 20; i++) await invite(A, WA)
    await expect(invite(A, WA)).rejects.toThrow(/rate limit/)
    await expect(invite(C, WC)).resolves.toBeDefined() // another user is unaffected
  })
  it('rate-limited calls create nothing', async () => {
    const before = (await db.query<{ n: number }>('select count(*)::int as n from public.wallet_invitations')).rows[0]!.n
    await expect(invite(A, WA)).rejects.toThrow(/rate limit/)
    expect((await db.query<{ n: number }>('select count(*)::int as n from public.wallet_invitations')).rows[0]!.n).toBe(before)
  })
  it('the window slides: old attempts stop counting', async () => {
    await db.query(`update public.membership_rate_events set at = now() - interval '2 hours' where action = 'invite_create'`)
    await expect(invite(A, WA)).resolves.toBeDefined()
  })
  it('failed token guesses count: the 21st attempt in 15 minutes is rejected, valid or not', async () => {
    await reset()
    for (let i = 0; i < 20; i++) expect(await accept(D, 'b'.repeat(64))).toEqual({ ok: false })
    await expect(accept(D, 'b'.repeat(64))).rejects.toThrow(/rate limit/)
    const { token } = await invite(A, WA)
    await expect(accept(D, token)).rejects.toThrow(/rate limit/)
    await expect(preview(D, token)).rejects.toThrow(/rate limit/)
    expect(await isMember(WA, D)).toBe(false)
    expect(await accept(E, token)).toMatchObject({ ok: true }) // a different user is unaffected
    await db.query(`delete from public.wallet_members where wallet_id = $1 and user_id = $2`, [WA, E])
  })
})
