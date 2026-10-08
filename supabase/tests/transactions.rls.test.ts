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

const D = '2026-10-10'
let accA: string // account in WA
let accC: string // account in WC
let food: string // WA expense category
let foodC: string // WC expense category
const acct = (uid: string, wallet: string) =>
  as(uid, () =>
    db.query<{ id: string }>(`insert into public.accounts (id, wallet_id, name, type) values (gen_random_uuid(), $1, 'Cash', 'cash') returning id`, [wallet]),
  ).then((r) => r.rows[0]!.id)
const addTx = (uid: string | null, o: Record<string, unknown> = {}) => {
  const v = { account_id: accA, destination_account_id: null, category_id: food, type: 'expense', amount_minor: 50000, date: D, note: null, ...o }
  return as(uid, () =>
    db.query<{ id: string; created_by: string; paid_by_user_id: string | null; wallet_id: string }>(
      `insert into public.transactions (id, account_id, destination_account_id, category_id, type, amount_minor, date, note)
       values (gen_random_uuid(), $1, $7, $2, $3, $4, $5, $6) returning *`,
      [v.account_id, v.category_id, v.type, v.amount_minor, v.date, v.note, v.destination_account_id],
    ),
  ).then((r) => r.rows[0]!)
}
// Phase 12B: clients mutate only through apply_transaction_mutation. These helpers read the row as the superuser, merge a
// patch into its whitelisted columns and send it with the row's current version; they return the affected-row count (1 or 0).
type Patch = Record<string, unknown>
const mutateRow = async (uid: string, op: 'UPDATE' | 'DELETE', id: string, patch: Patch = {}) => {
  const cur = (await db.query<{ p: Patch; v: string }>(
    `select jsonb_build_object('account_id', account_id, 'destination_account_id', destination_account_id, 'category_id', category_id,
       'type', type, 'amount_minor', amount_minor, 'date', date, 'note', note) p, version v from public.transactions where id = $1`, [id])).rows[0]
  const r = await as(uid, () =>
    db.query<{ r: { status: string } }>(`select public.apply_transaction_mutation(gen_random_uuid(), $1, $2, $3, $4::jsonb) as r`, [
      op, id, cur ? Number(cur.v) : 1, op === 'UPDATE' ? JSON.stringify({ ...cur?.p, ...patch }) : null,
    ]),
  )
  return r.rows[0]!.r.status
}
const upd = (uid: string, id: string, patch: Patch) => mutateRow(uid, 'UPDATE', id, patch).then((s) => (s === 'APPLIED' ? 1 : 0))
const del = (uid: string, id: string) => mutateRow(uid, 'DELETE', id).then((s) => (s === 'APPLIED' ? 1 : 0))
const visible = (uid: string | null) => as(uid, () => db.query(`select id from public.transactions`)).then((r) => r.rows.length)

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
  accA = await acct(A, WA)
  accC = await acct(C, WC)
  const cat = (w: string) =>
    db.query<{ id: string }>(`select id from public.categories where wallet_id = $1 and name = 'Groceries'`, [w]).then((r) => r.rows[0]!.id)
  food = await cat(WA)
  foodC = await cat(WC)
})

