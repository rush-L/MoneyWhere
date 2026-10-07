// Hosted verification for Phase 11B (versioned UPDATE/DELETE, offline edit/delete). NOT part of `npm test`.
// Run (only after migrations 20261015/20261016 are applied to the linked project):
//   npx vitest run --config supabase/hosted/vitest.hosted.config.ts supabase/hosted/mutations.verify.ts
// REAL outbox (fake-indexeddb), sync engine, sendItem and transactionService against the hosted project with anon-key
// users only (RLS applies). The Management API is used only for adding a member, counting rows and cleanup.
// "Network down" and "response lost" are simulated by wrapping fetch in the client.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { IDBFactory } from 'fake-indexeddb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openOfflineDb } from '../../src/features/offline/db/idb'
import { createOutbox, type Outbox } from '../../src/features/offline/outbox/outbox'
import { sendItem } from '../../src/features/offline/sync/sendItem'
import { syncOutbox } from '../../src/features/offline/sync/syncEngine'
import type { NewTransaction, TransactionRow } from '../../src/features/transactions/transaction'
import { createTransactionService, TransactionConflictError, TransactionError } from '../../src/features/transactions/transactionService'
import { assertDevProject } from './guard.mjs'

assertDevProject() // refuses unless .env.local, the linked project and the approved dev list agree

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
)
const URL = env.VITE_SUPABASE_URL!
const KEY = env.VITE_SUPABASE_ANON_KEY!
const dir = mkdtempSync(join(tmpdir(), 'mwmut-'))

function sql<T = Record<string, unknown>>(q: string): T[] {
  const f = join(dir, 'q.sql')
  writeFileSync(f, q)
  const out = execFileSync('npx', ['supabase', 'db', 'query', '--linked', '-f', f], { encoding: 'utf8', shell: true })
  return JSON.parse(out.slice(out.indexOf('{'))).rows
}

const tag = `mwmut${Date.now()}`
const PW = `Mut!${Math.random().toString(36).slice(2)}Aa1`
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
        // response lost: the server COMMITTED the mutation, the client never sees the reply
        if (mode.v === 'lose' && String(input).includes('/rest/v1/rpc/apply_transaction_mutation')) throw new TypeError('Failed to fetch')
        return res
      },
    },
  })
  const { data, error } = await c.auth.signUp({ email: `reambillo.russel+${tag}${n}@gmail.com`, password: PW })
  if (error || !data.session) throw new Error(`signup ${n}: ${error?.message ?? 'no session'}`)
  return { c, id: data.user!.id, mode }
}

let A: U, B: U, C: U // A owner, B member, C outsider
let WA: string, cashA: string, catA: string
let outbox: Outbox
const D = '2026-10-10'
const tx = (o: Partial<NewTransaction> = {}): NewTransaction => ({
  type: 'expense', account_id: cashA, destination_account_id: null, category_id: catA, amount_minor: 50000, date: D, note: null, ...o,
})
const state = (id: string) => sql<{ n: number; amt: string | null; v: string | null }>(`select count(*)::int n, max(amount_minor)::text amt, max(version)::text v from public.transactions where id='${id}'`)[0]!
/** B (or A) creates a row online, like the app, and returns it as the client would have cached it (with its version). */
async function seed(u: U, o: Partial<NewTransaction> = {}): Promise<TransactionRow> {
  const id = crypto.randomUUID()
  const svc = createTransactionService(u.c)
  await svc.send(id, u.id, tx(o))
  return (await svc.list(WA)).find((r) => r.id === id)!
}
const run = (session: U, owner: U = session) => {
  const svc = createTransactionService(session.c)
  return syncOutbox({ outbox, userId: owner.id, currentUserId: () => session.id, send: (i) => sendItem(svc, i) })
}
const queueEdit = (u: U, row: TransactionRow, payload: NewTransaction) =>
  outbox.edit({ id: row.id, user_id: u.id, wallet_id: WA, expected_version: row.version!, payload, base: row })
const queueDelete = (u: U, row: TransactionRow) => outbox.remove({ id: row.id, user_id: u.id, wallet_id: WA, expected_version: row.version ?? null, base: row })

