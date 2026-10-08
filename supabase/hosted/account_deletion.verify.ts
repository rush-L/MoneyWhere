// Hosted verification for Phase D9 (account deletion). NOT part of `npm test` (touches the real DEV project).
// Run: npx vitest run --config supabase/hosted/vitest.hosted.config.ts supabase/hosted/account_deletion
// Proves what PGlite cannot: the SECURITY DEFINER function really deletes from Supabase's auth.users (and Auth's own
// dependent tables), the old token stops working, concurrent joins are never silently lost, and the volume cost.
// Users are real anon-key clients created for this run; the Management API is used only to inspect and to clean up.
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertDevProject } from './guard.mjs'

assertDevProject()

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
)
const dir = mkdtempSync(join(tmpdir(), 'mwverify-'))
function sql<T = Record<string, unknown>>(q: string): T[] {
  const f = join(dir, 'q.sql')
  writeFileSync(f, q)
  const out = execFileSync('npx', ['supabase', 'db', 'query', '--linked', '-f', f], { encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024 })
  return JSON.parse(out.slice(out.indexOf('{'))).rows
}

// vitest hides console output in non-interactive runs, so measurements and race outcomes go to a file too.
const LOG = join(tmpdir(), 'd9-hosted.log')
const note = (...a: unknown[]) => {
  console.log(...a)
  appendFileSync(LOG, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n')
}
const tag = `mwdel${Date.now()}`
const PW = `Tx!${Math.random().toString(36).slice(2)}Aa1`
const VOLUME = 5000
const anon = () => createClient(env.VITE_SUPABASE_URL!, env.VITE_SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } })
type U = { c: SupabaseClient; id: string; token: string }
async function user(n: string): Promise<U> {
  const c = anon()
  const { data, error } = await c.auth.signUp({ email: `reambillo.russel+${tag}${n}@gmail.com`, password: PW })
  if (error || !data.session) throw new Error(`signup ${n}: ${error?.message ?? 'no session'}`)
  return { c, id: data.user!.id, token: data.session.access_token }
}
const mkWallet = async (u: U, name: string) => {
  const { data, error } = await u.c.rpc('create_wallet', { p_name: name })
  if (error) throw error
  return (data as { id: string }).id
}
const join_ = async (owner: U, w: string, m: U) => {
  const inv = await owner.c.rpc('create_wallet_invitation', { p_wallet_id: w })
  if (inv.error) throw inv.error
  const r = await m.c.rpc('accept_wallet_invitation', { p_token: (inv.data as { token: string }).token })
  if (r.error || !(r.data as { ok: boolean }).ok) throw new Error('join failed')
}
async function walletKit(u: U, w: string) {
  const acc = crypto.randomUUID()
  const a = await u.c.from('accounts').insert({ id: acc, wallet_id: w, name: 'Cash', type: 'cash', opening_balance_minor: 0 })
  if (a.error) throw a.error
  const cat = (await u.c.from('categories').select('id').eq('wallet_id', w).limit(1).single()).data!.id as string
  return { acc, cat }
}
const addTx = async (u: U, kit: { acc: string; cat: string }, paid?: string) => {
  const id = crypto.randomUUID()
  const r = await u.c.from('transactions').insert({ id, account_id: kit.acc, category_id: kit.cat, type: 'expense', amount_minor: 100, date: '2026-10-05', ...(paid ? { paid_by_user_id: paid } : {}) })
  if (r.error) throw r.error
  return id
}
const tx = (id: string) => sql<{ created_by: string | null; paid_by_user_id: string | null; version: number }>(`select created_by, paid_by_user_id, version from public.transactions where id='${id}'`)[0]!
const authRows = (id: string) =>
  sql<Record<string, number>>(`select (select count(*) from auth.users where id='${id}')::int users, (select count(*) from auth.identities where user_id='${id}')::int identities,
    (select count(*) from auth.sessions where user_id='${id}')::int sessions, (select count(*) from auth.refresh_tokens where user_id='${id}')::int refresh,
    (select count(*) from public.profiles where id='${id}')::int profiles`)[0]!