describe('transactions: insert', () => {
  it('owner and member can create; identity and wallet come from the server', async () => {
    for (const uid of [A, B]) {
      const t = await addTx(uid)
      expect(t.created_by).toBe(uid)
      expect(t.paid_by_user_id).toBe(uid)
      expect(t.wallet_id).toBe(WA)
    }
  })
  it('client cannot set created_by or wallet_id (paid_by_user_id is client-selectable since D7: see who_paid.rls.test.ts)', async () => {
    for (const col of ['created_by', 'wallet_id']) {
      await expect(
        as(B, () =>
          db.query(
            `insert into public.transactions (id, account_id, category_id, type, amount_minor, date, ${col}) values (gen_random_uuid(), $1, $2, 'expense', 1, $3, $4)`,
            [accA, food, D, col === 'wallet_id' ? WA : A],
          ),
        ),
      ).rejects.toThrow(/permission denied/)
    }
  })
  it('income may have no category; expense requires one', async () => {
    expect((await addTx(A, { type: 'income', category_id: null })).id).toBeTruthy()
    await expect(addTx(A, { type: 'expense', category_id: null })).rejects.toThrow(/check/)
  })
  it('amount must be a positive integer within the safe range', async () => {
    for (const n of [0, -1, '9007199254740992']) await expect(addTx(A, { amount_minor: n })).rejects.toThrow(/check|out of range/)
    expect((await addTx(A, { amount_minor: '9007199254740991' })).id).toBeTruthy()
  })
  it('type, note length and missing date are rejected', async () => {
    await expect(addTx(A, { type: 'transfer' })).rejects.toThrow(/check/)
    await expect(addTx(A, { note: 'x'.repeat(501) })).rejects.toThrow(/check/)
    await expect(addTx(A, { date: null })).rejects.toThrow(/null value/)
  })
  it('outsider and anonymous cannot create', async () => {
    await expect(addTx(C)).rejects.toThrow(/row-level security|payer must be a current member/) // the payer trigger runs before RLS
    await expect(addTx(null)).rejects.toThrow(/permission denied/)
  })
  it('cross-wallet: an account from another wallet is rejected', async () => {
    await expect(addTx(C, { account_id: accA, category_id: foodC })).rejects.toThrow(/row-level security|payer must be a current member/)
    await expect(addTx(A, { account_id: accC, category_id: food })).rejects.toThrow(/row-level security|payer must be a current member/)
  })
  it('cross-wallet: a category from another wallet is rejected, even for a member of both', async () => {
    await expect(addTx(A, { category_id: foodC })).rejects.toThrow(/foreign key/)
    await db.query(`insert into public.wallet_members (wallet_id, user_id, role) values ($1, $2, 'member')`, [WC, A])
    try {
      await expect(addTx(A, { account_id: accA, category_id: foodC })).rejects.toThrow(/foreign key/)
      await expect(addTx(A, { account_id: accC, category_id: food })).rejects.toThrow(/foreign key/)
      expect((await addTx(A, { account_id: accC, category_id: foodC })).wallet_id).toBe(WC)
    } finally {
      await db.query(`delete from public.wallet_members where wallet_id = $1 and user_id = $2`, [WC, A])
    }
  })
  it('unknown account is rejected', async () => {
    await expect(addTx(A, { account_id: '99999999-9999-4999-8999-999999999999' })).rejects.toThrow()
  })
})

describe('transactions: read', () => {
  it('members see wallet transactions; outsiders only their own wallet; anon nothing', async () => {
    await addTx(C, { account_id: accC, category_id: foodC })
    expect(await visible(B)).toBe(await visible(A))
    const c = await as(C, () => db.query<{ wallet_id: string }>(`select wallet_id from public.transactions`))
    expect(c.rows.length).toBeGreaterThan(0)
    expect(c.rows.every((r) => r.wallet_id === WC)).toBe(true)
    await expect(visible(null)).rejects.toThrow(/permission denied/)
  })
})