beforeAll(async () => {
  outbox = createOutbox(await openOfflineDb(new IDBFactory(), 'hostedmut'))
  A = await user('a')
  B = await user('b')
  C = await user('c')
  WA = ((await A.c.rpc('create_wallet', { p_name: `${tag}-WA` })).data as { id: string }).id
  sql(`insert into public.wallet_members (wallet_id, user_id, role) values ('${WA}','${B.id}','member')`)
  cashA = crypto.randomUUID()
  const r = await A.c.from('accounts').insert({ id: cashA, wallet_id: WA, name: 'Cash', type: 'cash', opening_balance_minor: 100000 })
  if (r.error) throw r.error
  catA = (await A.c.from('categories').select('id').eq('wallet_id', WA).eq('name', 'Groceries').single()).data!.id as string
}, 120_000)

afterAll(() => {
  const uids = [A, B, C].filter(Boolean).map((u) => `'${u.id}'`).join(',')
  sql(`delete from public.wallets where name like '${tag}%'`)
  if (uids) sql(`delete from auth.users where id in (${uids})`) // the ledger rows go with the users (ON DELETE CASCADE)
  const left = sql<{ w: number; u: number }>(`select (select count(*) from public.wallets where name like '${tag}%')::int w, (select count(*) from auth.users where email like '%${tag}%')::int u`)[0]
  console.log('CLEANUP leftover', left, 'tag', tag)
}, 120_000)

describe('version', () => {
  it('rows start at version 1 and the client sees it', async () => {
    const r = await seed(B)
    expect(r.version).toBe(1)
  })
})

describe('offline own UPDATE / DELETE', () => {
  it('update: queued offline, replayed at the unchanged version, applied once, version +1', async () => {
    const row = await seed(B)
    await queueEdit(B, row, tx({ amount_minor: 60000 }))
    B.mode.v = 'down'
    expect(await run(B)).toMatchObject({ synced: 0, stoppedBy: 'network' })
    B.mode.v = 'up'
    expect(state(row.id)).toMatchObject({ amt: '50000', v: '1' }) // nothing reached the server while offline
    expect(await run(B)).toEqual({ synced: 1, conflicted: 0, stoppedBy: null })
    expect(state(row.id)).toMatchObject({ amt: '60000', v: '2' })
    expect(await outbox.list(B.id)).toEqual([])
  })
  it('delete: replayed at the unchanged version, row gone', async () => {
    const row = await seed(B)
    await queueDelete(B, row)
    expect(await run(B)).toEqual({ synced: 1, conflicted: 0, stoppedBy: null })
    expect(state(row.id).n).toBe(0)
  })
})

describe('conflicts keep the server\'s newer data', () => {
  it('update conflict: the owner edited while the member was offline', async () => {
    const row = await seed(B)
    await queueEdit(B, row, tx({ amount_minor: 60000 }))
    await createTransactionService(A.c).update(row.id, row.version, tx({ amount_minor: 70000 })) // owner, online, v1 -> v2
    expect(await run(B)).toEqual({ synced: 0, conflicted: 1, stoppedBy: null })
    expect(state(row.id)).toMatchObject({ amt: '70000', v: '2' })
    const [item] = await outbox.list(B.id)
    expect(item).toMatchObject({ id: row.id, status: 'CONFLICT' })
    await run(B) // never retried
    expect(state(row.id)).toMatchObject({ amt: '70000', v: '2' })
    await outbox.discard(row.id) // "Keep server version"
    expect(await outbox.list(B.id)).toEqual([])
  })
  it('delete conflict: the row was edited, so it is NOT deleted', async () => {
    const row = await seed(B)
    await queueDelete(B, row)
    await createTransactionService(A.c).update(row.id, row.version, tx({ amount_minor: 70000 }))
    expect(await run(B)).toEqual({ synced: 0, conflicted: 1, stoppedBy: null })
    expect(state(row.id)).toMatchObject({ n: 1, amt: '70000', v: '2' })
    await outbox.discard(row.id)
  })
  it('already deleted: a queued delete completes as an idempotent success', async () => {
    const row = await seed(B)
    await queueDelete(B, row)
    await createTransactionService(A.c).remove(row.id, row.version) // owner deletes first
    expect(await run(B)).toEqual({ synced: 1, conflicted: 0, stoppedBy: null })
    expect(await outbox.list(B.id)).toEqual([])
  })
  it('update of a deleted row is a conflict and never resurrects it', async () => {
    const row = await seed(B)
    await queueEdit(B, row, tx({ amount_minor: 60000 }))
    await createTransactionService(A.c).remove(row.id, row.version)
    expect(await run(B)).toEqual({ synced: 0, conflicted: 1, stoppedBy: null })
    expect(state(row.id).n).toBe(0)
    await outbox.discard(row.id)
  })
})

