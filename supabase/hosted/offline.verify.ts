// Hosted verification for Phase 9 (offline create & sync). NOT part of `npm test` (touches the real dev project).
// Run: npx vitest run --config supabase/hosted/vitest.hosted.config.ts supabase/hosted/offline.verify.ts
// Runs the REAL outbox (fake-indexeddb), sync engine and transactionService against the hosted project with
// anon-key users only (RLS applies). The Management API is used only for adding a member, counting rows and cleanup.
// "Network down" and "response lost" are simulated by wrapping fetch in the client.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { IDBFactory } from 'fake-indexeddb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { accountBalance } from '../../src/domain/finance'
import { createAccountService } from '../../src/features/accounts/accountService'
import { openOfflineDb } from '../../src/features/offline/db/idb'
import { projectAccounts } from '../../src/features/offline/localFinance'
import { createOutbox, type Outbox } from '../../src/features/offline/outbox/outbox'
import { sendItem } from '../../src/features/offline/sync/sendItem'
import { syncOutbox } from '../../src/features/offline/sync/syncEngine'
import type { NewTransaction } from '../../src/features/transactions/transaction'
import { createTransactionService } from '../../src/features/transactions/transactionService'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
)
const URL = env.VITE_SUPABASE_URL!
const KEY = env.VITE_SUPABASE_ANON_KEY!
const dir = mkdtempSync(join(tmpdir(), 'mwoffline-'))

function sql<T = Record<string, unknown>>(q: string): T[] {
  const f = join(dir, 'q.sql')
  writeFileSync(f, q)
  const out = execFileSync('npx', ['supabase', 'db', 'query', '--linked', '-f', f], { encoding: 'utf8', shell: true })
  return JSON.parse(out.slice(out.indexOf('{'))).rows
}

const tag = `mwoff${Date.now()}`
const PW = `Off!${Math.random().toString(36).slice(2)}Aa1`
type Mode = 'up' | 'down' | 'lose'
type U = { c: SupabaseClient; id: string; mode: { v: Mode } }
async function user(n: string): Promise<U> {
  const mode = { v: 'up' as Mode }
  const c = createClient(URL, KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        if (mode.v === 'down') throw new TypeError('Failed to fetch')
        const res = await fetch(input, init)
        // response lost: the server COMMITTED the insert, the client never sees the reply
        if (mode.v === 'lose' && String(input).includes('/rest/v1/transactions') && init?.method === 'POST') throw new TypeError('Failed to fetch')
        return res
      },
    },
  })
  const { data, error } = await c.auth.signUp({ email: `reambillo.russel+${tag}${n}@gmail.com`, password: PW })
  if (error || !data.session) throw new Error(`signup ${n}: ${error?.message ?? 'no session'}`)
  return { c, id: data.user!.id, mode }
}
const mkAcct = async (u: U, w: string, name: string, opening = 0) => {
  const id = crypto.randomUUID()
  const { error } = await u.c.from('accounts').insert({ id, wallet_id: w, name, type: 'cash', opening_balance_minor: opening })
  if (error) throw error
  return id
}
const rowsOf = (id: string) => sql<{ n: number; by: string; amt: string }>(`select count(*)::int n, max(created_by::text) by, max(amount_minor)::text amt from public.transactions where id='${id}'`)[0]!
const total = (ids: string[]) => sql<{ n: number }>(`select count(*)::int n from public.transactions where id in (${ids.map((i) => `'${i}'`).join(',')})`)[0]!.n

let A: U, B: U, C: U
let WA: string, WB: string, cashA: string, bankA: string, accB: string, catA: string
let outbox: Outbox
const created: string[] = []
const D = '2026-10-10'
const tx = (o: Partial<NewTransaction> & { account_id: string }): NewTransaction => ({
  type: 'expense', destination_account_id: null, category_id: catA, amount_minor: 50000, date: D, note: null, ...o,
})
const queue = (u: U, id: string, wallet: string, payload: NewTransaction) => outbox.enqueue({ id, user_id: u.id, wallet_id: wallet, payload })
/** One sync run as `session` for `owner`, exactly like the app. */
const run = (session: U, owner: U = session) => {
  const svc = createTransactionService(session.c)
  return syncOutbox({ outbox, userId: owner.id, currentUserId: () => session.id, send: (i) => sendItem(svc, i) })
}

beforeAll(async () => {
  outbox = createOutbox(await openOfflineDb(new IDBFactory(), 'hosted'))
  A = await user('a')
  B = await user('b')
  C = await user('c')
  const w = async (u: U, name: string) => ((await u.c.rpc('create_wallet', { p_name: name })).data as { id: string }).id
  WA = await w(A, `${tag}-WA`)
  WB = await w(C, `${tag}-WB`)
  created.push(WA, WB)
  sql(`insert into public.wallet_members (wallet_id, user_id, role) values ('${WA}','${B.id}','member')`)
  cashA = await mkAcct(A, WA, 'Cash', 100000)
  bankA = await mkAcct(A, WA, 'Bank', 0)
  accB = await mkAcct(C, WB, 'Other wallet acct')
  catA = (await A.c.from('categories').select('id').eq('wallet_id', WA).eq('name', 'Groceries').single()).data!.id as string
}, 120_000)

