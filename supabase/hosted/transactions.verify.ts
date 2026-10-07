// Hosted verification for Phase 5B. NOT part of `npm test` (touches the real dev project).
// Run: npx vitest run --config supabase/hosted/vitest.hosted.config.ts
// Normal users = anon-key clients that sign up/in. The Management API (`supabase db query --linked`) is used
// only for setup the app has no path for (adding a member), schema inspection, and cleanup.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { rpcDel, rpcUpd } from './mutate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { accountBalance } from '../../src/domain/finance'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
)
const URL = env.VITE_SUPABASE_URL!
const KEY = env.VITE_SUPABASE_ANON_KEY!
const dir = mkdtempSync(join(tmpdir(), 'mwverify-'))

function sql<T = Record<string, unknown>>(q: string): T[] {
  const f = join(dir, 'q.sql')
  writeFileSync(f, q)
  const out = execFileSync('npx', ['supabase', 'db', 'query', '--linked', '-f', f], { encoding: 'utf8', shell: true })
  return JSON.parse(out.slice(out.indexOf('{'))).rows
}

const tag = `mwtx${Date.now()}`
const PW = `Tx!${Math.random().toString(36).slice(2)}Aa1`
const anon = () => createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } })
type U = { c: SupabaseClient; id: string }
async function user(n: string): Promise<U> {
  const c = anon()
  const { data, error } = await c.auth.signUp({ email: `reambillo.russel+${tag}${n}@gmail.com`, password: PW })
  if (error || !data.session) throw new Error(`signup ${n}: ${error?.message ?? 'no session (email confirm on?)'}`)
  return { c, id: data.user!.id }
}
const wallet = async (u: U, name: string) => {
  const { data, error } = await u.c.rpc('create_wallet', { p_name: name })
  if (error) throw error
  return (data as { id: string }).id
}
const mkAcct = async (u: U, w: string, name: string, opening = 0, type = 'cash') => {
  const id = crypto.randomUUID()
  const { error } = await u.c.from('accounts').insert({ id, wallet_id: w, name, type, opening_balance_minor: opening })
  if (error) throw error
  return id
}
const catOf = async (u: U, w: string) => {
  const { data } = await u.c.from('categories').select('id').eq('wallet_id', w).eq('name', 'Groceries').single()
  return data!.id as string
}
const D = '2026-10-10'
const tx = (u: { c: SupabaseClient }, account_id: string, category_id: string | null, o: Record<string, unknown> = {}) => {
  const id = crypto.randomUUID()
  return u.c.from('transactions').insert({ id, account_id, category_id, type: 'expense', amount_minor: 50000, date: D, ...o }).select().then((r) => ({ id, ...r }))
}
const upd = (u: U, id: string, patch: Record<string, unknown>) => rpcUpd(u.c, id, patch)
const del = (u: U, id: string) => rpcDel(u.c, id)
const count = (u: { c: SupabaseClient }, id?: string) =>
  (id ? u.c.from('transactions').select('id').eq('id', id) : u.c.from('transactions').select('id')).then((r) => r.data?.length ?? 0)

let A: U, B: U, D2: U, C: U, N: { c: SupabaseClient }
let WA: string, WB: string, accA: string, accB: string, catA: string, catB: string
const created: string[] = []

beforeAll(async () => {
  A = await user('a')
  B = await user('b')
  D2 = await user('d')
  C = await user('c')
  N = { c: anon() }
  WA = await wallet(A, `${tag}-WalletA`)
  WB = await wallet(C, `${tag}-WalletB`)
  created.push(WA, WB)
  // Membership has no client path yet (invitations are a later phase): setup via admin SQL.
  sql(`insert into public.wallet_members (wallet_id, user_id, role) values ('${WA}','${B.id}','member'),('${WA}','${D2.id}','member')`)
  accA = await mkAcct(A, WA, 'Cash A')
  accB = await mkAcct(C, WB, 'Cash B')
  catA = await catOf(A, WA)
  catB = await catOf(C, WB)
}, 120_000)