describe('offline create folded with edit / delete', () => {
  it('create ₱500 then edit to ₱600: one server row at ₱600', async () => {
    const id = crypto.randomUUID()
    await outbox.enqueue({ id, user_id: B.id, wallet_id: WA, payload: tx({ amount_minor: 50000 }) })
    await outbox.edit({ id, user_id: B.id, wallet_id: WA, expected_version: 0, payload: tx({ amount_minor: 60000 }), base: { id } as TransactionRow })
    expect(await run(B)).toEqual({ synced: 1, conflicted: 0, stoppedBy: null })
    expect(state(id)).toMatchObject({ n: 1, amt: '60000', v: '1' })
  })
  it('create then delete: nothing is sent, no server row', async () => {
    const id = crypto.randomUUID()
    await outbox.enqueue({ id, user_id: B.id, wallet_id: WA, payload: tx() })
    await outbox.remove({ id, user_id: B.id, wallet_id: WA, expected_version: null, base: null })
    expect(await outbox.list(B.id)).toEqual([])
    expect(await run(B)).toEqual({ synced: 0, conflicted: 0, stoppedBy: null })
    expect(state(id).n).toBe(0)
  })
})

describe('idempotent replay (lost response)', () => {
  it('UPDATE committed but the reply was lost: the retry is ALREADY_APPLIED, never a false conflict, and a later edit by someone else survives', async () => {
    const row = await seed(B)
    await queueEdit(B, row, tx({ amount_minor: 60000 }))
    B.mode.v = 'lose'
    expect(await run(B)).toMatchObject({ synced: 0, stoppedBy: 'network' })
    B.mode.v = 'up'
    expect(state(row.id)).toMatchObject({ amt: '60000', v: '2' }) // committed although the client saw a failure
    expect((await outbox.list(B.id))[0]).toMatchObject({ status: 'PENDING', attempt_count: 1 })
    await expect(queueEdit(B, row, tx({ amount_minor: 1 }))).rejects.toThrow(/already attempted/) // in doubt: not rewritable
    await createTransactionService(A.c).update(row.id, 2, tx({ amount_minor: 90000 })) // owner edits meanwhile -> v3
    expect(await run(B)).toEqual({ synced: 1, conflicted: 0, stoppedBy: null })
    expect(state(row.id)).toMatchObject({ amt: '90000', v: '3' }) // exactly one effective mutation; owner's change intact
  })
  it('DELETE committed but the reply was lost: the retry succeeds (not a conflict)', async () => {
    const row = await seed(B)
    await queueDelete(B, row)
    B.mode.v = 'lose'
    await run(B)
    B.mode.v = 'up'
    expect(state(row.id).n).toBe(0)
    expect(await run(B)).toEqual({ synced: 1, conflicted: 0, stoppedBy: null })
  })
})