describe('transactions: update/delete permissions', () => {
  it('owner can edit and delete any transaction in their wallet', async () => {
    const t = await addTx(B)
    expect(await upd(A, t.id, { amount_minor: 123, note: 'owner edit' })).toBe(1)
    expect(await del(A, t.id)).toBe(1)
  })
  it('member can edit and delete their own', async () => {
    const t = await addTx(B)
    expect(await upd(B, t.id, { amount_minor: 999 })).toBe(1)
    expect(await del(B, t.id)).toBe(1)
  })
  it("member cannot edit or delete the owner's transaction", async () => {
    const t = await addTx(A)
    expect(await upd(B, t.id, { amount_minor: 1 })).toBe(0)
    expect(await del(B, t.id)).toBe(0)
    const r = await db.query<{ amount_minor: number }>(`select amount_minor from public.transactions where id = $1`, [t.id])
    expect(Number(r.rows[0]!.amount_minor)).toBe(50000)
  })
  it('outsider cannot edit or delete', async () => {
    const t = await addTx(A)
    expect(await upd(C, t.id, { amount_minor: 1 })).toBe(0)
    expect(await del(C, t.id)).toBe(0)
  })
  it('a member who left the wallet loses access to their own transactions', async () => {
    const t = await addTx(B)
    await db.query(`delete from public.wallet_members where wallet_id = $1 and user_id = $2`, [WA, B])
    try {
      expect(await upd(B, t.id, { amount_minor: 1 })).toBe(0)
      expect(await del(B, t.id)).toBe(0)
    } finally {
      await db.query(`insert into public.wallet_members (wallet_id, user_id, role) values ($1, $2, 'member')`, [WA, B])
    }
  })
  it('clients have no direct UPDATE or DELETE on transactions at all (the RPC is the only path)', async () => {
    const t = await addTx(B)
    for (const col of ['amount_minor = 1', `note = 'x'`, `created_by = '${A}'`, `paid_by_user_id = '${A}'`, `wallet_id = '${WC}'`, 'created_at = now()', 'version = 99'])
      await expect(as(B, () => db.query(`update public.transactions set ${col} where id = $1`, [t.id]))).rejects.toThrow(/permission denied/)
    await expect(as(B, () => db.query(`delete from public.transactions where id = $1`, [t.id]))).rejects.toThrow(/permission denied/)
    await expect(as(A, () => db.query(`delete from public.transactions where id = $1`, [t.id]))).rejects.toThrow(/permission denied/) // owners too
    // upsert (insert ... on conflict do update) needs the UPDATE privilege as well
    await expect(
      as(B, () => db.query(`insert into public.transactions (id, account_id, category_id, type, amount_minor, date) values ($1, $2, $3, 'expense', 1, $4)
        on conflict (id) do update set amount_minor = 1`, [t.id, accA, food, D])),
    ).rejects.toThrow(/permission denied/)
    const g = await db.query<{ u: boolean; d: boolean; s: boolean; i: boolean }>(
      `select has_table_privilege('authenticated', 'public.transactions', 'update') u, has_table_privilege('authenticated', 'public.transactions', 'delete') d,
              has_table_privilege('authenticated', 'public.transactions', 'select') s, has_any_column_privilege('authenticated', 'public.transactions', 'insert') i`)
    expect(g.rows[0]).toEqual({ u: false, d: false, s: true, i: true })
    const cols = await db.query(`select 1 from information_schema.column_privileges where table_name = 'transactions' and grantee in ('authenticated', 'anon', 'PUBLIC') and privilege_type = 'UPDATE'`)
    expect(cols.rows).toHaveLength(0)
    expect(Number((await db.query<{ amount_minor: string }>(`select amount_minor from public.transactions where id = $1`, [t.id])).rows[0]!.amount_minor)).toBe(50000)
  })
  it('spoofed created_by / wallet_id / version in the payload are ignored (paid_by is honoured when a current member, D7); moving to another wallet is rejected', async () => {
    const t = await addTx(B)
    expect(await upd(B, t.id, { created_by: A, paid_by_user_id: A, wallet_id: WC, version: 99, amount_minor: 4242 })).toBe(1)
    const r = (await db.query<{ created_by: string; paid_by_user_id: string; wallet_id: string; amount_minor: string; version: string }>(
      `select created_by, paid_by_user_id, wallet_id, amount_minor, version from public.transactions where id = $1`, [t.id])).rows[0]!
    expect(r).toMatchObject({ created_by: B, paid_by_user_id: A, wallet_id: WA, version: 2 }) // A is a current member, so a valid payer
    expect(Number(r.amount_minor)).toBe(4242)
    await expect(upd(B, t.id, { account_id: accC })).rejects.toThrow(/row-level security|foreign key|cannot move between wallets/)
  })
  it('edits can move to another account or type within the wallet; updated_at moves', async () => {
    const t = await addTx(B)
    const acc2 = await acct(A, WA)
    const q = () => db.query<{ updated_at: string; wallet_id: string }>(`select updated_at, wallet_id from public.transactions where id = $1`, [t.id])
    const before = (await q()).rows[0]!.updated_at
    await db.query(`select pg_sleep(0.01)`)
    expect(await upd(B, t.id, { account_id: acc2, type: 'income', category_id: null })).toBe(1)
    const after = (await q()).rows[0]!
    expect(after.wallet_id).toBe(WA)
    expect(new Date(after.updated_at) > new Date(before)).toBe(true)
    await expect(upd(B, t.id, { type: 'expense' })).rejects.toThrow(/check/)
  })
})