afterAll(() => {
  // Wallet delete cascades to members/accounts/categories/transactions; users go last (transactions.created_by has no cascade).
  const ids = created.map((i) => `'${i}'`).join(',')
  const uids = [A, B, D2, C].filter(Boolean).map((u) => `'${u.id}'`).join(',')
  if (ids) sql(`delete from public.wallets where id in (${ids})`)
  if (uids) sql(`delete from auth.users where id in (${uids})`)
  const left = sql<{ w: number; u: number }>(
    `select (select count(*) from public.wallets where name like '${tag}%')::int w, (select count(*) from auth.users where email like '%${tag}%')::int u`,
  )[0]
  console.log('CLEANUP leftover', left, 'tag', tag)
}, 120_000)

describe('3. schema', () => {
  it('table, columns, constraints, RLS, policies, grants', () => {
    const cols = sql<{ column_name: string; data_type: string; is_nullable: string }>(
      `select column_name, data_type, is_nullable from information_schema.columns where table_schema='public' and table_name='transactions' order by ordinal_position`,
    )
    console.log('COLUMNS', JSON.stringify(cols.map((c) => `${c.column_name}:${c.data_type}${c.is_nullable === 'YES' ? '?' : ''}`)))
    const names = cols.map((c) => c.column_name)
    for (const n of ['id', 'wallet_id', 'account_id', 'category_id', 'created_by', 'paid_by_user_id', 'amount_minor', 'type', 'date', 'created_at', 'updated_at'])
      expect(names).toContain(n)
    expect(cols.find((c) => c.column_name === 'id')!.data_type).toBe('uuid')
    const cons = sql<{ conname: string; def: string }>(
      `select conname, pg_get_constraintdef(oid) def from pg_constraint where conrelid='public.transactions'::regclass order by conname`,
    )
    console.log('CONSTRAINTS', JSON.stringify(cons))
    const s = cons.map((c) => c.def).join('\n')
    expect(s).toMatch(/PRIMARY KEY \(id\)/)
    expect(s).toMatch(/FOREIGN KEY \(wallet_id, account_id\) REFERENCES accounts\(wallet_id, id\)/)
    expect(s).toMatch(/FOREIGN KEY \(wallet_id, category_id\) REFERENCES categories\(wallet_id, id\)/)
    expect(s).toMatch(/FOREIGN KEY \(wallet_id\) REFERENCES wallets\(id\) ON DELETE CASCADE/)
    expect(s).toMatch(/FOREIGN KEY \(created_by\) REFERENCES auth.users\(id\)/)
    expect(s).toMatch(/amount_minor >= 1/)
    expect(s).toMatch(/'income'::text, 'expense'::text/)
    const rls = sql<{ relrowsecurity: boolean }>(`select relrowsecurity from pg_class where oid='public.transactions'::regclass`)[0]!
    expect(rls.relrowsecurity).toBe(true)
    const pol = sql<{ policyname: string; cmd: string }>(`select policyname, cmd from pg_policies where tablename='transactions' order by 1`)
    console.log('POLICIES', JSON.stringify(pol))
    expect(pol.length).toBe(4)
    const gr = sql<{ grantee: string; privilege_type: string }>(
      `select grantee, privilege_type from information_schema.role_table_grants where table_name='transactions' and table_schema='public' and grantee in ('anon','authenticated') order by 1,2`,
    )
    console.log('TABLE GRANTS', JSON.stringify(gr))
    expect(gr.filter((g) => g.grantee === 'anon')).toEqual([])
    const fn = sql<{ def: string }>(`select pg_get_functiondef('public.account_has_transactions(uuid)'::regprocedure) def`)[0]!
    expect(fn.def).toContain('public.transactions')
  })
  it('offline-ready: client uuid id, created_at, updated_at (server-generated default)', () => {
    const d = sql<{ column_name: string; column_default: string | null }>(
      `select column_name, column_default from information_schema.columns where table_name='transactions' and table_schema='public' and column_name in ('id','created_at','updated_at')`,
    )
    expect(d.find((x) => x.column_name === 'id')!.column_default).toBeNull() // client-generated
    expect(d.find((x) => x.column_name === 'created_at')!.column_default).toMatch(/now/)
  })
})