/** Bulk-insert as `uid` through the real triggers (created_by comes from auth.uid(), which the claim below provides). */
const bulk = (uid: string, kit: { acc: string; cat: string }, n: number) =>
  sql(`do $$ begin perform set_config('request.jwt.claim.sub', '${uid}', true);
    insert into public.transactions (id, account_id, category_id, type, amount_minor, date, note)
    select gen_random_uuid(), '${kit.acc}', '${kit.cat}', 'expense', 100, '2026-10-05', 'vol' from generate_series(1, ${n}); end $$; select 1 as ok;`)

let S: U, A: U, B: U, C: U, A1: U, B1: U, A2: U, B2: U, A3: U, B3: U, N: { c: SupabaseClient }
let WS: string, WA: string
const created: string[] = []
const all = () => [S, A, B, C, A1, B1, A2, B2, A3, B3].filter(Boolean)

beforeAll(async () => {
  ;[S, A, B, C, A1, B1, A2, B2, A3, B3] = [await user('s'), await user('a'), await user('b'), await user('c'), await user('a1'), await user('b1'), await user('a2'), await user('b2'), await user('a3'), await user('b3')]
  N = { c: anon() }
}, 240_000)

afterAll(() => {
  const ids = created.map((i) => `'${i}'`).join(',')
  const uids = all().map((u) => `'${u.id}'`).join(',')
  if (ids) sql(`delete from public.wallets where id in (${ids})`)
  sql(`delete from public.wallets where name like '${tag}%'`)
  if (uids) sql(`delete from auth.users where id in (${uids})`)
  note('CLEANUP leftover', sql(`select (select count(*) from public.wallets where name like '${tag}%')::int w, (select count(*) from auth.users where email like '%${tag}%')::int u`)[0], 'tag', tag)
}, 180_000)

describe('surface (hosted)', () => {
  it('signed-out callers and the internal helper are refused; the signature takes no user id', async () => {
    expect((await N.c.rpc('account_deletion_preview')).error).toBeTruthy()
    expect((await N.c.rpc('delete_my_account', { p_confirmed_wallet_ids: [] })).error).toBeTruthy()
    expect((await A.c.rpc('account_deletion_plan', { p_uid: B.id })).error?.message).toMatch(/permission denied|not found|could not find/i)
    expect((await A.c.rpc('delete_my_account', { p_confirmed_wallet_ids: [], p_user_id: B.id })).error).toBeTruthy()
    expect(authRows(B.id).users).toBe(1) // nothing happened to B
  })
})

describe('owner of a shared wallet is blocked; nothing changes (hosted)', () => {
  it('preview names the wallet, delete refuses, wrong confirmed list is "changed"', async () => {
    WA = await mkWallet(A, `${tag}-shared`)
    created.push(WA)
    await join_(A, WA, B); await join_(A, WA, C)
    const p = await A.c.rpc('account_deletion_preview')
    expect(p.error).toBeNull()
    expect(p.data).toMatchObject({ blocking: [{ id: WA, name: `${tag}-shared`, other_members: 2 }], will_delete: [], leaving: [] })
    const d = await A.c.rpc('delete_my_account', { p_confirmed_wallet_ids: [] })
    expect(d.error).toBeNull()
    expect(d.data).toMatchObject({ ok: false, reason: 'blocked' })
    expect((await B.c.rpc('delete_my_account', { p_confirmed_wallet_ids: [WA] })).data).toEqual({ ok: false, reason: 'changed' })
    expect(authRows(A.id).users).toBe(1)
    expect(authRows(B.id).users).toBe(1)
  })
})

