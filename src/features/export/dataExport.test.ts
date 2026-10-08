import { describe, expect, it } from 'vitest'
import type { Account } from '../accounts/account'
import type { TransactionRow } from '../transactions/transaction'
import { buildExport, exportFilename, type ExportInput, type WalletExportInput } from './dataExport'

const ME = 'me'
const BELLA = 'bella'
const GONE = 'gone-raw-id'
const NOW = new Date('2026-10-08T12:34:56.000Z')

const tx = (o: Partial<TransactionRow> & { id: string }): TransactionRow => ({
  account_id: 'a1', destination_account_id: null, category_id: 'c1', type: 'expense', amount_minor: 12345, date: '2026-10-01',
  note: null, created_by: ME, paid_by_user_id: ME, version: 7, ...o,
})
const account = (o: Partial<Account> & { id: string }): Account => ({
  walletId: 'w1', name: 'Cash', type: 'cash', openingBalanceMinor: 1000, holder: 'Me', currency: 'PHP', currentBalanceMinor: 5000, hasTransactions: true, ...o,
})
const wallet: WalletExportInput = {
  wallet: { id: 'w1', name: 'Home', currency: 'PHP', mode: 'shared_log', role: 'owner', createdAt: '2026-01-01T00:00:00Z' },
  members: [
    { userId: ME, role: 'owner', displayName: 'Me Myself' },
    { userId: BELLA, role: 'member', displayName: 'Bella' },
  ],
  accounts: [account({ id: 'a1' }), account({ id: 'a2', name: 'Bank', type: 'bank', holder: null })],
  categories: [
    { id: 'c1', walletId: 'w1', parentId: null, name: 'Food' },
    { id: 'c2', walletId: 'w1', parentId: 'c1', name: 'Groceries' },
  ],
  budgets: [{ id: 'b1', walletId: 'w1', categoryId: 'c1', month: '2026-10-01', amountMinor: 50000 }],
  transactions: [
    tx({ id: 't1' }),
    tx({ id: 't2', created_by: BELLA, paid_by_user_id: BELLA }),
    tx({ id: 't3', created_by: GONE, paid_by_user_id: GONE }),
    tx({ id: 't4', type: 'transfer', category_id: null, destination_account_id: 'a2', paid_by_user_id: null }),
    tx({ id: 't5', type: 'income', category_id: null, created_by: ME, paid_by_user_id: GONE }),
  ],
}
const input: ExportInput = { userId: ME, exportedAt: NOW, profile: { displayName: 'Me Myself', avatarUrl: 'https://img.example/me.png' }, wallets: [wallet] }
const doc = buildExport(input)
const w = doc.wallets[0]!
const t = (id: string) => w.transactions.find((x) => x.id === id)!

describe('envelope', () => {
  it('has the schema version, app, UTC time, exporter and counts that match the collections', () => {
    expect(doc.schema_version).toBe(1)
    expect(doc.app).toBe('MoneyWhere')
    expect(doc.exported_at).toBe('2026-10-08T12:34:56.000Z')
    expect(doc.exported_by).toBe(ME)
    expect(doc.counts).toEqual({ wallets: 1, members: 2, accounts: 2, categories: 2, budgets: 1, transactions: 5 })
    expect(Object.keys(doc)).toEqual(['schema_version', 'app', 'exported_at', 'exported_by', 'notes', 'counts', 'profile', 'wallets'])
  })
  it('states that shared wallets include other current members transactions', () => {
    expect(doc.notes.join(' ')).toMatch(/other current members/)
    expect(doc.notes.join(' ')).toMatch(/Pending offline changes are not included/)
  })
  it('names the file by date', () => expect(exportFilename(NOW)).toBe('moneywhere-export-2026-10-08.json'))
})

