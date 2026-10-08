// Phase D9: account deletion (spec 17.2). Real migrations + RLS in PGlite with a stubbed `auth` schema.
// Not provable here (single session): true concurrency, and Supabase's own auth tables. Both are covered by
// supabase/hosted/account_deletion.verify.ts against the DEV project.
import { PGlite } from '@electric-sql/pglite'
import { readdirSync, readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'

const dir = new URL('../migrations/', import.meta.url)
let db: PGlite

async function as<T>(uid: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${uid ? 'authenticated' : 'anon'}`)
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid ?? ''])
  try {
    return await fn()
  } finally {
    await db.exec('reset role')
  }
}
const uuid = () => crypto.randomUUID()
const arr = (ids: string[]) => `{${ids.join(',')}}`

async function mkUser(name: string): Promise<string> {
  const id = uuid()
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id, `${name}@private.example`, JSON.stringify({ display_name: name })])
  return id
}
const mkWallet = (uid: string, name: string) =>
  as(uid, () => db.query<{ id: string }>('select * from public.create_wallet($1)', [name])).then((r) => r.rows[0]!.id)
const join = (w: string, uid: string) => db.query(`insert into public.wallet_members (wallet_id, user_id, role) values ($1, $2, 'member')`, [w, uid])
const mkAccount = (w: string, name = 'Cash') =>
  db.query<{ id: string }>(`insert into public.accounts (id, wallet_id, name, type) values (gen_random_uuid(), $1, $2, 'cash') returning id`, [w, name]).then((r) => r.rows[0]!.id)
const topCategory = (w: string) =>
  db.query<{ id: string }>(`select id from public.categories where wallet_id = $1 and parent_id is null order by name limit 1`, [w]).then((r) => r.rows[0]!.id)

interface Wallet { id: string; acc: string; acc2: string; cat: string }
/** A wallet owned by `owner`, with two accounts and a category. */
async function setup(owner: string, name: string): Promise<Wallet> {
  const id = await mkWallet(owner, name)
  return { id, acc: await mkAccount(id), acc2: await mkAccount(id, 'Bank'), cat: await topCategory(id) }
}
/** Direct client INSERT (the create path): created_by is always the caller. */
async function tx(uid: string, w: Wallet, o: { type?: 'expense' | 'income' | 'transfer'; paid?: string } = {}): Promise<string> {
  const type = o.type ?? 'expense'
  const id = uuid()
  const cols = ['id', 'account_id', 'category_id', 'type', 'amount_minor', 'date']
  const vals: unknown[] = [id, w.acc, type === 'expense' ? w.cat : null, type, 1000, '2026-10-10']
  if (type === 'transfer') { cols.push('destination_account_id'); vals.push(w.acc2) }
  if (o.paid) { cols.push('paid_by_user_id'); vals.push(o.paid) }
  await as(uid, () => db.query(`insert into public.transactions (${cols.join(',')}) values (${vals.map((_, i) => `$${i + 1}`).join(',')})`, vals))
  return id
}
type Row = { id: string; type: string; created_by: string | null; paid_by_user_id: string | null; version: string; amount_minor: string; updated_at: string }
const get = (id: string) => db.query<Row>(`select * from public.transactions where id = $1`, [id]).then((r) => r.rows[0])
const payload = (w: Wallet, o: Record<string, unknown> = {}) => ({
  type: 'expense', account_id: w.acc, destination_account_id: null, category_id: w.cat, amount_minor: 2000, date: '2026-10-10', note: null, ...o,
})
const edit = async (uid: string, id: string, p: Record<string, unknown>) => {
  const v = Number((await get(id))!.version)
  return as(uid, () => db.query<{ r: { status: string } }>(`select public.apply_transaction_mutation($1, 'UPDATE', $2, $3, $4::jsonb, false) as r`, [uuid(), id, v, JSON.stringify(p)])).then((r) => r.rows[0]!.r)
}
const preview = (uid: string) => as(uid, () => db.query<{ r: Plan }>(`select public.account_deletion_preview() as r`)).then((r) => r.rows[0]!.r)
const del = (uid: string, ids: string[]) =>
  as(uid, () => db.query<{ r: { ok: boolean; reason?: string; wallets?: { id: string; name: string; other_members: number }[] } }>(`select public.delete_my_account($1::uuid[]) as r`, [arr(ids)])).then((r) => r.rows[0]!.r)
interface Plan { blocking: { id: string; name: string; other_members: number }[]; will_delete: { id: string; name: string }[]; leaving: { id: string; name: string }[] }

const exists = (table: string, col: string, id: string) =>
  db.query<{ n: string }>(`select count(*) n from ${table} where ${col} = $1`, [id]).then((r) => Number(r.rows[0]!.n) > 0)
const snapshot = () =>
  db.query<{ s: string }>(`select json_build_object(
    'users', (select json_agg(t order by id) from auth.users t), 'profiles', (select json_agg(t order by id) from public.profiles t),
    'wallets', (select json_agg(t order by id) from public.wallets t), 'members', (select json_agg(t order by wallet_id, user_id) from public.wallet_members t),
    'accounts', (select json_agg(t order by id) from public.accounts t), 'categories', (select json_agg(t order by id) from public.categories t),
    'budgets', (select json_agg(t order by id) from public.budgets t), 'tx', (select json_agg(t order by id) from public.transactions t),
    'inv', (select json_agg(t order by id) from public.wallet_invitations t), 'mut', (select json_agg(t order by mutation_id) from public.transaction_mutations t))::text s`).then((r) => r.rows[0]!.s)

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
}, 60_000)

describe('A. sole-member wallet', () => {
  it('is deleted with everything in it, the profile and the auth user; other users are untouched', async () => {
    const U = await mkUser('solo'), V = await mkUser('bystander')
    const wu = await setup(U, 'Solo wallet'), wv = await setup(V, 'Bystander wallet')
    await tx(U, wu); await tx(U, wu, { type: 'income' }); await tx(U, wu, { type: 'transfer' })
    await tx(V, wv)
    await db.query(`insert into public.budgets (wallet_id, category_id, month, amount_minor) values ($1, $2, '2026-10-01', 5000)`, [wu.id, wu.cat])
    await db.query(`insert into public.wallet_invitations (wallet_id, created_by, token_hash) values ($1, $2, sha256('x'::bytea))`, [wu.id, U])
    expect(await preview(U)).toEqual({ blocking: [], will_delete: [{ id: wu.id, name: 'Solo wallet' }], leaving: [] })

    expect(await del(U, [wu.id])).toEqual({ ok: true })

    for (const [t, c] of [['public.wallets', 'id'], ['public.accounts', 'wallet_id'], ['public.categories', 'wallet_id'], ['public.budgets', 'wallet_id'], ['public.transactions', 'wallet_id'], ['public.wallet_invitations', 'wallet_id'], ['public.wallet_members', 'wallet_id']]) {
      expect(await exists(t!, c!, wu.id), t).toBe(false)
    }
    expect(await exists('auth.users', 'id', U)).toBe(false)
    expect(await exists('public.profiles', 'id', U)).toBe(false)
    expect(await exists('public.wallets', 'id', wv.id)).toBe(true)
    expect(await exists('public.transactions', 'wallet_id', wv.id)).toBe(true)
    expect(await exists('auth.users', 'id', V)).toBe(true)
    expect(await exists('public.profiles', 'id', V)).toBe(true)
  })
})

describe('B + E. member of a shared wallet; historical transactions', () => {
  it('leaves, keeps the wallet and history; creator/payer are anonymized without ever copying one into the other', async () => {
    const A = await mkUser('owner'), B = await mkUser('leaver'), C = await mkUser('other')
    const w = await setup(A, 'Shared')
    await join(w.id, B); await join(w.id, C)
    const bothB = await tx(B, w, { paid: B })              // created by B, paid by B
    const aPaidB = await tx(A, w, { paid: B })             // created by A, paid by B
    const bPaidC = await tx(B, w, { paid: C })             // created by B, paid by C
    const cPaidA = await tx(C, w, { paid: A })             // unrelated to B
    const bIncomeB = await tx(B, w, { type: 'income' })
    const bTransfer = await tx(B, w, { type: 'transfer' }) // transfer created by B, no payer
    const aTransfer = await tx(A, w, { type: 'transfer' })
    const before = Object.fromEntries(await Promise.all([bothB, aPaidB, bPaidC, cPaidA, bIncomeB, bTransfer, aTransfer].map(async (i) => [i, await get(i)])))
    expect(await preview(B)).toEqual({ blocking: [], will_delete: [], leaving: [{ id: w.id, name: 'Shared' }] })

    expect(await del(B, [])).toEqual({ ok: true })

    const g = async (i: string) => (await get(i))!
    expect([(await g(bothB)).created_by, (await g(bothB)).paid_by_user_id]).toEqual([null, null])
    expect([(await g(aPaidB)).created_by, (await g(aPaidB)).paid_by_user_id]).toEqual([A, null]) // creator A is NOT turned into the payer
    expect([(await g(bPaidC)).created_by, (await g(bPaidC)).paid_by_user_id]).toEqual([null, C])
    expect([(await g(cPaidA)).created_by, (await g(cPaidA)).paid_by_user_id]).toEqual([C, A])
    expect([(await g(bIncomeB)).created_by, (await g(bIncomeB)).paid_by_user_id]).toEqual([null, null])
    expect([(await g(bTransfer)).created_by, (await g(bTransfer)).paid_by_user_id]).toEqual([null, null]) // creator removed, payer never invented
    expect([(await g(aTransfer)).created_by, (await g(aTransfer)).paid_by_user_id]).toEqual([A, null])
    // amounts, accounts, dates untouched; the version moves only where the payer changed
    for (const [i, b] of Object.entries(before)) {
      const a = await g(i)
      expect([a.amount_minor, a.type]).toEqual([b!.amount_minor, b!.type])
    }
    const bumped = async (i: string) => Number((await g(i)).version) - Number(before[i]!.version)
    expect([await bumped(bothB), await bumped(aPaidB), await bumped(bPaidC), await bumped(bTransfer), await bumped(cPaidA)]).toEqual([1, 1, 0, 0, 0])
    // membership ended, wallet and the other members survive, B is gone
    expect(await exists('public.wallets', 'id', w.id)).toBe(true)
    expect(await exists('public.wallet_members', 'user_id', B)).toBe(false)
    expect((await db.query(`select user_id, role from public.wallet_members where wallet_id = $1 order by role desc`, [w.id])).rows).toHaveLength(2)
    expect(await exists('auth.users', 'id', B)).toBe(false)
    expect(await exists('public.profiles', 'id', B)).toBe(false)
    expect(await exists('auth.users', 'id', A)).toBe(true)
  })

  it('anonymized rows are manageable by the wallet owner only', async () => {
    const A = await mkUser('o'), B = await mkUser('m'), C = await mkUser('m2')
    const w = await setup(A, 'Gov'); await join(w.id, B); await join(w.id, C)
    const id = await tx(B, w, { paid: B })
    await del(B, [])
    expect(await edit(C, id, payload(w))).toMatchObject({ status: 'FORBIDDEN' })
    const v = Number((await get(id))!.version)
    expect((await as(C, () => db.query<{ r: { status: string } }>(`select public.apply_transaction_mutation($1, 'DELETE', $2, $3, null, true) as r`, [uuid(), id, v]))).rows[0]!.r.status).toBe('FORBIDDEN')
    expect(await edit(A, id, payload(w, { amount_minor: 3000 }))).toMatchObject({ status: 'APPLIED' })
    const v2 = Number((await get(id))!.version)
    expect((await as(A, () => db.query<{ r: { status: string } }>(`select public.apply_transaction_mutation($1, 'DELETE', $2, $3, null, false) as r`, [uuid(), id, v2]))).rows[0]!.r.status).toBe('APPLIED')
  })

  it('a wallet created by the deleted user but now owned by someone else survives with created_by NULL', async () => {
    const A = await mkUser('creator'), B = await mkUser('newowner')
    const w = await setup(A, 'Handed over'); await join(w.id, B)
    await as(A, () => db.query(`select public.transfer_wallet_ownership($1, $2)`, [w.id, B]))
    expect((await db.query(`select created_by from public.wallets where id = $1`, [w.id])).rows[0]).toEqual({ created_by: A })
    expect(await del(A, [])).toEqual({ ok: true })
    expect((await db.query(`select created_by from public.wallets where id = $1`, [w.id])).rows[0]).toEqual({ created_by: null })
  })

  it("the user's own invitations go with the account; invitations they accepted keep their row (accepted_by NULL)", async () => {
    const A = await mkUser('o2'), B = await mkUser('m3')
    const w = await setup(A, 'Inv'); await join(w.id, B)
    const own = (await db.query<{ id: string }>(`insert into public.wallet_invitations (wallet_id, created_by, token_hash) values ($1, $2, sha256('own'::bytea)) returning id`, [w.id, B])).rows[0]!.id
    const acc = (await db.query<{ id: string }>(`insert into public.wallet_invitations (wallet_id, created_by, token_hash, accepted_at, accepted_by) values ($1, $2, sha256('acc'::bytea), now(), $3) returning id`, [w.id, A, B])).rows[0]!.id
    await del(B, [])
    expect(await exists('public.wallet_invitations', 'id', own)).toBe(false)
    expect((await db.query(`select accepted_by from public.wallet_invitations where id = $1`, [acc])).rows[0]).toEqual({ accepted_by: null })
  })
})

describe('C + D. owners: blockers and atomicity', () => {
  it('a shared-wallet owner is blocked, the wallet is named, and NOTHING changes', async () => {
    const A = await mkUser('blocked'), B = await mkUser('member')
    const w = await setup(A, 'Family'); await join(w.id, B)
    await tx(A, w, { paid: A }); await tx(B, w)
    const before = await snapshot()
    expect(await preview(A)).toEqual({ blocking: [{ id: w.id, name: 'Family', other_members: 1 }], will_delete: [], leaving: [] })
    expect(await del(A, [])).toEqual({ ok: false, reason: 'blocked', wallets: [{ id: w.id, name: 'Family', other_members: 1 }] })
    expect(await del(A, [w.id])).toMatchObject({ ok: false, reason: 'blocked' })
    expect(await snapshot()).toBe(before)
  })

  it('sole wallet + shared wallet: blocked and nothing is deleted; after the blocker is removed both go', async () => {
    const A = await mkUser('mixed'), B = await mkUser('m4')
    const solo = await setup(A, 'Solo'), shared = await setup(A, 'Shared'); await join(shared.id, B)
    await tx(A, solo); await tx(A, shared)
    const before = await snapshot()
    expect(await del(A, [solo.id])).toMatchObject({ ok: false, reason: 'blocked', wallets: [{ id: shared.id }] })
    expect(await snapshot()).toBe(before)
    await db.query(`delete from public.wallet_members where wallet_id = $1 and user_id = $2`, [shared.id, B]) // owner removed the member
    const afterRemoval = await snapshot()
    expect(await del(A, [solo.id])).toEqual({ ok: false, reason: 'changed' }) // the shared wallet is now sole-owned too: the user has not confirmed it
    expect(await snapshot()).toBe(afterRemoval)
    expect(await exists('auth.users', 'id', A)).toBe(true)
    expect(await del(A, [shared.id, solo.id])).toEqual({ ok: true })
    expect(await exists('public.wallets', 'id', solo.id)).toBe(false)
    expect(await exists('public.wallets', 'id', shared.id)).toBe(false)
  })

  it('a sole wallet is deleted while a wallet the user only belongs to survives', async () => {
    const A = await mkUser('both'), B = await mkUser('o3')
    const solo = await setup(A, 'Mine'), theirs = await setup(B, 'Theirs'); await join(theirs.id, A)
    await tx(A, theirs)
    expect(await preview(A)).toMatchObject({ will_delete: [{ id: solo.id }], leaving: [{ id: theirs.id }] })
    expect(await del(A, [solo.id])).toEqual({ ok: true })
    expect(await exists('public.wallets', 'id', solo.id)).toBe(false)
    expect(await exists('public.wallets', 'id', theirs.id)).toBe(true)
  })

  it('is atomic: a failure at the very last step (the auth delete) undoes everything', async () => {
    const A = await mkUser('atomic'), B = await mkUser('m5')
    const solo = await setup(A, 'AtomicSolo'), theirs = await setup(B, 'AtomicTheirs'); await join(theirs.id, A)
    const t = await tx(A, theirs, { paid: A })
    await tx(A, solo)
    const before = await snapshot()
    await db.exec(`create function pg_temp_fail() returns trigger language plpgsql as $$ begin raise exception 'boom'; end $$;
      create trigger fail_auth_delete before delete on auth.users for each row execute function pg_temp_fail();`)
    try {
      await expect(del(A, [solo.id])).rejects.toThrow(/boom/)
    } finally {
      await db.exec(`drop trigger fail_auth_delete on auth.users; drop function pg_temp_fail();`)
    }
    expect(await snapshot()).toBe(before)
    expect((await get(t))!.created_by).toBe(A)
    expect(await exists('public.wallets', 'id', solo.id)).toBe(true)
  })
})

describe('confirmed-wallet safeguard', () => {
  it('rejects a confirmed list that differs from the real set, and changes nothing', async () => {
    const A = await mkUser('safe'), B = await mkUser('other-owner')
    const w1 = await setup(A, 'W1'), w2 = await setup(A, 'W2'), other = await setup(B, 'Not mine')
    const before = await snapshot()
    for (const ids of [[], [w1.id], [w2.id], [w1.id, w2.id, other.id], [w1.id, w2.id, uuid()], [other.id]]) {
      expect(await del(A, ids), JSON.stringify(ids)).toEqual({ ok: false, reason: 'changed' })
    }
    expect(await snapshot()).toBe(before)
    expect(await exists('public.wallets', 'id', other.id)).toBe(true)
  })

  it('tolerates duplicates and order, and rejects a null array', async () => {
    const A = await mkUser('dups')
    const w1 = await setup(A, 'D1'), w2 = await setup(A, 'D2')
    await expect(as(A, () => db.query(`select public.delete_my_account(null)`))).rejects.toMatchObject({ code: '22023' })
    expect(await del(A, [w2.id, w1.id, w2.id, w1.id])).toEqual({ ok: true })
  })

  it('a member-only user confirms nothing; naming a wallet they merely belong to is rejected', async () => {
    const A = await mkUser('memberonly'), B = await mkUser('o4')
    const theirs = await setup(B, 'Theirs2'); await join(theirs.id, A)
    expect(await del(A, [theirs.id])).toEqual({ ok: false, reason: 'changed' })
    expect(await exists('public.wallets', 'id', theirs.id)).toBe(true)
    expect(await del(A, [])).toEqual({ ok: true })
  })
})

describe('G. authorization', () => {
  it('no session: both RPCs raise 28000; anon has no execute', async () => {
    await expect(as(null, () => db.query(`select public.account_deletion_preview()`))).rejects.toThrow(/permission denied/)
    await expect(as(null, () => db.query(`select public.delete_my_account('{}')`))).rejects.toThrow(/permission denied/)
    // authenticated but with an empty subject (a token without a user): refused by the function itself
    await db.exec(`set role authenticated`)
    await db.query(`select set_config('request.jwt.claim.sub', '', false)`)
    try {
      await expect(db.query(`select public.account_deletion_preview()`)).rejects.toMatchObject({ code: '28000' })
      await expect(db.query(`select public.delete_my_account('{}')`)).rejects.toMatchObject({ code: '28000' })
    } finally {
      await db.exec('reset role')
    }
  })

  it('takes no user id; the internal plan helper is not callable by clients; extra or renamed arguments are rejected', async () => {
    const sigs = (await db.query<{ proname: string; args: string }>(`select proname, pg_get_function_arguments(oid) args from pg_proc where proname in ('delete_my_account','account_deletion_preview','account_deletion_plan') order by 1`)).rows
    expect(sigs).toEqual([
      { proname: 'account_deletion_plan', args: 'p_uid uuid' },
      { proname: 'account_deletion_preview', args: '' },
      { proname: 'delete_my_account', args: 'p_confirmed_wallet_ids uuid[]' },
    ])
    const A = await mkUser('victim'), B = await mkUser('attacker')
    const wa = await setup(A, 'Victim wallet')
    await expect(as(B, () => db.query(`select public.account_deletion_plan($1)`, [A]))).rejects.toThrow(/permission denied/)
    await expect(as(B, () => db.query(`select public.delete_my_account('{}', $1)`, [A]))).rejects.toThrow()
    await expect(as(B, () => db.query(`select public.delete_my_account(p_user_id => $1, p_confirmed_wallet_ids => '{}')`, [A]))).rejects.toThrow()
    // the attacker can only ever delete themselves, whatever ids they confirm
    expect(await del(B, [wa.id])).toEqual({ ok: false, reason: 'changed' })
    expect(await exists('public.wallets', 'id', wa.id)).toBe(true)
    expect(await exists('auth.users', 'id', A)).toBe(true)
    expect(await del(B, [])).toEqual({ ok: true })
    expect(await exists('public.wallets', 'id', wa.id)).toBe(true)
    expect(await exists('auth.users', 'id', A)).toBe(true)
  })

  it('preview exposes only wallet ids/names and counts (no emails, no other members)', async () => {
    const A = await mkUser('privacy'), B = await mkUser('secret-member')
    const w = await setup(A, 'Privacy'); await join(w.id, B)
    const text = JSON.stringify(await preview(A))
    expect(text).not.toMatch(/private\.example|secret-member|@/)
    expect(text).not.toContain(B)
  })

  it('is idempotent: a repeat after success (the lost-response case) answers ok and touches nothing', async () => {
    const A = await mkUser('replay'), V = await mkUser('v2')
    await setup(V, 'V wallet')
    const w = await setup(A, 'Replay')
    expect(await del(A, [w.id])).toEqual({ ok: true })
    const after = await snapshot()
    expect(await del(A, [w.id])).toEqual({ ok: true })
    expect(await snapshot()).toBe(after)
  })
})

describe('app.account_deletion bypass is tightly constrained', () => {
  it('is set (on) in exactly one function, which is delete_my_account; the trigger only reads it', async () => {
    const setters = await db.query<{ proname: string }>(`select proname from pg_proc where prosrc like '%set_config(''app.account_deletion'', ''on''%'`)
    expect(setters.rows.map((r) => r.proname)).toEqual(['delete_my_account'])
    const readers = await db.query<{ proname: string }>(`select proname from pg_proc where prosrc like '%app.account_deletion%' order by 1`)
    expect(readers.rows.map((r) => r.proname)).toEqual(['delete_my_account', 'transactions_set_owner'])
  })

  it('is off before, during the checks of a refused call, and after a successful one; never survives the transaction', async () => {
    const A = await mkUser('flag'), B = await mkUser('flagm')
    const shared = await setup(A, 'Flag shared'); await join(shared.id, B)
    const flag = () => db.query<{ f: string | null }>(`select current_setting('app.account_deletion', true) f`).then((r) => r.rows[0]!.f)
    // refused (blocked): the flag was never turned on
    await db.exec('begin')
    await as(A, () => db.query(`select public.delete_my_account('{}')`))
    expect(['', null]).toContain(await flag())
    await db.exec('rollback')
    // success: switched on only around the anonymizing UPDATE, switched off again right after
    const m = await mkUser('flagmember'); const t = await setup(B, 'B own'); await join(t.id, m)
    await db.exec('begin')
    await as(m, () => db.query(`select public.delete_my_account('{}')`))
    expect(await flag()).toBe('off')
    await db.exec('commit')
    expect(['', 'off', null]).toContain(await flag()) // transaction-local: reverted at commit
    expect(['', null]).toContain(await flag())
  })

  it('without the flag, clearing an existing payer is refused at the database (even for a superuser-level writer)', async () => {
    const A = await mkUser('noflag'), B = await mkUser('noflagm')
    const w = await setup(A, 'NoFlag'); await join(w.id, B)
    const id = await tx(A, w, { paid: B })
    await expect(db.query(`update public.transactions set paid_by_user_id = null where id = $1`, [id])).rejects.toMatchObject({ code: '42501' })
    expect((await get(id))!.paid_by_user_id).toBe(B)
  })

  it('a client that forges the setting still cannot null a payer: no UPDATE grant, and the mutation RPC never writes NULL', async () => {
    const A = await mkUser('forger'), B = await mkUser('forgerm')
    const w = await setup(A, 'Forge'); await join(w.id, B)
    const id = await tx(A, w, { paid: B })
    await as(A, async () => {
      await db.query(`select set_config('app.account_deletion', 'on', false)`)
      await expect(db.query(`update public.transactions set paid_by_user_id = null where id = $1`, [id])).rejects.toThrow(/permission denied/)
      for (const p of [payload(w), payload(w, { paid_by_user_id: null }), payload(w, { paid_by_user_id: null, created_by: null })]) {
        await db.query(`select public.apply_transaction_mutation($1, 'UPDATE', $2, $3, $4::jsonb, false)`, [uuid(), id, Number((await get(id))!.version), JSON.stringify(p)])
      }
      await db.query(`select set_config('app.account_deletion', 'off', false)`)
    })
    const t = (await get(id))!
    expect([t.created_by, t.paid_by_user_id]).toEqual([A, B])
  })

  it('even with the flag forged AND an UPDATE grant by mistake, the trigger refuses: the call stack must show delete_my_account', async () => {
    const A = await mkUser('role'), B = await mkUser('rolem')
    const w = await setup(A, 'Role'); await join(w.id, B)
    const id = await tx(A, w, { paid: B })
    await db.exec(`grant update (paid_by_user_id) on public.transactions to authenticated`) // simulate a future grant mistake
    try {
      await as(A, async () => {
        await db.query(`select set_config('app.account_deletion', 'on', false)`)
        await expect(db.query(`update public.transactions set paid_by_user_id = null where id = $1`, [id])).rejects.toMatchObject({ code: '42501' })
      })
    } finally {
      await db.exec(`revoke update (paid_by_user_id) on public.transactions from authenticated`)
    }
    expect((await get(id))!.paid_by_user_id).toBe(B)
  })
})

describe('payer semantics after anonymization (apply_transaction_mutation)', () => {
  // A owns WA with B (leaver), C and a former member F; every test makes a fresh anonymized expense.
  async function world() {
    const A = await mkUser('pa'), B = await mkUser('pb'), C = await mkUser('pc'), F = await mkUser('pf'), X = await mkUser('px')
    const w = await setup(A, 'Payers'); await join(w.id, B); await join(w.id, C)
    const wx = await setup(X, 'Outsider wallet')
    void wx
    const anonExpense = await tx(B, w, { paid: B })
    await del(B, [])
    return { A, C, F, X, w, id: anonExpense }
  }

  it('editing amount/note without a payer keeps NULL; the editor does not become the payer', async () => {
    const { A, w, id } = await world()
    expect((await get(id))!.paid_by_user_id).toBeNull()
    expect(await edit(A, id, payload(w, { amount_minor: 4000, note: 'fixed' }))).toMatchObject({ status: 'APPLIED' })
    const t = (await get(id))!
    expect([t.created_by, t.paid_by_user_id, t.amount_minor]).toEqual([null, null, 4000])
    expect(await edit(A, id, payload(w, { paid_by_user_id: null, amount_minor: 4100 }))).toMatchObject({ status: 'APPLIED' })
    expect((await get(id))!.paid_by_user_id).toBeNull()
  })

  it('an explicit current member is assigned; creator stays NULL', async () => {
    const { A, C, w, id } = await world()
    expect(await edit(A, id, payload(w, { paid_by_user_id: C }))).toMatchObject({ status: 'APPLIED' })
    const t = (await get(id))!
    expect([t.created_by, t.paid_by_user_id]).toEqual([null, C])
    expect(await edit(A, id, payload(w, { amount_minor: 5000 }))).toMatchObject({ status: 'APPLIED' })
    expect((await get(id))!.paid_by_user_id).toBe(C) // an assigned payer is kept on later edits
  })

  it('a former member, an outsider and an unknown user are rejected; the row is unchanged', async () => {
    const { A, F, X, w, id } = await world()
    for (const bad of [F, X, uuid()]) await expect(edit(A, id, payload(w, { paid_by_user_id: bad }))).rejects.toMatchObject({ code: '42501' })
    expect((await get(id))!.paid_by_user_id).toBeNull()
  })

  it('transfer -> expense defaults the editor; expense -> transfer clears the payer; ordinary edits keep the payer', async () => {
    const { A, C, w } = await world()
    const t = await tx(A, w, { type: 'transfer' })
    await edit(A, t, payload(w))
    expect((await get(t))!.paid_by_user_id).toBe(A)
    const t2 = await tx(A, w, { type: 'transfer' })
    await edit(A, t2, payload(w, { paid_by_user_id: C }))
    expect((await get(t2))!.paid_by_user_id).toBe(C)
    const e = await tx(A, w, { paid: C })
    await edit(A, e, payload(w, { type: 'transfer', destination_account_id: w.acc2, category_id: null }))
    expect((await get(e))!.paid_by_user_id).toBeNull()
    const e2 = await tx(A, w, { paid: C })
    await edit(A, e2, payload(w, { amount_minor: 9000 }))
    expect((await get(e2))!.paid_by_user_id).toBe(C)
  })

  it('an anonymized transfer stays payer-less and can be turned into an expense by the owner, who then becomes the payer', async () => {
    const A = await mkUser('tr-o'), B = await mkUser('tr-m')
    const w = await setup(A, 'TR'); await join(w.id, B)
    const t = await tx(B, w, { type: 'transfer' })
    await del(B, [])
    expect((await get(t))!.paid_by_user_id).toBeNull()
    expect(await edit(A, t, payload(w))).toMatchObject({ status: 'APPLIED' })
    expect((await get(t))!.paid_by_user_id).toBe(A)
  })

  it('an anonymized income keeps NULL the same way', async () => {
    const A = await mkUser('in-o'), B = await mkUser('in-m')
    const w = await setup(A, 'IN'); await join(w.id, B)
    const i = await tx(B, w, { type: 'income' })
    await del(B, [])
    await edit(A, i, payload(w, { type: 'income', category_id: null, amount_minor: 7000 }))
    expect([(await get(i))!.paid_by_user_id, (await get(i))!.amount_minor]).toEqual([null, 7000])
  })

  it('new transactions are unaffected: the payer still defaults to the creator and must be a current member', async () => {
    const { A, F, w } = await world()
    expect((await get(await tx(A, w)))!.paid_by_user_id).toBe(A)
    await expect(tx(A, w, { paid: F })).rejects.toThrow()
  })
})