describe('3b. constraints (as owner A)', () => {
  it('amount must be positive', async () => {
    expect((await tx(A, accA, catA, { amount_minor: 0 })).error).toBeTruthy()
    expect((await tx(A, accA, catA, { amount_minor: -5 })).error).toBeTruthy()
  })
  it('type restricted', async () => {
    expect((await tx(A, accA, catA, { type: 'transfer' })).error).toBeTruthy()
    expect((await tx(A, accA, catA, { type: 'bogus' })).error).toBeTruthy()
  })
  it('income may have null category; expense requires one', async () => {
    const inc = await tx(A, accA, null, { type: 'income' })
    expect(inc.error).toBeNull()
    expect(inc.data![0]!.category_id).toBeNull()
    expect((await tx(A, accA, null, { type: 'expense' })).error).toBeTruthy()
    await del(A, inc.id)
  })
  it('amount above safe-integer range and 501-char note rejected', async () => {
    expect((await tx(A, accA, catA, { amount_minor: 9007199254740992 })).error).toBeTruthy()
    expect((await tx(A, accA, catA, { note: 'x'.repeat(501) })).error).toBeTruthy()
  })
})

describe('5. owner', () => {
  it('create, read, edit own, edit member, delete own, delete member', async () => {
    const mine = await tx(A, accA, catA)
    expect(mine.error).toBeNull()
    const theirs = await tx(B, accA, catA, { amount_minor: 700 })
    expect(theirs.error).toBeNull()
    expect(await count(A)).toBe(2)
    expect((await upd(A, mine.id, { amount_minor: 123 })).data).toHaveLength(1)
    expect((await upd(A, theirs.id, { amount_minor: 456, note: 'owner edit' })).data).toHaveLength(1)
    expect((await del(A, mine.id)).data).toHaveLength(1)
    expect((await del(A, theirs.id)).data).toHaveLength(1)
    expect(await count(A)).toBe(0)
  })
})

describe('6. member', () => {
  it('create/read/edit own/delete own pass; edit/delete another member or owner is denied', async () => {
    const own = await tx(B, accA, catA)
    expect(own.error).toBeNull()
    const owner = await tx(A, accA, catA, { amount_minor: 111 })
    const other = await tx(D2, accA, catA, { amount_minor: 222 })
    expect(await count(B)).toBe(3) // reads wallet transactions
    expect((await upd(B, own.id, { amount_minor: 999 })).data).toHaveLength(1)
    // denied: 0 rows affected, and row unchanged
    expect((await upd(B, other.id, { amount_minor: 1 })).data).toHaveLength(0)
    expect((await del(B, other.id)).data).toHaveLength(0)
    expect((await upd(B, owner.id, { amount_minor: 1 })).data).toHaveLength(0)
    expect((await del(B, owner.id)).data).toHaveLength(0)
    const still = await A.c.from('transactions').select('id, amount_minor').in('id', [other.id, owner.id])
    expect(still.data!.map((r) => r.amount_minor).sort()).toEqual([111, 222])
    expect((await del(B, own.id)).data).toHaveLength(1)
    // other member can still manage their own
    expect((await del(D2, other.id)).data).toHaveLength(1)
    await del(A, owner.id)
  })
})

describe('7. cross-wallet (A vs Wallet B)', () => {
  it('A cannot read/create/update/delete in Wallet B; cannot mix accounts/categories', async () => {
    const t = await tx(C, accB, catB)
    expect(t.error).toBeNull()
    expect(await count(A, t.id)).toBe(0)
    expect(await count(A)).toBe(0)
    expect((await tx(A, accB, catB)).error).toBeTruthy() // WB account + WB category
    expect((await tx(A, accB, catA)).error).toBeTruthy() // WB account
    const x = await tx(A, accA, catB) // WA account + WB category
    expect(x.error).toBeTruthy()
    const y = await tx(C, accB, catA) // owner of WB using WA category
    expect(y.error).toBeTruthy()
    expect((await upd(A, t.id, { amount_minor: 1 })).data).toHaveLength(0)
    expect((await del(A, t.id)).data).toHaveLength(0)
    expect(await count(C, t.id)).toBe(1)
    // moving an own transaction onto another wallet's account is rejected
    const own = await tx(A, accA, catA)
    expect((await upd(A, own.id, { account_id: accB })).error).toBeTruthy()
    expect((await upd(A, own.id, { category_id: catB })).error).toBeTruthy()
    await del(A, own.id)
    await del(C, t.id)
  })
})