describe('member leaves by deleting the account: real triggers, real auth.users (hosted)', () => {
  let kit: { acc: string; cat: string }
  let bothB: string, aPaidB: string, bPaidC: string
  it('anonymizes without copying creator into payer; the auth user, identities, sessions, tokens and profile are gone', async () => {
    kit = await walletKit(A, WA)
    bothB = await addTx(B, kit)
    aPaidB = await addTx(A, kit, B.id)
    bPaidC = await addTx(B, kit, C.id)
    const v0 = tx(aPaidB).version
    expect(authRows(B.id)).toMatchObject({ users: 1, profiles: 1 })
    const t0 = Date.now()
    const r = await B.c.rpc('delete_my_account', { p_confirmed_wallet_ids: [] })
    note('member delete ms', Date.now() - t0)
    expect(r.error).toBeNull()
    expect(r.data).toEqual({ ok: true })
    expect(authRows(B.id)).toEqual({ users: 0, identities: 0, sessions: 0, refresh: 0, profiles: 0 })
    expect(tx(bothB)).toMatchObject({ created_by: null, paid_by_user_id: null })
    expect(tx(aPaidB)).toMatchObject({ created_by: A.id, paid_by_user_id: null, version: v0 + 1 })
    expect(tx(bPaidC)).toMatchObject({ created_by: null, paid_by_user_id: C.id })
    expect(sql(`select 1 from public.wallet_members where user_id='${B.id}'`)).toHaveLength(0)
    expect(sql(`select 1 from public.wallets where id='${WA}'`)).toHaveLength(1)
  })
  it('the deleted user\'s still-valid token does nothing useful, and cannot be refreshed', async () => {
    const wallets = await B.c.from('wallets').select('id')
    expect(wallets.data ?? []).toHaveLength(0) // no membership left
    expect((await B.c.rpc('create_wallet', { p_name: `${tag}-ghost` })).error).toBeTruthy() // FK to auth.users
    expect((await B.c.auth.refreshSession()).error).toBeTruthy()
    expect((await B.c.rpc('delete_my_account', { p_confirmed_wallet_ids: [] })).data).toEqual({ ok: true }) // idempotent, still harmless
    expect(sql(`select 1 from public.wallets where name='${tag}-ghost'`)).toHaveLength(0)
  })
  it('the owner edits an anonymized row: the payer stays NULL unless explicitly set to a CURRENT member', async () => {
    const m = (op: Record<string, unknown>) =>
      A.c.rpc('apply_transaction_mutation', { p_mutation_id: crypto.randomUUID(), p_op: 'UPDATE', p_transaction_id: aPaidB, p_expected_version: tx(aPaidB).version, p_payload: { type: 'expense', account_id: kit.acc, destination_account_id: null, category_id: kit.cat, amount_minor: 250, date: '2026-10-05', note: 'edited', ...op }, p_own_only: false })
    expect((await m({})).data).toMatchObject({ status: 'APPLIED' })
    expect(tx(aPaidB).paid_by_user_id).toBeNull()
    expect((await m({ paid_by_user_id: B.id })).error?.code).toBe('42501') // the deleted user
    expect((await m({ paid_by_user_id: crypto.randomUUID() })).error?.code).toBe('42501') // unknown
    expect(tx(aPaidB).paid_by_user_id).toBeNull()
    expect((await m({ paid_by_user_id: C.id })).data).toMatchObject({ status: 'APPLIED' })
    expect(tx(aPaidB).paid_by_user_id).toBe(C.id)
  })
  it('a plain member cannot edit an anonymized row (FORBIDDEN, not a conflict)', async () => {
    const r = await C.c.rpc('apply_transaction_mutation', { p_mutation_id: crypto.randomUUID(), p_op: 'DELETE', p_transaction_id: bothB, p_expected_version: tx(bothB).version, p_payload: null, p_own_only: false })
    expect(r.data).toMatchObject({ status: 'FORBIDDEN' })
  })
})