afterAll(() => {
  const ids = created.map((i) => `'${i}'`).join(',')
  const uids = [A, B, C].filter(Boolean).map((u) => `'${u.id}'`).join(',')
  if (ids) sql(`delete from public.wallets where id in (${ids})`)
  if (uids) sql(`delete from auth.users where id in (${uids})`)
  const left = sql<{ w: number; u: number }>(`select (select count(*) from public.wallets where name like '${tag}%')::int w, (select count(*) from auth.users where email like '%${tag}%')::int u`)[0]
  console.log('CLEANUP leftover', left, 'tag', tag)
}, 120_000)

describe('offline create -> reconnect -> exactly one row each (expense, income, transfer)', () => {
  const ids = { e: crypto.randomUUID(), i: crypto.randomUUID(), t: crypto.randomUUID() }
  it('network down: nothing reaches the server, items stay queued', async () => {
    await queue(A, ids.e, WA, tx({ account_id: cashA, amount_minor: 50000 }))
    await queue(A, ids.i, WA, tx({ type: 'income', account_id: cashA, category_id: null, amount_minor: 20000 }))
    await queue(A, ids.t, WA, tx({ type: 'transfer', account_id: cashA, destination_account_id: bankA, category_id: null, amount_minor: 10000 }))
    A.mode.v = 'down'
    expect(await run(A)).toMatchObject({ synced: 0, stoppedBy: 'network' })
    A.mode.v = 'up'
    expect(total(Object.values(ids))).toBe(0)
    expect((await outbox.list(A.id)).map((i) => i.status)).toEqual(['PENDING', 'PENDING', 'PENDING'])
  })
  it('reconnect: all sync once, in order, owner = the session user, outbox drained', async () => {
    expect(await run(A)).toEqual({ synced: 3, conflicted: 0, stoppedBy: null })
    expect(await outbox.list(A.id)).toEqual([])
    for (const id of Object.values(ids)) expect(rowsOf(id)).toMatchObject({ n: 1, by: A.id })
    expect(total(Object.values(ids))).toBe(3)
  })
  it('server aggregate equals the local calculation (no drift, no double count)', async () => {
    const { data } = await A.c.rpc('account_summaries', { p_wallet_id: WA })
    const bal = (id: string) => (data as { account_id: string; current_balance_minor: number }[]).find((r) => r.account_id === id)!.current_balance_minor
    const rows = [
      { id: ids.e, ...tx({ account_id: cashA, amount_minor: 50000 }) },
      { id: ids.i, ...tx({ type: 'income', account_id: cashA, category_id: null, amount_minor: 20000 }) },
      { id: ids.t, ...tx({ type: 'transfer', account_id: cashA, destination_account_id: bankA, category_id: null, amount_minor: 10000 }) },
    ]
    expect(bal(cashA)).toBe(accountBalance(cashA, 100000, rows))
    expect(bal(bankA)).toBe(accountBalance(bankA, 0, rows))
    expect([bal(cashA), bal(bankA)]).toEqual([60000, 10000])
  })
})

describe('idempotent replay', () => {
  it('response lost after the server committed: retry creates no duplicate', async () => {
    const id = crypto.randomUUID()
    await queue(A, id, WA, tx({ account_id: cashA, amount_minor: 111 }))
    A.mode.v = 'lose'
    expect(await run(A)).toMatchObject({ synced: 0, stoppedBy: 'network' })
    A.mode.v = 'up'
    expect(rowsOf(id).n).toBe(1) // committed server-side although the client saw a failure
    expect((await outbox.list(A.id))[0]).toMatchObject({ id, status: 'PENDING' })
    expect(await run(A)).toEqual({ synced: 1, conflicted: 0, stoppedBy: null })
    expect(rowsOf(id)).toMatchObject({ n: 1, by: A.id })
    expect(await outbox.list(A.id)).toEqual([])
  })
  it('replaying an already-synced UUID is a no-op success', async () => {
    const id = crypto.randomUUID()
    await queue(A, id, WA, tx({ account_id: cashA, amount_minor: 222 }))
    await run(A)
    const svc = createTransactionService(A.c)
    await svc.send(id, A.id, tx({ account_id: cashA, amount_minor: 999 })) // direct replay, different amount
    expect(rowsOf(id)).toMatchObject({ n: 1, amt: '222' }) // original untouched
  })
})

