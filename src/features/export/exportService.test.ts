import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { ExportError, loadExport } from './exportService'

const ME = 'me'
type Tables = Record<string, unknown[]>

/** Minimal PostgREST stand-in: filters are ignored (one wallet), but `.range()` pages exactly like the real server. */
function fakeClient(tables: Tables, opts: { failOn?: string } = {}) {
  const calls: Record<string, number> = {}
  const from = (table: string) => {
    let slice: [number, number] | null = null
    const result = () => {
      calls[table] = (calls[table] ?? 0) + 1
      if (opts.failOn === table) return Promise.resolve({ data: null, error: { code: 'x', message: 'boom' } })
      const rows = tables[table] ?? []
      return Promise.resolve({ data: slice ? rows.slice(slice[0], slice[1] + 1) : rows, error: null })
    }
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'order', 'gte', 'lt']) b[m] = () => b
    b.range = (a: number, z: number) => ((slice = [a, z]), b)
    b.returns = result
    b.maybeSingle = () => result().then((r) => ({ ...r, data: (r.data as unknown[] | null)?.[0] ?? null }))
    return b
  }
  const rpc = (fn: string) => Promise.resolve({ data: tables[fn] ?? [], error: null })
  return { client: { from, rpc } as unknown as SupabaseClient, calls }
}

const wallets = [{ id: 'w1', name: 'Home', currency: 'PHP', mode: 'shared_log', created_at: '2026-01-01', wallet_members: [{ role: 'owner' }] }]
const base = (extra: Tables = {}): Tables => ({
  profiles: [{ id: ME, display_name: 'Me', avatar_url: null, created_at: 'a', updated_at: 'b' }],
  wallets,
  list_wallet_members: [{ user_id: ME, role: 'owner', joined_at: 'x', display_name: 'Me', avatar_url: null }],
  account_summaries: [],
  categories: [],
  budgets: [],
  transactions: [],
  ...extra,
})
const txRows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `t${i}`, account_id: 'a1', destination_account_id: null, category_id: 'c1', type: 'expense', amount_minor: i + 1,
    date: '2026-10-01', note: null, created_by: ME, paid_by_user_id: ME, version: 1,
  }))
const budgetRows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `b${i}`, wallet_id: 'w1', category_id: 'c1', month: '2026-10-01', amount_minor: i + 1 }))

describe('loadExport', () => {
  it('exports every one of 2,500 transactions and 1,200 budgets (paged past the 1000-row cap)', async () => {
    const { client, calls } = fakeClient(base({ transactions: txRows(2500), budgets: budgetRows(1200) }))
    const doc = await loadExport(client, ME)
    expect(doc.counts.transactions).toBe(2500)
    expect(doc.counts.budgets).toBe(1200)
    expect(new Set(doc.wallets[0]!.transactions.map((t) => t.id)).size).toBe(2500)
    expect(calls.transactions).toBe(3)
    expect(calls.budgets).toBe(2)
  })
  it('exactly 1000 rows needs a second, empty page and still returns all of them', async () => {
    const doc = await loadExport(fakeClient(base({ transactions: txRows(1000) })).client, ME)
    expect(doc.counts.transactions).toBe(1000)
  })
  it('reports progress and builds the envelope from the signed-in user', async () => {
    const seen: string[] = []
    const doc = await loadExport(fakeClient(base()).client, ME, (p) => seen.push(p.label))
    expect(doc.exported_by).toBe(ME)
    expect(doc.profile.display_name).toBe('Me')
    expect(seen.length).toBeGreaterThanOrEqual(3)
  })
  it('a failed read fails the whole export with a safe message (never a partial file)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(loadExport(fakeClient(base({ transactions: txRows(3) }), { failOn: 'transactions' }).client, ME)).rejects.toThrow(ExportError)
    spy.mockRestore()
  })
})