describe('history protects categories and accounts', () => {
  it('a used category (and its parent) cannot be deleted; unused ones can', async () => {
    const t = await addTx(A, { category_id: food })
    await expect(as(A, () => db.query(`delete from public.categories where id = $1`, [food]))).rejects.toThrow(/foreign key/)
    await expect(as(A, () => db.query(`delete from public.categories where name = 'Food' and wallet_id = $1`, [WA]))).rejects.toThrow(/foreign key/)
    const spare = (await db.query<{ id: string }>(`select id from public.categories where wallet_id = $1 and name = 'Hobbies'`, [WA])).rows[0]!.id
    expect((await as(A, () => db.query(`delete from public.categories where id = $1`, [spare]))).affectedRows).toBe(1)
    await del(A, t.id)
  })
  it('account_has_transactions is real: type/opening balance lock, delete blocked until the history is gone', async () => {
    const a = await acct(A, WA)
    const has = () => db.query<{ r: boolean }>(`select public.account_has_transactions($1) as r`, [a]).then((r) => r.rows[0]!.r)
    expect(await has()).toBe(false)
    expect((await as(A, () => db.query(`update public.accounts set type = 'bank' where id = $1`, [a]))).affectedRows).toBe(1)
    const t = await addTx(A, { account_id: a })
    expect(await has()).toBe(true)
    expect((await as(A, () => db.query(`update public.accounts set name = 'Renamed', holder = 'H' where id = $1`, [a]))).affectedRows).toBe(1)
    await expect(as(A, () => db.query(`update public.accounts set type = 'cash' where id = $1`, [a]))).rejects.toThrow(/has transactions/)
    await expect(as(A, () => db.query(`update public.accounts set opening_balance_minor = 5 where id = $1`, [a]))).rejects.toThrow(/has transactions/)
    expect((await as(A, () => db.query(`delete from public.accounts where id = $1`, [a]))).affectedRows).toBe(0)
    await del(A, t.id)
    expect(await has()).toBe(false)
    expect((await as(A, () => db.query(`delete from public.accounts where id = $1`, [a]))).affectedRows).toBe(1)
  })
  it('deleting a whole wallet still works and removes its transactions', async () => {
    const w = await createWallet(C, 'Temp')
    const a = await acct(C, w)
    const c = (await db.query<{ id: string }>(`select id from public.categories where wallet_id = $1 and name = 'Fuel'`, [w])).rows[0]!.id
    await addTx(C, { account_id: a, category_id: c })
    expect((await as(C, () => db.query(`delete from public.wallets where id = $1`, [w]))).affectedRows).toBe(1)
    expect((await db.query(`select 1 from public.transactions where wallet_id = $1`, [w])).rows).toHaveLength(0)
  })
})