describe('data shape (exact keys)', () => {
  it('profile: display name and avatar only', () => expect(doc.profile).toEqual({ display_name: 'Me Myself', avatar_url: 'https://img.example/me.png' }))
  it('wallet with the user role and members with id, display name and role only', () => {
    expect(Object.keys(w)).toEqual(['id', 'name', 'currency', 'mode', 'created_at', 'your_role', 'members', 'accounts', 'categories', 'budgets', 'transactions'])
    expect(w.your_role).toBe('owner')
    expect(w.members).toEqual([
      { user_id: ME, display_name: 'Me Myself', role: 'owner' },
      { user_id: BELLA, display_name: 'Bella', role: 'member' },
    ])
  })
  it('accounts carry a derived balance and integer minor units', () => {
    expect(w.accounts[0]).toEqual({
      id: 'a1', name: 'Cash', type: 'cash', holder: 'Me', currency: 'PHP', opening_balance_minor: 1000,
      balance: { amount_minor: 5000, currency: 'PHP', derived: true },
    })
    expect(w.accounts[1]!.holder).toBeNull()
  })
  it('categories keep the hierarchy; budgets keep YYYY-MM-01 and add the currency', () => {
    expect(w.categories).toEqual([
      { id: 'c1', name: 'Food', parent_id: null },
      { id: 'c2', name: 'Groceries', parent_id: 'c1' },
    ])
    expect(w.budgets).toEqual([{ id: 'b1', category_id: 'c1', month: '2026-10-01', amount_minor: 50000, currency: 'PHP' }])
  })
  it('transactions: exact keys, integer amounts, currency, no internal version', () => {
    expect(Object.keys(t('t1'))).toEqual([
      'id', 'type', 'account_id', 'destination_account_id', 'category_id', 'amount_minor', 'currency', 'date', 'note',
      'created_by', 'created_by_label', 'paid_by_user_id', 'paid_by_label',
    ])
    for (const x of w.transactions) {
      expect(Number.isInteger(x.amount_minor)).toBe(true)
      expect(x.currency).toBe('PHP')
    }
    expect(t('t1')).toMatchObject({ amount_minor: 12345, created_by: ME, created_by_label: 'Me Myself', paid_by_user_id: ME })
    expect(t('t2')).toMatchObject({ created_by: BELLA, paid_by_label: 'Bella' })
  })
})

describe('former members', () => {
  it('a creator or payer who is not a current member is null + "Former member", and the raw id never appears', () => {
    expect(t('t3')).toMatchObject({ created_by: null, created_by_label: 'Former member', paid_by_user_id: null, paid_by_label: 'Former member' })
    expect(t('t5')).toMatchObject({ created_by: ME, paid_by_user_id: null, paid_by_label: 'Former member' })
    expect(JSON.stringify(doc)).not.toContain(GONE)
  })
  it('a transfer exports with a null payer and no label', () => {
    expect(t('t4')).toMatchObject({ type: 'transfer', destination_account_id: 'a2', category_id: null, paid_by_user_id: null, paid_by_label: null })
  })
  it('membership is per wallet: someone current in one wallet is a former member in another', () => {
    const other: WalletExportInput = { ...wallet, wallet: { ...wallet.wallet, id: 'w2' }, members: [{ userId: ME, role: 'owner', displayName: 'Me Myself' }], transactions: [tx({ id: 'x', created_by: BELLA, paid_by_user_id: BELLA })] }
    const d = buildExport({ ...input, wallets: [wallet, other] })
    expect(d.wallets[1]!.transactions[0]).toMatchObject({ created_by: null, created_by_label: 'Former member' })
    expect(d.wallets[0]!.transactions.find((x) => x.id === 't2')!.created_by).toBe(BELLA)
  })
})

describe('privacy exclusions', () => {
  it('drops anything not explicitly named, even when the input carries it', () => {
    const dirty = {
      ...input,
      profile: { displayName: 'Me', avatarUrl: null, email: 'me@private.example', provider: 'google' },
      wallets: [{
        ...wallet,
        members: [
          { userId: ME, role: 'owner', displayName: 'Me', email: 'me@private.example', avatarUrl: 'https://img.example/b.png', joinedAt: '2026-01-01' },
          { userId: BELLA, role: 'member', displayName: 'Bella', email: 'bella@private.example', avatarUrl: 'https://img.example/bella.png' },
        ],
        transactions: [{ ...tx({ id: 't1' }), outbox: 'x', token: 'secret-token' }],
      }],
    } as unknown as ExportInput
    const json = JSON.stringify(buildExport(dirty))
    for (const leak of ['private.example', 'google', 'secret-token', 'bella.png', 'b.png', 'outbox', 'token', 'email', 'password', 'joinedAt', '"version"']) {
      expect(json).not.toContain(leak)
    }
  })
  it('a user with no wallets exports an empty but valid document', () => {
    const d = buildExport({ userId: ME, exportedAt: NOW, profile: { displayName: null, avatarUrl: null }, wallets: [] })
    expect(d.counts.wallets).toBe(0)
    expect(JSON.parse(JSON.stringify(d)).wallets).toEqual([])
  })
})
