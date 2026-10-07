// Phase 8: SQL aggregate account_summaries() vs the domain accountBalance() (the correctness reference),
// plus wallet authorization. Real migrations + RLS in PGlite with a stubbed `auth` schema.
import { PGlite } from '@electric-sql/pglite'
import { readdirSync, readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { accountBalance, type Transaction } from '../../src/domain/finance'

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

type Row = { account_id: string; wallet_id: string; account_name: string; opening_balance_minor: number | string; current_balance_minor: number | string; has_transactions: boolean }
const summaries = (uid: string | null, wallet: string) =>
  as(uid, () => db.query<Row>('select * from public.account_summaries($1)', [wallet])).then((r) => r.rows)
const balances = async (uid: string, wallet: string) =>
  new Map((await summaries(uid, wallet)).map((r) => [r.account_name, Number(r.current_balance_minor)]))

const mkAcct = (uid: string, wallet: string, name: string, opening: number, type = 'bank') =>
  as(uid, () =>
    db.query<{ id: string }>(
      `insert into public.accounts (id, wallet_id, name, type, opening_balance_minor) values (gen_random_uuid(), $1, $2, $3, $4) returning id`,
      [wallet, name, type, opening],
    ),
  ).then((r) => r.rows[0]!.id)
const catOf = (w: string) =>
  db.query<{ id: string }>(`select id from public.categories where wallet_id = $1 and name = 'Groceries'`, [w]).then((r) => r.rows[0]!.id)
const addTx = async (uid: string, wallet: string, type: Transaction['type'], account: string, amount: number, dest: string | null = null) =>
  as(uid, async () => {
    await db.query(
      `insert into public.transactions (id, account_id, destination_account_id, category_id, type, amount_minor, date)
       values (gen_random_uuid(), $1, $2, $3, $4, $5, '2026-10-10')`,
      [account, dest, type === 'expense' ? await catOf(wallet) : null, type, amount],
    )
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
  for (const u of [A, B, C]) await db.query(`insert into auth.users (id) values ($1)`, [u])
  WA = await createWallet(A, 'Household')
  WC = await createWallet(C, 'Private')
  await db.query(`insert into public.wallet_members (wallet_id, user_id, role) values ($1, $2, 'member')`, [WA, B])
})

describe('account_summaries: balances', () => {
  it('controlled dataset: A 20,000 and B 8,000 (the spec example)', async () => {
    const w = await createWallet(A, 'Spec')
    const a = await mkAcct(A, w, 'A', 2_000_000)
    const b = await mkAcct(A, w, 'B', 500_000)
    await addTx(A, w, 'income', a, 500_000)
    await addTx(A, w, 'expense', a, 200_000)
    await addTx(A, w, 'transfer', a, 300_000, b)
    const rows = await summaries(A, w)
    expect(rows.map((r) => [r.account_name, Number(r.opening_balance_minor), Number(r.current_balance_minor), r.has_transactions])).toEqual([
      ['A', 2_000_000, 2_000_000, true],
      ['B', 500_000, 800_000, true],
    ])
  })

  it('one transfer row moves both sides; empty account = opening; negative opening works', async () => {
    const w = await createWallet(A, 'Transfers')
    const src = await mkAcct(A, w, 'src', 100_000)
    const dst = await mkAcct(A, w, 'dst', 0)
    await mkAcct(A, w, 'idle', 777)
    await mkAcct(A, w, 'card', -5_000, 'credit_card')
    await addTx(A, w, 'transfer', src, 40_000, dst)
    expect(await balances(A, w)).toEqual(new Map([['src', 60_000], ['dst', 40_000], ['idle', 777], ['card', -5_000]]))
    const idle = (await summaries(A, w)).find((r) => r.account_name === 'idle')!
    expect(idle.has_transactions).toBe(false)
  })

  it('large values stay exact integers', async () => {
    const w = await createWallet(A, 'Big')
    const a = await mkAcct(A, w, 'big', 4_000_000_000_000_000)
    await addTx(A, w, 'income', a, 1_234_567_890_123)
    await addTx(A, w, 'expense', a, 7)
    expect((await balances(A, w)).get('big')).toBe(4_000_000_000_000_000 + 1_234_567_890_123 - 7)
  })

  it('PARITY: matches domain accountBalance() on a pseudo-random dataset', async () => {
    const w = await createWallet(A, 'Parity')
    let seed = 42
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n)
    const ids = [] as string[]
    const opening = new Map<string, number>()
    for (let i = 0; i < 5; i++) {
      const o = rnd(5_000_000)
      const id = await mkAcct(A, w, `acc${i}`, o)
      ids.push(id)
      opening.set(id, o)
    }
    for (let i = 0; i < 80; i++) {
      const type = (['income', 'expense', 'transfer'] as const)[rnd(3)]!
      const from = ids[rnd(5)]!
      const to = type === 'transfer' ? ids.filter((x) => x !== from)[rnd(4)]! : null
      await addTx(A, w, type, from, 1 + rnd(900_000), to)
    }
    const txs = await as(A, () => db.query<Transaction & { amount_minor: string | number }>(`select * from public.transactions where wallet_id = $1`, [w]))
    const domain = txs.rows.map((t) => ({ ...t, amount_minor: Number(t.amount_minor) }))
    expect(domain).toHaveLength(80)
    for (const r of await summaries(A, w)) {
      expect(Number(r.current_balance_minor)).toBe(accountBalance(r.account_id, opening.get(r.account_id)!, domain))
    }
  })
})

describe('account_summaries: authorization', () => {
  it('wallet scoping: each wallet returns only its own accounts', async () => {
    const wa = await mkAcct(A, WA, 'inA', 1)
    const wc = await mkAcct(C, WC, 'inC', 2)
    expect((await summaries(A, WA)).map((r) => r.account_id)).toContain(wa)
    expect((await summaries(A, WA)).every((r) => r.wallet_id === WA)).toBe(true)
    expect((await summaries(C, WC)).map((r) => r.account_id)).toEqual([wc])
  })
  it('a non-owner member can read the wallet balances', async () => {
    expect((await summaries(B, WA)).length).toBeGreaterThan(0)
  })
  it('an outsider gets no rows for a wallet they do not belong to', async () => {
    expect(await summaries(C, WA)).toEqual([])
    expect(await summaries(A, WC)).toEqual([])
  })
  it('anonymous is denied', async () => {
    await expect(summaries(null, WA)).rejects.toThrow(/permission denied/)
  })
  it('unknown wallet id returns nothing', async () => {
    expect(await summaries(A, '99999999-9999-4999-8999-999999999999')).toEqual([])
  })
  it('is SECURITY INVOKER (no definer privilege)', async () => {
    const r = await db.query<{ prosecdef: boolean }>(`select prosecdef from pg_proc where proname = 'account_summaries'`)
    expect(r.rows[0]!.prosecdef).toBe(false)
  })
})
