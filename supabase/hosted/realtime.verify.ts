// Hosted verification for Phase 10 (Realtime invalidation). NOT part of `npm test` (touches the real dev project).
// Run: npx vitest run --config supabase/hosted/vitest.hosted.config.ts supabase/hosted/realtime.verify.ts
// Anon-key users only (RLS + realtime.messages policy apply); the Management API is used only for membership + cleanup.
// Real websockets (Node's global WebSocket) against the hosted Realtime service.
import { execFileSync } from 'node:child_process'
import { rpcDel, rpcUpd } from './mutate'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { subscribeWalletChanges } from '../../src/features/offline/realtime/walletChanges'
import type { NewTransaction } from '../../src/features/transactions/transaction'
import { createTransactionService } from '../../src/features/transactions/transactionService'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
)
const URL = env.VITE_SUPABASE_URL!
const KEY = env.VITE_SUPABASE_ANON_KEY!
const dir = mkdtempSync(join(tmpdir(), 'mwrt-'))
function sql<T = Record<string, unknown>>(q: string): T[] {
  const f = join(dir, 'q.sql')
  writeFileSync(f, q)
  const out = execFileSync('npx', ['supabase', 'db', 'query', '--linked', '-f', f], { encoding: 'utf8', shell: true })
  return JSON.parse(out.slice(out.indexOf('{'))).rows
}
const tag = `mwrt${Date.now()}`
const PW = `Rt!${Math.random().toString(36).slice(2)}Aa1`
type U = { c: SupabaseClient; id: string }
async function user(n: string): Promise<U> {
  const c = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await c.auth.signUp({ email: `reambillo.russel+${tag}${n}@gmail.com`, password: PW })
  if (error || !data.session) throw new Error(`signup ${n}: ${error?.message ?? 'no session'}`)
  return { c, id: data.user!.id }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 10_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (cond()) return true
  return cond()
}
/** Raw join of a topic as `u`, counting every broadcast received. */
async function joinTopic(u: U, topic: string, priv: boolean) {
  await u.c.realtime.setAuth()
  const got: unknown[] = []
  const ch: RealtimeChannel = u.c.channel(topic, { config: { private: priv } })
  ch.on('broadcast', { event: 'tx_changed' }, (m) => got.push(m))
  const status = await new Promise<string>((res) => ch.subscribe((s) => ['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(s) && res(s)))
  return { ch, got, status }
}

let A: U, B: U, C: U, WA: string, WB: string, cash: string, bank: string, cat: string, accB: string
const created: string[] = []
const D = '2026-10-10'
const nt = (o: Partial<NewTransaction> = {}): NewTransaction => ({ type: 'expense', account_id: cash, destination_account_id: null, category_id: cat, amount_minor: 5000, date: D, note: null, ...o })
const acct = async (u: U, w: string, name: string) => {
  const id = crypto.randomUUID()
  const { error } = await u.c.from('accounts').insert({ id, wallet_id: w, name, type: 'cash', opening_balance_minor: 0 })
  if (error) throw error
  return id
}

beforeAll(async () => {
  A = await user('a'); B = await user('b'); C = await user('c')
  const w = async (u: U, name: string) => ((await u.c.rpc('create_wallet', { p_name: name })).data as { id: string }).id
  WA = await w(A, `${tag}-WA`); WB = await w(C, `${tag}-WB`)
  created.push(WA, WB)
  sql(`insert into public.wallet_members (wallet_id, user_id, role) values ('${WA}','${B.id}','member')`)
  cash = await acct(A, WA, 'Cash'); bank = await acct(A, WA, 'Bank'); accB = await acct(C, WB, 'C acct')
  cat = (await A.c.from('categories').select('id').eq('wallet_id', WA).eq('name', 'Groceries').single()).data!.id as string
}, 120_000)

afterAll(async () => {
  for (const u of [A, B, C]) await u?.c.removeAllChannels()
  const ids = created.map((i) => `'${i}'`).join(',')
  const uids = [A, B, C].filter(Boolean).map((u) => `'${u.id}'`).join(',')
  if (ids) sql(`delete from public.wallets where id in (${ids})`)
  if (uids) sql(`delete from auth.users where id in (${uids})`)
  console.log('CLEANUP leftover', sql(`select (select count(*) from public.wallets where name like '${tag}%')::int w, (select count(*) from auth.users where email like '%${tag}%')::int u`)[0], 'tag', tag)
}, 120_000)

describe('member A watching WA (through the app module) is notified of B changes', () => {
  let hits = 0
  let off: () => void
  const statuses: string[] = []
  const svcB = () => createTransactionService(B.c)
  const bump = async (action: () => Promise<unknown>) => {
    const before = hits
    await action()
    expect(await until(() => hits > before)).toBe(true)
  }
  it('connects', async () => {
    off = subscribeWalletChanges(A.c, WA, () => hits++, (s) => statuses.push(s))
    expect(await until(() => statuses.includes('CONNECTED'))).toBe(true)
  })
  for (const kind of ['expense', 'income', 'transfer'] as const) {
    it(`${kind}: INSERT, UPDATE, DELETE each notify`, async () => {
      const id = crypto.randomUUID()
      const p = kind === 'expense' ? nt() : kind === 'income' ? nt({ type: 'income', category_id: null }) : nt({ type: 'transfer', category_id: null, destination_account_id: bank })
      await bump(() => svcB().send(id, B.id, p))
      await bump(async () => expect((await rpcUpd(B.c, id, { amount_minor: 7777 })).data).toHaveLength(1))
      await bump(async () => expect((await rpcDel(B.c, id)).data).toHaveLength(1))
    })
  }
  it('own write by A also notifies A (the page reloads once, read-only)', async () => {
    await bump(() => createTransactionService(A.c).send(crypto.randomUUID(), A.id, nt()))
  })
  it('after A unsubscribes (wallet switch / logout) no channel remains and WA events no longer arrive', async () => {
    off()
    await sleep(500)
    expect(A.c.getChannels()).toHaveLength(0)
    const before = hits
    await svcB().send(crypto.randomUUID(), B.id, nt())
    await sleep(4000)
    expect(hits).toBe(before)
  })
})

describe('isolation', () => {
  afterEach(async () => {
    for (const u of [A, B, C]) await u.c.removeAllChannels() // the same topic cannot be joined twice on one client
  })
  it('non-member C cannot join private wallet:WA and receives nothing', async () => {
    const r = await joinTopic(C, `wallet:${WA}`, true)
    expect(r.status).not.toBe('SUBSCRIBED')
    await B.c.from('transactions').insert({ id: crypto.randomUUID(), account_id: cash, category_id: cat, type: 'expense', amount_minor: 1, date: D })
    await sleep(4000)
    expect(r.got).toHaveLength(0)
  })
  it('non-member C on a NON-private wallet:WA topic receives nothing (messages are private-only)', async () => {
    const r = await joinTopic(C, `wallet:${WA}`, false)
    await B.c.from('transactions').insert({ id: crypto.randomUUID(), account_id: cash, category_id: cat, type: 'expense', amount_minor: 1, date: D })
    await sleep(4000)
    expect(r.got).toHaveLength(0)
  })
  it('A in WA gets nothing when C writes to WB; C does get its own wallet', async () => {
    const a = await joinTopic(A, `wallet:${WA}`, true)
    const c = await joinTopic(C, `wallet:${WB}`, true)
    expect([a.status, c.status]).toEqual(['SUBSCRIBED', 'SUBSCRIBED'])
    const id = crypto.randomUUID()
    await createTransactionService(C.c).send(id, C.id, { type: 'income', account_id: accB, destination_account_id: null, category_id: null, amount_minor: 100, date: D, note: null })
    await rpcDel(C.c, id)
    expect(await until(() => c.got.length >= 2)).toBe(true)
    await sleep(3000)
    expect(a.got).toHaveLength(0)
  })
  it('a client cannot publish into a wallet topic (no insert policy)', async () => {
    const a = await joinTopic(A, `wallet:${WA}`, true)
    const b = await joinTopic(B, `wallet:${WA}`, true)
    await a.ch.send({ type: 'broadcast', event: 'tx_changed', payload: { op: 'FAKE' } })
    await sleep(4000)
    expect(b.got).toHaveLength(0)
  })
})