describe('user isolation and own-only', () => {
  it('B\'s queued update is never sent by A\'s session, and goes out when B signs back in', async () => {
    const row = await seed(B)
    await queueEdit(B, row, tx({ amount_minor: 60000 }))
    expect(await run(A)).toEqual({ synced: 0, conflicted: 0, stoppedBy: null })
    expect(state(row.id)).toMatchObject({ amt: '50000', v: '1' })
    expect((await outbox.list(B.id))[0]).toMatchObject({ status: 'PENDING', attempt_count: 0 })
    expect(await run(B)).toMatchObject({ synced: 1 })
  })
  it('replay is own-only even for the owner: A\'s session sending an item for B\'s row is refused (BLOCKED), data untouched', async () => {
    const row = await seed(B)
    // A queues an offline edit of B's transaction (the UI never offers this; the server must refuse it anyway)
    await outbox.edit({ id: row.id, user_id: A.id, wallet_id: WA, expected_version: row.version!, payload: tx({ amount_minor: 1 }), base: row })
    expect(await run(A)).toMatchObject({ synced: 0, conflicted: 0 })
    expect((await outbox.list(A.id))[0]).toMatchObject({ status: 'BLOCKED' })
    expect(state(row.id)).toMatchObject({ amt: '50000', v: '1' })
    await outbox.discard(row.id)
  })
})

describe('online edit / delete use the same RPC and keep permissions', () => {
  it('owner edits and deletes any transaction online; the version moves', async () => {
    const row = await seed(B)
    await createTransactionService(A.c).update(row.id, row.version, tx({ amount_minor: 61000 }))
    expect(state(row.id)).toMatchObject({ amt: '61000', v: '2' })
    await createTransactionService(A.c).remove(row.id, 2)
    expect(state(row.id).n).toBe(0)
  })
  it('a member cannot edit or delete the owner\'s transaction', async () => {
    const row = await seed(A)
    const svc = createTransactionService(B.c)
    await expect(svc.update(row.id, row.version, tx({ amount_minor: 1 }))).rejects.toThrow(TransactionError)
    await expect(svc.remove(row.id, row.version)).rejects.toThrow(/only delete transactions you created/)
    expect(state(row.id)).toMatchObject({ n: 1, amt: '50000', v: '1' })
  })
  it('a stale online edit or delete is a conflict and overwrites nothing', async () => {
    const row = await seed(B)
    await createTransactionService(B.c).update(row.id, 1, tx({ amount_minor: 70000 })) // v2
    await expect(createTransactionService(A.c).update(row.id, 1, tx({ amount_minor: 1 }))).rejects.toBeInstanceOf(TransactionConflictError)
    await expect(createTransactionService(A.c).remove(row.id, 1)).rejects.toBeInstanceOf(TransactionConflictError)
    expect(state(row.id)).toMatchObject({ n: 1, amt: '70000', v: '2' })
  })
  it('an outsider changes nothing', async () => {
    const row = await seed(B)
    await expect(createTransactionService(C.c).update(row.id, 1, tx({ amount_minor: 1 }))).rejects.toBeInstanceOf(TransactionConflictError)
    await createTransactionService(C.c).remove(row.id, 1) // invisible = "already gone" for them, but nothing is deleted
    expect(state(row.id)).toMatchObject({ n: 1, amt: '50000', v: '1' })
  })
  it('clients cannot write version or the ledger directly', async () => {
    const row = await seed(B)
    expect((await B.c.from('transactions').update({ version: 99 }).eq('id', row.id)).error).toBeTruthy()
    expect((await B.c.from('transaction_mutations').delete().eq('mutation_id', crypto.randomUUID())).error).toBeTruthy()
  })
})

describe('account balance after offline edits equals the server aggregate', () => {
  it('server account_summaries reflects the replayed edit exactly once', async () => {
    const before = ((await A.c.rpc('account_summaries', { p_wallet_id: WA })).data as { account_id: string; current_balance_minor: number }[]).find((r) => r.account_id === cashA)!.current_balance_minor
    const row = await seed(B, { amount_minor: 10000 })
    await queueEdit(B, row, tx({ amount_minor: 25000 }))
    await run(B)
    const after = ((await A.c.rpc('account_summaries', { p_wallet_id: WA })).data as { account_id: string; current_balance_minor: number }[]).find((r) => r.account_id === cashA)!.current_balance_minor
    expect(before - after).toBe(25000) // the row now counts 250.00 once (it did not exist at `before`)
  })
})