describe('integrity: UUID owned by someone else', () => {
  it("same-wallet member B reuses A's UUID: BLOCKED, A's row untouched", async () => {
    const id = crypto.randomUUID()
    await queue(A, id, WA, tx({ account_id: cashA, amount_minor: 333 }))
    await run(A)
    // B has its own device/outbox record with the colliding id (outbox ids are unique per device, so use a fresh outbox)
    const outboxB = createOutbox(await openOfflineDb(new IDBFactory(), 'hostedB'))
    await outboxB.enqueue({ id, user_id: B.id, wallet_id: WA, payload: tx({ account_id: cashA, amount_minor: 1 }) })
    const svc = createTransactionService(B.c)
    await syncOutbox({ outbox: outboxB, userId: B.id, currentUserId: () => B.id, send: (i) => sendItem(svc, i) })
    const [item] = await outboxB.list(B.id)
    expect(item).toMatchObject({ status: 'BLOCKED' })
    expect(item!.last_error).toMatch(/not yours|42501|row-level/)
    expect(rowsOf(id)).toMatchObject({ n: 1, by: A.id, amt: '333' })
  })
  it("a user outside the wallet reusing A's UUID: BLOCKED, A's row untouched", async () => {
    const id = crypto.randomUUID()
    await queue(A, id, WA, tx({ account_id: cashA, amount_minor: 444 }))
    await run(A)
    const outboxC = createOutbox(await openOfflineDb(new IDBFactory(), 'hostedC'))
    await outboxC.enqueue({ id, user_id: C.id, wallet_id: WB, payload: tx({ account_id: accB, category_id: null, type: 'income', amount_minor: 1 }) })
    const svc = createTransactionService(C.c)
    await syncOutbox({ outbox: outboxC, userId: C.id, currentUserId: () => C.id, send: (i) => sendItem(svc, i) })
    expect((await outboxC.list(C.id))[0]!.status).toBe('BLOCKED')
    expect(rowsOf(id)).toMatchObject({ n: 1, by: A.id, amt: '444' })
  })
})

describe('RLS stays authoritative', () => {
  it("A queues a transaction on an account of a wallet A does not belong to: BLOCKED, nothing created", async () => {
    const id = crypto.randomUUID()
    await queue(A, id, WB, tx({ type: 'income', account_id: accB, category_id: null, amount_minor: 555 }))
    expect(await run(A)).toMatchObject({ synced: 0, conflicted: 0, stoppedBy: null })
    const [item] = (await outbox.list(A.id)).filter((i) => i.id === id)
    expect(item).toMatchObject({ status: 'BLOCKED', payload: { account_id: accB, amount_minor: 555 } }) // not re-pointed
    expect(rowsOf(id).n).toBe(0)
  })
})

describe('user isolation', () => {
  it("B's session never sends A's queued item; A signing back in does", async () => {
    const id = crypto.randomUUID()
    await queue(A, id, WA, tx({ account_id: cashA, amount_minor: 666 }))
    expect(await run(B)).toEqual({ synced: 0, conflicted: 0, stoppedBy: null }) // B is current: only B's (empty) queue is eligible
    expect(rowsOf(id).n).toBe(0)
    expect((await outbox.list(A.id)).find((i) => i.id === id)!.status).toBe('PENDING')
    expect(await run(A)).toMatchObject({ stoppedBy: null })
    expect(rowsOf(id)).toMatchObject({ n: 1, by: A.id })
  })
})

describe('Phase 9.1 pending-aware local state (server baseline + outbox)', () => {
  const baseline = async () => {
    const accounts = await createAccountService(A.c).list(WA)
    const pending = (await outbox.list(A.id)).filter((i) => i.wallet_id === WA).map((i) => i.id)
    const confirmed = await createTransactionService(A.c).existingIds(pending)
    return { accounts, confirmed }
  }
  const cash = async () => projectAccounts(await baseline(), await outbox.list(A.id), WA).find((a) => a.id === cashA)!.currentBalanceMinor
  const serverCash = async () => (await baseline()).accounts.find((a) => a.id === cashA)!.currentBalanceMinor
  it('queued but not on the server: baseline minus the pending expense', async () => {
    const before = await serverCash()
    await queue(A, crypto.randomUUID(), WA, tx({ account_id: cashA, amount_minor: 20000 }))
    expect(await serverCash()).toBe(before)
    expect(await cash()).toBe(before - 20000)
  })
  it('server committed but the outbox row is still there (lost response): counted once', async () => {
    await run(A) // drain the item queued above so this one is the only one in flight
    const id = crypto.randomUUID()
    await queue(A, id, WA, tx({ account_id: cashA, amount_minor: 7000 }))
    A.mode.v = 'lose'
    await run(A) // the server commits, the client never sees the reply
    A.mode.v = 'up'
    expect(rowsOf(id).n).toBe(1)
    expect((await outbox.list(A.id)).map((i) => i.id)).toContain(id)
    expect((await baseline()).confirmed).toEqual([id])
    expect(await cash()).toBe(await serverCash()) // not 7000 lower
  })
  it('after sync the server is the baseline and the queue is empty', async () => {
    const expected = await cash()
    expect(await run(A)).toMatchObject({ stoppedBy: null })
    expect((await outbox.list(A.id)).filter((i) => i.wallet_id === WA && i.status !== 'BLOCKED')).toEqual([])
    expect(await cash()).toBe(expected)
    expect(await serverCash()).toBe(expected)
  })
})