describe('8. anonymous', () => {
  it('select/insert/update/delete all denied', async () => {
    const t = await tx(A, accA, catA)
    expect((await N.c.from('transactions').select('id')).data ?? []).toHaveLength(0)
    expect((await tx(N, accA, catA)).error).toBeTruthy()
    expect((await N.c.from('transactions').update({ amount_minor: 1 }).eq('id', t.id).select()).data ?? []).toHaveLength(0)
    expect((await N.c.rpc('apply_transaction_mutation', { p_mutation_id: crypto.randomUUID(), p_op: 'DELETE', p_transaction_id: t.id, p_expected_version: 1 })).error).toBeTruthy()
    expect((await N.c.from('transactions').delete().eq('id', t.id).select()).data ?? []).toHaveLength(0)
    expect(await count(A, t.id)).toBe(1)
    await del(A, t.id)
  })
})

describe('9. server-controlled fields', () => {
  it('created_by / paid_by_user_id / wallet_id cannot be spoofed on insert or update', async () => {
    for (const spoof of [{ created_by: B.id }, { paid_by_user_id: B.id }, { wallet_id: WB }]) {
      const r = await tx(A, accA, catA, spoof)
      expect(r.error, JSON.stringify(spoof)).toBeTruthy()
    }
    const t = await tx(A, accA, catA)
    expect(t.data![0]).toMatchObject({ created_by: A.id, paid_by_user_id: A.id, wallet_id: WA })
    // update goes through the RPC: identity columns in the payload are not whitelisted, so they are ignored (never applied)
    for (const spoof of [{ created_by: B.id }, { paid_by_user_id: B.id }, { wallet_id: WB }, { id: crypto.randomUUID() }]) await upd(A, t.id, spoof)
    expect((await A.c.from('transactions').select('created_by, paid_by_user_id, wallet_id').eq('id', t.id).single()).data).toEqual({ created_by: A.id, paid_by_user_id: A.id, wallet_id: WA })
    const m = await tx(B, accA, catA) // member's identity is the member, not the owner
    expect(m.data![0]).toMatchObject({ created_by: B.id, paid_by_user_id: B.id })
    await del(A, t.id)
    await del(A, m.id)
  })
})

describe('10. financial behaviour (existing accountBalance is the only calculator)', () => {
  const bal = async (acc: string, opening: number) => {
    const { data } = await A.c.from('transactions').select('id, type, amount_minor, account_id, category_id, date').eq('account_id', acc)
    return accountBalance(acc, opening, data as never)
  }
  it('expense 10,000 - 2,000 = 8,000; income 10,000 + 5,000 = 15,000; mixed = 13,000', async () => {
    const e = await mkAcct(A, WA, 'Exp', 1_000_000)
    expect((await tx(A, e, catA, { amount_minor: 200_000 })).error).toBeNull()
    expect(await bal(e, 1_000_000)).toBe(800_000)
    const i = await mkAcct(A, WA, 'Inc', 1_000_000)
    expect((await tx(A, i, null, { type: 'income', amount_minor: 500_000 })).error).toBeNull()
    expect(await bal(i, 1_000_000)).toBe(1_500_000)
    const m = await mkAcct(A, WA, 'Mix', 1_000_000)
    await tx(A, m, null, { type: 'income', amount_minor: 500_000 })
    await tx(A, m, catA, { amount_minor: 200_000 })
    expect(await bal(m, 1_000_000)).toBe(1_300_000)
  })
})