describe('version semantics, spoofing and account locking through the RPC', () => {
  it('a no-op update does not move the version; a real change moves it exactly once', async () => {
    const row = await seed(B)
    await createTransactionService(B.c).update(row.id, 1, tx()) // same values
    expect(state(row.id)).toMatchObject({ v: '1' })
    await createTransactionService(B.c).update(row.id, 1, tx({ amount_minor: 51000 }))
    expect(state(row.id)).toMatchObject({ amt: '51000', v: '2' })
  })
  it('spoofed wallet_id / created_by / version in the payload are ignored, a foreign wallet account is rejected', async () => {
    const row = await seed(B)
    const spoof = { ...tx({ amount_minor: 52000 }), wallet_id: crypto.randomUUID(), created_by: A.id, version: 99, paid_by_user_id: A.id }
    await B.c.rpc('apply_transaction_mutation', { p_mutation_id: crypto.randomUUID(), p_op: 'UPDATE', p_transaction_id: row.id, p_expected_version: 1, p_payload: spoof, p_own_only: true })
    const s = sql<{ w: string; cb: string; v: string }>(`select wallet_id::text w, created_by::text cb, version::text v from public.transactions where id='${row.id}'`)[0]!
    expect(s).toEqual({ w: WA, cb: B.id, v: '2' })
    const foreign = await B.c.rpc('apply_transaction_mutation', { p_mutation_id: crypto.randomUUID(), p_op: 'UPDATE', p_transaction_id: row.id, p_expected_version: 2, p_payload: tx({ account_id: crypto.randomUUID() }), p_own_only: true })
    expect(foreign.error).toBeTruthy()
  })
  it('account locking still holds for a transfer that was edited via the RPC, and unlocks after RPC delete', async () => {
    const dest = crypto.randomUUID()
    expect((await A.c.from('accounts').insert({ id: dest, wallet_id: WA, name: 'Dest', type: 'cash', opening_balance_minor: 0 })).error).toBeNull()
    const row = await seed(B, { type: 'transfer', destination_account_id: dest, category_id: null, amount_minor: 1000 })
    await createTransactionService(B.c).update(row.id, 1, tx({ type: 'transfer', destination_account_id: dest, category_id: null, amount_minor: 2000 }))
    for (const a of [cashA, dest]) {
      expect((await A.c.from('accounts').update({ type: 'bank' }).eq('id', a).select()).error?.message).toMatch(/has transactions/)
      expect(((await A.c.from('accounts').delete().eq('id', a).select()).data ?? []).length).toBe(0)
    }
    await createTransactionService(B.c).remove(row.id, 2)
    expect((await A.c.from('accounts').delete().eq('id', dest).select()).data).toHaveLength(1)
  })
})