describe('transfers', () => {
  let accA2: string // second account in WA
  let accC2: string // second account in WC
  const xfer = (uid: string | null, o: Record<string, unknown> = {}) =>
    addTx(uid, { type: 'transfer', category_id: null, destination_account_id: accA2, ...o })
  const raw = (uid: string, cols: string, vals: unknown[]) =>
    as(uid, () =>
      db.query(
        `insert into public.transactions (id, ${cols}, type, amount_minor, date) values (gen_random_uuid(), ${vals.map((_, i) => `$${i + 1}`).join(',')}, 'transfer', 1, '${D}')`,
        vals,
      ),
    )
  beforeAll(async () => {
    accA2 = await acct(A, WA)
    accC2 = await acct(C, WC)
  })

  it('owner and member can create; wallet and creator come from the server; no payer', async () => {
    for (const uid of [A, B]) {
      const t = await xfer(uid)
      expect(t).toMatchObject({ created_by: uid, paid_by_user_id: null, wallet_id: WA })
    }
  })
  it('members read transfers; outsider and anon cannot', async () => {
    const t = await xfer(A)
    const ids = (uid: string) => as(uid, () => db.query<{ id: string }>(`select id from public.transactions`)).then((r) => r.rows.map((x) => x.id))
    expect(await ids(B)).toContain(t.id)
    expect(await ids(C)).not.toContain(t.id)
    await expect(xfer(null)).rejects.toThrow(/permission denied/)
    await expect(xfer(C)).rejects.toThrow(/row-level security/)
  })
  it('shape is enforced by the database', async () => {
    for (const amount_minor of [0, -5]) await expect(xfer(A, { amount_minor })).rejects.toThrow(/check/)
    await expect(xfer(A, { destination_account_id: null })).rejects.toThrow(/check/)
    await expect(xfer(A, { destination_account_id: accA })).rejects.toThrow(/check/) // same account
    await expect(xfer(A, { category_id: food })).rejects.toThrow(/check/)
    await expect(addTx(A, { destination_account_id: accA2 })).rejects.toThrow(/check/) // expense with a destination
  })
  it('cross-wallet source or destination is rejected', async () => {
    await expect(xfer(A, { destination_account_id: accC })).rejects.toThrow(/foreign key/)
    await expect(xfer(A, { account_id: accC })).rejects.toThrow(/foreign key|row-level security/)
    await expect(xfer(C, { account_id: accC, destination_account_id: accA })).rejects.toThrow(/foreign key/)
    await db.query(`insert into public.wallet_members (wallet_id, user_id, role) values ($1, $2, 'member')`, [WC, A])
    try {
      await expect(xfer(A, { account_id: accA, destination_account_id: accC })).rejects.toThrow(/foreign key/)
      await expect(xfer(A, { account_id: accC, destination_account_id: accA })).rejects.toThrow(/foreign key/)
      expect((await xfer(A, { account_id: accC, destination_account_id: accC2 })).wallet_id).toBe(WC)
    } finally {
      await db.query(`delete from public.wallet_members where wallet_id = $1 and user_id = $2`, [WC, A])
    }
  })
  it('client cannot spoof wallet_id, created_by or paid_by_user_id', async () => {
    for (const [col, v] of [['wallet_id', WA], ['created_by', A]] as const)
      await expect(raw(B, `account_id, destination_account_id, ${col}`, [accA, accA2, v])).rejects.toThrow(/permission denied/)
  })
  it('owner edits/deletes any; member only their own', async () => {
    const mine = await xfer(B)
    const theirs = await xfer(A)
    expect(await upd(B, mine.id, { amount_minor: 1234, destination_account_id: accA, account_id: accA2 })).toBe(1)
    expect(await upd(B, theirs.id, { amount_minor: 1 })).toBe(0)
    expect(await del(B, theirs.id)).toBe(0)
    expect(await upd(A, mine.id, { note: 'owner edit' })).toBe(1)
    expect(await del(B, mine.id)).toBe(1)
    expect(await del(A, theirs.id)).toBe(1)
  })
  it('edits cannot break the shape', async () => {
    const t = await xfer(B)
    await expect(upd(B, t.id, { destination_account_id: accA })).rejects.toThrow(/check/) // destination = source
    await expect(upd(B, t.id, { destination_account_id: accC })).rejects.toThrow(/foreign key/)
    await expect(upd(B, t.id, { category_id: food })).rejects.toThrow(/check/)
    await expect(upd(B, t.id, { amount_minor: 0 })).rejects.toThrow(/check/)
    expect(Number((await db.query<{ version: string }>(`select version from public.transactions where id = $1`, [t.id])).rows[0]!.version)).toBe(1)
  })
  it('changing type re-derives the payer: transfer -> expense gets the creator, expense -> transfer clears it', async () => {
    const t = await xfer(B)
    expect(await upd(B, t.id, { type: 'expense', category_id: food, destination_account_id: null })).toBe(1)
    let r = await db.query<{ paid_by_user_id: string | null }>(`select paid_by_user_id from public.transactions where id = $1`, [t.id])
    expect(r.rows[0]!.paid_by_user_id).toBe(B)
    expect(await upd(B, t.id, { type: 'transfer', category_id: null, destination_account_id: accA2 })).toBe(1)
    r = await db.query(`select paid_by_user_id from public.transactions where id = $1`, [t.id])
    expect(r.rows[0]!.paid_by_user_id).toBeNull()
  })
  it('locks BOTH accounts; delete blocked; unlocks when the transfer goes', async () => {
    const src = await acct(A, WA)
    const dst = await acct(A, WA)
    const has = (a: string) => db.query<{ r: boolean }>(`select public.account_has_transactions($1) as r`, [a]).then((r) => r.rows[0]!.r)
    expect([await has(src), await has(dst)]).toEqual([false, false])
    const t = await xfer(A, { account_id: src, destination_account_id: dst })
    expect([await has(src), await has(dst)]).toEqual([true, true])
    for (const a of [src, dst]) {
      await expect(as(A, () => db.query(`update public.accounts set type = 'bank' where id = $1`, [a]))).rejects.toThrow(/has transactions/)
      await expect(as(A, () => db.query(`update public.accounts set opening_balance_minor = 5 where id = $1`, [a]))).rejects.toThrow(/has transactions/)
      expect((await as(A, () => db.query(`update public.accounts set name = 'Renamed', holder = 'H' where id = $1`, [a]))).affectedRows).toBe(1)
      expect((await as(A, () => db.query(`delete from public.accounts where id = $1`, [a]))).affectedRows).toBe(0)
    }
    expect(await del(A, t.id)).toBe(1)
    expect([await has(src), await has(dst)]).toEqual([false, false])
    for (const a of [src, dst]) expect((await as(A, () => db.query(`delete from public.accounts where id = $1`, [a]))).affectedRows).toBe(1)
  })
  it('deleting a whole wallet removes its transfers', async () => {
    const w = await createWallet(C, 'TempTransfers')
    const [a, b] = [await acct(C, w), await acct(C, w)]
    await xfer(C, { account_id: a, destination_account_id: b })
    expect((await as(C, () => db.query(`delete from public.wallets where id = $1`, [w]))).affectedRows).toBe(1)
    expect((await db.query(`select 1 from public.transactions where wallet_id = $1`, [w])).rows).toHaveLength(0)
  })
})

