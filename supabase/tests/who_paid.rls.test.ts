// Phase D7: Who Paid / Received by. Real migrations + RLS in PGlite with a stubbed `auth` schema.
import { PGlite } from '@electric-sql/pglite'
import { readdirSync, readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'

const A = '11111111-1111-4111-8111-111111111111' // Alice: owner of WA
const B = '22222222-2222-4222-8222-222222222222' // Bella: member of WA
const C = '33333333-3333-4333-8333-333333333333' // Charlie: member of WA
const X = '44444444-4444-4444-8444-444444444444' // Xavier: owner of WX only (outsider to WA)
const F = '66666666-6666-4666-8666-666666666666' // former member of WA
const NOBODY = '99999999-9999-4999-8999-999999999999'
const dir = new URL('../migrations/', import.meta.url)
let db: PGlite
let WA: string
let accA: string
let accX: string
let transferTo: string
let food: string
let foodX: string

async function as<T>(uid: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${uid ? 'authenticated' : 'anon'}`)
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid ?? ''])
  try {
    return await fn()
  } finally {
    await db.exec('reset role')
  }
}
type Row = { id: string; type: string; created_by: string; paid_by_user_id: string | null; version: string; amount_minor: string }
const get = (id: string) => db.query<Row>(`select * from public.transactions where id = $1`, [id]).then((r) => r.rows[0]!)
/** Direct client INSERT (the create path). `paid` undefined = the client sends no payer. */
const create = (uid: string | null, o: { type?: string; paid?: string | null; account?: string; category?: string | null } = {}) => {
  const type = o.type ?? 'expense'
  const id = crypto.randomUUID()
  const cols = ['id', 'account_id', 'category_id', 'type', 'amount_minor', 'date']
  const vals: unknown[] = [id, o.account ?? accA, o.category === undefined ? (type === 'expense' ? food : null) : o.category, type, 50000, '2026-10-10']
  if (type === 'transfer') { cols.push('destination_account_id'); vals.push(transferTo) }
  if (o.paid !== undefined) { cols.push('paid_by_user_id'); vals.push(o.paid) }
  return as(uid, () => db.query(`insert into public.transactions (${cols.join(',')}) values (${vals.map((_, i) => `$${i + 1}`).join(',')})`, vals)).then(() => id)
}
const payload = (o: Record<string, unknown> = {}) => ({
  type: 'expense', account_id: accA, destination_account_id: null, category_id: food, amount_minor: 60000, date: '2026-10-10', note: null, ...o,
})
/** apply_transaction_mutation UPDATE with the row's current version. */
const edit = async (uid: string | null, id: string, p: Record<string, unknown>) => {
  const v = Number((await get(id)).version)
  return as(uid, () =>
    db.query<{ r: { status: string } }>(`select public.apply_transaction_mutation($1, 'UPDATE', $2, $3, $4::jsonb, false) as r`, [crypto.randomUUID(), id, v, JSON.stringify(p)]),
  ).then((r) => r.rows[0]!.r)
}

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
  for (const u of [A, B, C, X, F]) await db.query(`insert into auth.users (id) values ($1)`, [u])
  const wallet = (uid: string, name: string) => as(uid, () => db.query<{ id: string }>('select * from public.create_wallet($1)', [name])).then((r) => r.rows[0]!.id)
  WA = await wallet(A, 'Household')
  const WX = await wallet(X, 'Other')
  for (const u of [B, C]) await db.query(`insert into public.wallet_members (wallet_id, user_id, role) values ($1, $2, 'member')`, [WA, u])
  const acc = (uid: string, w: string, n: string) =>
    as(uid, () => db.query<{ id: string }>(`insert into public.accounts (id, wallet_id, name, type) values (gen_random_uuid(), $1, $2, 'cash') returning id`, [w, n])).then((r) => r.rows[0]!.id)
  accA = await acc(A, WA, 'Cash')
  transferTo = await acc(A, WA, 'Bank')
  accX = await acc(X, WX, 'X cash')
  const cat = (w: string) => db.query<{ id: string }>(`select id from public.categories where wallet_id = $1 and name = 'Groceries'`, [w]).then((r) => r.rows[0]!.id)
  food = await cat(WA)
  foodX = await cat(WX)
  // F (a user who is in no wallet) stands for someone who has left: not in wallet_members.
})

describe('create: defaults and alternate payer / recipient', () => {
  for (const type of ['expense', 'income'] as const) {
    it(`${type} without a payer defaults to the creator`, async () => {
      const t = await get(await create(A, { type }))
      expect(t.created_by).toBe(A)
      expect(t.paid_by_user_id).toBe(A)
    })
    it(`${type} with an explicit null payer also defaults to the creator`, async () => {
      expect((await get(await create(B, { type, paid: null }))).paid_by_user_id).toBe(B)
    })
    it(`${type}: Alice records Bella - created_by stays Alice, paid_by is Bella`, async () => {
      const t = await get(await create(A, { type, paid: B }))
      expect(t.created_by).toBe(A)
      expect(t.paid_by_user_id).toBe(B)
    })
    it(`${type}: a plain member may record another current member, and the owner`, async () => {
      expect((await get(await create(B, { type, paid: C }))).paid_by_user_id).toBe(C)
      expect((await get(await create(B, { type, paid: A }))).paid_by_user_id).toBe(A)
    })
  }
})

describe('create: payer validation (server side)', () => {
  it('rejects an outsider / a member of ANOTHER wallet', async () => {
    await expect(create(A, { paid: X })).rejects.toThrow()
  })
  it('rejects a former member', async () => {
    await expect(create(A, { paid: F })).rejects.toThrow()
  })
  it('rejects an unknown user id', async () => {
    await expect(create(A, { paid: NOBODY })).rejects.toThrow()
  })
  it('rejects a payer that is not a uuid', async () => {
    await expect(create(A, { paid: 'not-a-uuid' })).rejects.toThrow()
  })
  it('rejects anonymous', async () => {
    await expect(create(null, { paid: A })).rejects.toThrow()
  })
  it('the wallet comes from the account: another wallet cannot name WA members as payers', async () => {
    await expect(create(X, { paid: A, account: accX, category: foodX })).rejects.toThrow()
    await expect(create(X, { paid: B, account: accX, category: foodX })).rejects.toThrow()
    expect((await get(await create(X, { account: accX, category: foodX }))).paid_by_user_id).toBe(X)
  })
  it('an outsider cannot write into WA at all, whoever they name', async () => {
    await expect(create(X, { paid: X })).rejects.toThrow()
    await expect(create(X, { paid: A })).rejects.toThrow()
  })
})

describe('edit via apply_transaction_mutation', () => {
  it('Bella to Charlie changes only paid_by_user_id (and bumps the version); created_by is untouched', async () => {
    const id = await create(A, { paid: B })
    const before = await get(id)
    expect(await edit(A, id, payload({ paid_by_user_id: C, amount_minor: 50000 }))).toMatchObject({ status: 'APPLIED' })
    const after = await get(id)
    expect(after.created_by).toBe(A)
    expect(after.paid_by_user_id).toBe(C)
    expect(Number(after.version)).toBe(Number(before.version) + 1)
    expect(after.amount_minor).toBe(before.amount_minor)
  })
  it('a payload can never change created_by', async () => {
    const id = await create(A, { paid: B })
    await edit(A, id, payload({ paid_by_user_id: C, created_by: C }))
    expect((await get(id)).created_by).toBe(A)
  })
  it('a payload without a payer keeps the stored one (edits queued before D7)', async () => {
    const id = await create(A, { paid: B })
    await edit(A, id, payload())
    expect((await get(id)).paid_by_user_id).toBe(B)
  })
  it('a member edits their own transaction and picks another current member', async () => {
    const id = await create(B, { paid: B })
    expect(await edit(B, id, payload({ paid_by_user_id: C }))).toMatchObject({ status: 'APPLIED' })
    expect((await get(id)).paid_by_user_id).toBe(C)
  })
  it('rejects outsider, other-wallet, former and unknown payers; nothing changes', async () => {
    const id = await create(A, { paid: B })
    for (const bad of [X, F, NOBODY]) {
      await expect(edit(A, id, payload({ paid_by_user_id: bad }))).rejects.toThrow()
    }
    expect((await get(id)).paid_by_user_id).toBe(B)
  })
  it('rejects anonymous', async () => {
    const id = await create(A)
    await expect(edit(null, id, payload({ paid_by_user_id: B }))).rejects.toThrow()
  })
  it('authorization is unchanged: a member cannot re-attribute someone elses transaction', async () => {
    const id = await create(A, { paid: A })
    expect(await edit(B, id, payload({ paid_by_user_id: B }))).toMatchObject({ status: 'FORBIDDEN' })
    expect((await get(id)).paid_by_user_id).toBe(A)
  })
  it('the owner may re-attribute a members transaction; created_by stays the member', async () => {
    const id = await create(B, { paid: B })
    expect(await edit(A, id, payload({ paid_by_user_id: C }))).toMatchObject({ status: 'APPLIED' })
    const t = await get(id)
    expect([t.created_by, t.paid_by_user_id]).toEqual([B, C])
  })
})

describe('transfers have no payer or recipient', () => {
  it('a transfer is stored with paid_by NULL even if the client names one', async () => {
    expect((await get(await create(A, { type: 'transfer', paid: B }))).paid_by_user_id).toBeNull()
    expect((await get(await create(A, { type: 'transfer' }))).paid_by_user_id).toBeNull()
  })
  it('a transfer ignores an invalid payer instead of validating it', async () => {
    expect((await get(await create(A, { type: 'transfer', paid: X }))).paid_by_user_id).toBeNull()
  })
  it('editing a transfer keeps it payer-less; converting expense to transfer clears the payer', async () => {
    const t = await create(A, { type: 'transfer' })
    await edit(A, t, payload({ type: 'transfer', destination_account_id: transferTo, category_id: null, paid_by_user_id: B }))
    expect((await get(t)).paid_by_user_id).toBeNull()
    const e = await create(A, { paid: B })
    await edit(A, e, payload({ type: 'transfer', destination_account_id: transferTo, category_id: null }))
    expect((await get(e)).paid_by_user_id).toBeNull()
  })
  it('transfer to expense takes the chosen payer (or the editor when none is given)', async () => {
    const t = await create(A, { type: 'transfer' })
    await edit(A, t, payload({ paid_by_user_id: C }))
    expect((await get(t)).paid_by_user_id).toBe(C)
    const t2 = await create(A, { type: 'transfer' })
    await edit(A, t2, payload())
    expect((await get(t2)).paid_by_user_id).toBe(A)
  })
})

describe('history survives membership changes', () => {
  it('Bella leaves: created_by / paid_by stay; editing other fields keeps her; assigning her anew is refused', async () => {
    const id = await create(A, { paid: B })
    await db.query(`delete from public.wallet_members where wallet_id = $1 and user_id = $2`, [WA, B])
    try {
      const t = await get(id)
      expect([t.created_by, t.paid_by_user_id]).toEqual([A, B])
      // the unchanged historical payer is not re-validated, so an ordinary edit still works...
      expect(await edit(A, id, payload({ paid_by_user_id: B, amount_minor: 70000 }))).toMatchObject({ status: 'APPLIED' })
      expect((await get(id)).paid_by_user_id).toBe(B)
      // ...but she cannot be newly assigned, on a new or an existing transaction
      await expect(create(A, { paid: B })).rejects.toThrow()
      const other = await create(A, { paid: C })
      await expect(edit(A, other, payload({ paid_by_user_id: B }))).rejects.toThrow()
    } finally {
      await db.query(`insert into public.wallet_members (wallet_id, user_id, role) values ($1, $2, 'member')`, [WA, B])
    }
  })
})

describe('direct column access', () => {
  it('a client still cannot UPDATE paid_by_user_id directly (the RPC is the only mutation path)', async () => {
    const id = await create(A)
    await expect(as(A, () => db.query(`update public.transactions set paid_by_user_id = $2 where id = $1`, [id, B]))).rejects.toThrow()
    expect((await get(id)).paid_by_user_id).toBe(A)
  })
  it('created_by cannot be supplied on insert', async () => {
    await expect(as(A, () => db.query(
      `insert into public.transactions (id, account_id, category_id, type, amount_minor, date, created_by) values (gen_random_uuid(), $1, $2, 'expense', 1, '2026-10-10', $3)`,
      [accA, food, B]))).rejects.toThrow()
  })
})