describe('Phase 12B: definer authorization and information hygiene', () => {
  const rpc = (u: { c: SupabaseClient }, op: 'UPDATE' | 'DELETE', id: string, v: number, payload: unknown = tx(), own = false) =>
    u.c.rpc('apply_transaction_mutation', { p_mutation_id: crypto.randomUUID(), p_op: op, p_transaction_id: id, p_expected_version: v, p_payload: op === 'UPDATE' ? payload : null, p_own_only: own })
  it('anonymous cannot execute the RPC', async () => {
    const anon = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } })
    const r = await rpc({ c: anon }, 'DELETE', crypto.randomUUID(), 1)
    expect(r.error).toBeTruthy()
    expect(r.data).toBeNull()
  })
  it('a non-member learns nothing: UPDATE -> CONFLICT/not_found, DELETE -> ALREADY_GONE, row untouched', async () => {
    const row = await seed(A)
    await createTransactionService(A.c).update(row.id, 1, tx({ amount_minor: 51000 })) // v2
    expect((await rpc(C, 'UPDATE', row.id, 1)).data).toEqual({ status: 'CONFLICT', reason: 'not_found' })
    expect((await rpc(C, 'DELETE', row.id, 2)).data).toEqual({ status: 'ALREADY_GONE' })
    expect(state(row.id)).toMatchObject({ n: 1, amt: '51000', v: '2' })
  })
  it('a member without permission gets FORBIDDEN and no version', async () => {
    const row = await seed(A)
    expect((await rpc(B, 'UPDATE', row.id, 99)).data).toEqual({ status: 'FORBIDDEN' })
    expect((await rpc(B, 'DELETE', row.id, 1)).data).toEqual({ status: 'FORBIDDEN' })
    expect(state(row.id)).toMatchObject({ n: 1, v: '1' })
  })
  it('an account from a foreign wallet cannot be used to move a transaction there', async () => {
    const WB = ((await C.c.rpc('create_wallet', { p_name: `${tag}-WB` })).data as { id: string }).id
    const accB = crypto.randomUUID()
    expect((await C.c.from('accounts').insert({ id: accB, wallet_id: WB, name: 'Cash', type: 'cash', opening_balance_minor: 0 })).error).toBeNull()
    const row = await seed(B)
    const r = await rpc(B, 'UPDATE', row.id, 1, tx({ account_id: accB }), true)
    expect(r.error?.message).toMatch(/cannot move between wallets/)
    expect((await rpc(C, 'UPDATE', row.id, 1, tx({ account_id: accB }))).data).toEqual({ status: 'CONFLICT', reason: 'not_found' })
    expect(sql<{ w: string }>(`select wallet_id::text w from public.transactions where id='${row.id}'`)[0]!.w).toBe(WA)
    expect(state(row.id)).toMatchObject({ amt: '50000', v: '1' })
  })
  it('the function is definer with an empty search_path and only authenticated may execute it', () => {
    const f = sql<{ prosecdef: boolean; cfg: string[]; anon: boolean; auth: boolean; pub: boolean }>(
      `select prosecdef, proconfig cfg,
         has_function_privilege('anon', oid, 'execute') anon, has_function_privilege('authenticated', oid, 'execute') auth,
         has_function_privilege('public', oid, 'execute') pub
       from pg_proc where proname = 'apply_transaction_mutation'`)[0]!
    expect(f).toMatchObject({ prosecdef: true, cfg: ['search_path=""'], anon: false, auth: true, pub: false })
  })
})

describe('Phase 12B: direct table mutation is closed', () => {
  it('direct UPDATE and DELETE are denied to members and owners on every column, including via upsert; the data is untouched', async () => {
    const row = await seed(B)
    for (const u of [B, A]) {
      for (const patch of [{ amount_minor: 1 }, { note: 'x' }, { version: 99 }]) {
        const r = await u.c.from('transactions').update(patch).eq('id', row.id).select()
        expect(r.error?.message, JSON.stringify(patch)).toMatch(/permission denied/)
      }
      expect((await u.c.from('transactions').delete().eq('id', row.id).select()).error?.message).toMatch(/permission denied/)
    }
    const up = await B.c.from('transactions').upsert({ id: row.id, account_id: cashA, category_id: catA, type: 'expense', amount_minor: 1, date: D })
    expect(up.error).toBeTruthy()
    expect(state(row.id)).toMatchObject({ n: 1, amt: '50000', v: '1' })
    // the RPC still works for the same caller
    await createTransactionService(B.c).update(row.id, 1, tx({ amount_minor: 52000 }))
    expect(state(row.id)).toMatchObject({ amt: '52000', v: '2' })
  })
  it('grants: authenticated and anon have no UPDATE/DELETE on transactions or INSERT on the ledger; SELECT and INSERT remain', () => {
    const g = sql<{ priv: string; grantee: string }>(
      `select privilege_type priv, grantee from information_schema.role_table_grants where table_schema='public' and table_name='transactions' and grantee in ('anon','authenticated')
       union all select privilege_type || ':ledger', grantee from information_schema.role_table_grants where table_schema='public' and table_name='transaction_mutations' and grantee in ('anon','authenticated')`)
    const have = (r: string, p: string) => g.some((x) => x.grantee === r && x.priv === p)
    for (const role of ['anon', 'authenticated']) for (const p of ['UPDATE', 'DELETE', 'INSERT:ledger', 'UPDATE:ledger', 'DELETE:ledger']) expect(have(role, p), `${role} ${p}`).toBe(false)
    expect(have('authenticated', 'SELECT')).toBe(true)
    const cols = sql<{ n: number }>(`select count(*)::int n from information_schema.column_privileges where table_schema='public' and table_name='transactions' and privilege_type='UPDATE' and grantee in ('anon','authenticated')`)[0]!.n
    expect(cols).toBe(0)
  })
})