describe('transactions: realtime invalidation (stubbed realtime schema; real trigger + policy)', () => {
  const sent = () => db.query<{ topic: string; event: string; payload: { op: string }; private: boolean }>(`select * from realtime.sent`).then((r) => r.rows)
  const canReceive = (uid: string, topic: string) =>
    as(uid, async () => {
      await db.query(`select set_config('realtime.topic', $1, false)`, [topic])
      return (await db.query(`select 1 from realtime.messages where extension = 'broadcast'`)).rows.length > 0
    })
  it('one private message per insert/update/delete, on the wallet topic, op only', async () => {
    await db.exec(`delete from realtime.sent`)
    const t = await addTx(B)
    await upd(B, t.id, { amount_minor: 1 })
    await del(B, t.id)
    const s = await sent()
    expect(s.map((m) => m.payload.op)).toEqual(['INSERT', 'UPDATE', 'DELETE'])
    for (const m of s) expect(m).toMatchObject({ topic: `wallet:${WA}`, event: 'tx_changed', private: true })
    expect(Object.keys(s[0]!.payload)).toEqual(['op'])
  })
  it('a transfer notifies like any other row; another wallet notifies on its own topic only', async () => {
    await db.exec(`delete from realtime.sent`)
    await addTx(A, { type: 'transfer', category_id: null, destination_account_id: await acct(A, WA) })
    await as(C, () => db.query(`insert into public.transactions (id, account_id, category_id, type, amount_minor, date) values (gen_random_uuid(), $1, $2, 'expense', 1, $3)`, [accC, foodC, D]))
    expect((await sent()).map((m) => m.topic)).toEqual([`wallet:${WA}`, `wallet:${WC}`])
  })
  it('a failing realtime.send never fails the money write', async () => {
    await db.exec(`alter function realtime.send(jsonb, text, text, boolean) rename to send_ok;
      create function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void language plpgsql as $$ begin raise exception 'realtime down'; end $$`)
    try {
      expect((await addTx(A)).id).toBeTruthy()
    } finally {
      await db.exec(`drop function realtime.send(jsonb, text, text, boolean); alter function realtime.send_ok(jsonb, text, text, boolean) rename to send`)
    }
  })
  it('only wallet members can receive on the wallet topic; malformed topics deny without erroring', async () => {
    await db.exec(`insert into realtime.messages (topic, extension) values ('x','broadcast')`) // a row to be visible; the policy keys on the joined topic
    expect(await canReceive(A, `wallet:${WA}`)).toBe(true)
    expect(await canReceive(B, `wallet:${WA}`)).toBe(true)
    expect(await canReceive(C, `wallet:${WA}`)).toBe(false)
    expect(await canReceive(A, `wallet:${WC}`)).toBe(false)
    for (const bad of ['wallet:not-a-uuid', 'wallet:', WA, '']) expect(await canReceive(A, bad)).toBe(false)
  })
  it('clients cannot publish to a wallet topic', async () => {
    await expect(as(A, () => db.query(`insert into realtime.messages (topic, extension) values ('wallet:${WA}','broadcast')`))).rejects.toThrow(/permission denied|row-level/)
  })
})