describe('11/12. category + account behaviour', () => {
  it('category with history cannot be deleted; unused can', async () => {
    const used = await A.c.from('categories').insert({ id: crypto.randomUUID(), wallet_id: WA, name: 'UsedCat' }).select().single()
    const unused = await A.c.from('categories').insert({ id: crypto.randomUUID(), wallet_id: WA, name: 'UnusedCat' }).select().single()
    expect(used.error).toBeNull()
    const t = await tx(A, accA, used.data!.id)
    expect(t.error).toBeNull()
    const r = await A.c.from('categories').delete().eq('id', used.data!.id).select()
    console.log('CATEGORY DELETE WITH HISTORY ->', JSON.stringify({ error: r.error, rows: r.data }))
    expect(r.error?.code === '23503' || r.data?.length === 0).toBe(true)
    expect((await A.c.from('categories').delete().eq('id', unused.data!.id).select()).data).toHaveLength(1)
    await del(A, t.id)
  })
  it('account without history: type/opening editable, deletable; with history: locked, name/holder editable', async () => {
    const free = await mkAcct(A, WA, 'Free', 1000)
    const has = () => A.c.rpc('account_has_transactions', { p_account_id: free })
    console.log('account_has_transactions(no tx) ->', JSON.stringify(await has()))
    expect((await A.c.from('accounts').update({ type: 'bank', opening_balance_minor: 2000 }).eq('id', free).select()).data).toHaveLength(1)
    const gone = await mkAcct(A, WA, 'Gone', 0)
    expect((await A.c.from('accounts').delete().eq('id', gone).select()).data).toHaveLength(1)

    const t = await tx(A, free, catA)
    console.log('account_has_transactions(with tx) ->', JSON.stringify(await has()))
    const typ = await A.c.from('accounts').update({ type: 'cash' }).eq('id', free).select()
    const opn = await A.c.from('accounts').update({ opening_balance_minor: 5 }).eq('id', free).select()
    console.log('LOCK ERRORS', typ.error?.message, '|', opn.error?.message)
    expect(typ.error).toBeTruthy()
    expect(opn.error).toBeTruthy()
    const dl = await A.c.from('accounts').delete().eq('id', free).select()
    expect(dl.error || dl.data!.length === 0).toBeTruthy()
    expect((await A.c.from('accounts').update({ name: 'Renamed', holder: 'Juan' }).eq('id', free).select()).data).toHaveLength(1)
    // removing the history unlocks again
    await del(A, t.id)
    expect((await A.c.from('accounts').delete().eq('id', free).select()).data).toHaveLength(1)
  })
})

describe('14. cascades', () => {
  it('wallet delete removes transactions/accounts/categories/members; account/category with history blocked', async () => {
    const w = await wallet(D2, `${tag}-Cascade`)
    created.push(w)
    const a = await mkAcct(D2, w, 'C', 0)
    const c = await catOf(D2, w)
    expect((await tx(D2, a, c)).error).toBeNull()
    const rc = () => sql<{ t: number; a: number; c: number; m: number }>(
      `select (select count(*) from public.transactions where wallet_id='${w}')::int t,(select count(*) from public.accounts where wallet_id='${w}')::int a,(select count(*) from public.categories where wallet_id='${w}')::int c,(select count(*) from public.wallet_members where wallet_id='${w}')::int m`,
    )[0]!
    expect(rc()).toMatchObject({ t: 1, a: 1, m: 1 })
    const da = await D2.c.from('accounts').delete().eq('id', a).select()
    expect(da.error || da.data!.length === 0).toBeTruthy()
    const dc = await D2.c.from('categories').delete().eq('id', c).select()
    expect(dc.error || dc.data!.length === 0).toBeTruthy()
    const dw = await D2.c.from('wallets').delete().eq('id', w).select()
    expect(dw.error).toBeNull()
    expect(dw.data).toHaveLength(1)
    expect(rc()).toEqual({ t: 0, a: 0, c: 0, m: 0 })
  })
})