describe('concurrency: a join racing the owner\'s deletion is never silently destroyed (hosted)', () => {
  // [label, owner, joiner, ms before the delete starts, ms before the accept starts]
  const cases = [['accept first', 1, 30, 0], ['simultaneous', 2, 0, 0], ['delete first', 3, 0, 30]] as const
  for (const [label, pair, delDelay, accDelay] of cases) {
    it(label, async () => {
      const [O, J] = ({ 1: [A1, B1], 2: [A2, B2], 3: [A3, B3] } as const)[pair] // users exist only after beforeAll
      const W = await mkWallet(O, `${tag}-race-${label.replace(' ', '')}`)
      created.push(W)
      const inv = await O.c.rpc('create_wallet_invitation', { p_wallet_id: W })
      expect(inv.error).toBeNull()
      const token = (inv.data as { token: string }).token
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
      const [del, acc] = await Promise.all([
        (async () => { await wait(delDelay); return O.c.rpc('delete_my_account', { p_confirmed_wallet_ids: [W] }) })(),
        (async () => { await wait(accDelay); return J.c.rpc('accept_wallet_invitation', { p_token: token }) })(),
      ])
      const deleted = (del.data as { ok?: boolean } | null)?.ok === true
      const joined = (acc.data as { ok?: boolean } | null)?.ok === true
      note('race', label, { delete: del.data ?? del.error?.message, accept: acc.data ?? acc.error?.message })
      const wallet = sql(`select 1 from public.wallets where id='${W}'`).length
      const member = sql(`select 1 from public.wallet_members where wallet_id='${W}' and user_id='${J.id}'`).length
      if (deleted) {
        // wallet gone: the joiner must not have been told they joined something that no longer exists
        expect(wallet).toBe(0)
        expect(member).toBe(0)
        expect(joined).toBe(false)
      } else {
        // the join won: the wallet and the new member are intact and deletion was refused, not executed
        expect(wallet).toBe(1)
        expect(member).toBe(1)
        expect(joined).toBe(true)
        expect(del.data).toMatchObject({ ok: false })
        expect(authRows(O.id).users).toBe(1)
      }
    })
  }
})

describe('sole-member wallet, with volume (hosted)', () => {
  it(`deletes ${VOLUME} transactions with the wallet and the account; timing is recorded`, async () => {
    WS = await mkWallet(S, `${tag}-solo`)
    created.push(WS)
    const kit = await walletKit(S, WS)
    bulk(S.id, kit, VOLUME)
    expect(Number(sql<{ n: number }>(`select count(*)::int n from public.transactions where wallet_id='${WS}'`)[0]!.n)).toBe(VOLUME)
    const p = await S.c.rpc('account_deletion_preview')
    expect(p.data).toMatchObject({ will_delete: [{ id: WS }] })
    const t0 = Date.now()
    const r = await S.c.rpc('delete_my_account', { p_confirmed_wallet_ids: [WS] })
    note(`SOLE wallet delete (${VOLUME} tx) ms`, Date.now() - t0, r.error?.message ?? '')
    expect(r.error).toBeNull()
    expect(r.data).toEqual({ ok: true })
    expect(authRows(S.id)).toEqual({ users: 0, identities: 0, sessions: 0, refresh: 0, profiles: 0 })
    expect(sql(`select 1 from public.wallets where id='${WS}'`)).toHaveLength(0)
    expect(sql(`select 1 from public.transactions where wallet_id='${WS}'`)).toHaveLength(0)
  })
})

describe('shared wallet anonymization with volume (hosted)', () => {
  it(`anonymizes ${VOLUME} rows of a leaving member within the request limits`, async () => {
    // C (still a member of WA) leaves; give C many rows first, created through the real triggers.
    const kit = { acc: sql<{ id: string }>(`select id from public.accounts where wallet_id='${WA}' limit 1`)[0]!.id, cat: sql<{ id: string }>(`select id from public.categories where wallet_id='${WA}' limit 1`)[0]!.id }
    bulk(C.id, kit, VOLUME)
    const t0 = Date.now()
    const r = await C.c.rpc('delete_my_account', { p_confirmed_wallet_ids: [] })
    note(`SHARED anonymize (${VOLUME}+ rows) ms`, Date.now() - t0, r.error?.message ?? '')
    expect(r.error).toBeNull()
    expect(r.data).toEqual({ ok: true })
    expect(Number(sql<{ n: number }>(`select count(*)::int n from public.transactions where wallet_id='${WA}' and (created_by is null) and note='vol'`)[0]!.n)).toBe(VOLUME)
    expect(authRows(C.id).users).toBe(0)
  })
})
