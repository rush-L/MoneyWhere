import { describe, expect, it } from 'vitest'
import { accountFromSummary, accountLock, accountUpdatePatch, ACCOUNT_TYPES, canManageAccounts, groupAccounts, lockNote, isBelowZeroAsset, parseNewAccount, type AccountType } from './account'

const ok = { name: ' GCash ', type: 'e_wallet', openingBalance: '10000', holder: ' Russel ' }

describe('parseNewAccount', () => {
  it('trims, converts to minor units, normalizes empty holder to null', () => {
    expect(parseNewAccount(ok)).toEqual({ ok: true, value: { name: 'GCash', type: 'e_wallet', openingBalanceMinor: 1000000, holder: 'Russel' } })
    expect(parseNewAccount({ ...ok, holder: '  ', openingBalance: '' })).toMatchObject({ ok: true, value: { holder: null, openingBalanceMinor: 0 } })
  })
  it('rejects bad name, type, amount, long holder', () => {
    expect(parseNewAccount({ ...ok, name: ' ' }).ok).toBe(false)
    expect(parseNewAccount({ ...ok, name: 'x'.repeat(51) }).ok).toBe(false)
    expect(parseNewAccount({ ...ok, type: 'crypto' }).ok).toBe(false)
    expect(parseNewAccount({ ...ok, openingBalance: '1.234' }).ok).toBe(false)
    expect(parseNewAccount({ ...ok, openingBalance: 'abc' }).ok).toBe(false)
    expect(parseNewAccount({ ...ok, holder: 'x'.repeat(51) }).ok).toBe(false)
  })
  it('only debt accounts may start negative', () => {
    expect(parseNewAccount({ ...ok, openingBalance: '-5' }).ok).toBe(false)
    expect(parseNewAccount({ ...ok, type: 'loan', openingBalance: '-5' })).toMatchObject({ ok: true, value: { openingBalanceMinor: -500 } })
  })
})

describe('accountFromSummary', () => {
  it('maps the server aggregate row; balances are taken as given', () => {
    const a = accountFromSummary({
      account_id: 'a', wallet_id: 'w', account_name: 'Cash', account_type: 'cash', holder: null, currency: 'PHP',
      opening_balance_minor: 12345, current_balance_minor: 20000, has_transactions: true,
    })
    expect(a).toEqual({ id: 'a', walletId: 'w', name: 'Cash', type: 'cash', holder: null, currency: 'PHP', openingBalanceMinor: 12345, currentBalanceMinor: 20000, hasTransactions: true })
  })
})

describe('accountUpdatePatch', () => {
  const v = { name: 'N', type: 'bank' as const, openingBalanceMinor: 5, holder: null }
  it('sends every editable column before transactions', () => {
    expect(accountUpdatePatch({ hasTransactions: false }, v)).toEqual({ name: 'N', type: 'bank', opening_balance_minor: 5, holder: null })
  })
  it('sends only name and holder once transactions exist', () => {
    expect(accountUpdatePatch({ hasTransactions: true }, v)).toEqual({ name: 'N', holder: null })
  })
})

const acc = (id: string, type: AccountType, currentBalanceMinor = 0, hasTransactions = false) => ({ id, type, currentBalanceMinor, hasTransactions })

describe('groupAccounts', () => {
  it('maps every account type to its group', () => {
    const groups = groupAccounts(ACCOUNT_TYPES.map((t) => acc(t, t)))
    expect(groups.map((g) => [g.label, g.accounts.map((a) => a.type)])).toEqual([
      ['Cash & bank', ['cash', 'e_wallet', 'bank']],
      ['Credit cards & loans', ['credit_card', 'loan']],
    ])
  })
  it('omits a group with no accounts', () => {
    expect(groupAccounts([acc('a', 'bank')]).map((g) => g.id)).toEqual(['cash_bank'])
    expect(groupAccounts([acc('a', 'loan')]).map((g) => g.id)).toEqual(['credit_loans'])
    expect(groupAccounts([])).toEqual([])
  })
  it('keeps the given (creation) order inside each group; it never sorts', () => {
    const input = [acc('z', 'loan'), acc('m', 'bank'), acc('b', 'credit_card'), acc('a', 'cash'), acc('k', 'e_wallet')]
    expect(groupAccounts(input).map((g) => g.accounts.map((a) => a.id))).toEqual([['m', 'a', 'k'], ['z', 'b']])
  })
  it('never drops an account, even one with an unexpected type', () => {
    const odd = acc('x', 'crypto' as AccountType)
    const groups = groupAccounts([acc('a', 'loan'), odd])
    expect(groups.flatMap((g) => g.accounts)).toHaveLength(2)
    expect(groups[0]!.accounts).toContain(odd)
  })
  it('adds up nothing: the groups carry only accounts', () => {
    expect(Object.keys(groupAccounts([acc('a', 'cash', 500)])[0]!).sort()).toEqual(['accounts', 'id', 'label'])
  })
})

describe('isBelowZeroAsset', () => {
  it('flags only a negative cash, e-wallet or bank balance', () => {
    expect(isBelowZeroAsset(acc('a', 'cash', -1))).toBe(true)
    expect(isBelowZeroAsset(acc('a', 'e_wallet', -50000))).toBe(true)
    expect(isBelowZeroAsset(acc('a', 'bank', -1))).toBe(true)
  })
  it('never flags zero or a positive balance', () => {
    expect(isBelowZeroAsset(acc('a', 'cash', 0))).toBe(false)
    expect(isBelowZeroAsset(acc('a', 'bank', 1))).toBe(false)
  })
  it('never flags a credit card or loan, whatever its balance', () => {
    expect(isBelowZeroAsset(acc('a', 'credit_card', -500000))).toBe(false)
    expect(isBelowZeroAsset(acc('a', 'loan', -1))).toBe(false)
  })
})

describe('accountLock (server transactions plus pending ones)', () => {
  const none = new Set<string>()
  it('an unused account is editable and deletable', () => {
    expect(accountLock(acc('a', 'cash'), none)).toEqual({ locked: false, pendingOnly: false, canDelete: true })
  })
  it('server transactions lock type and opening balance and block delete (existing rule)', () => {
    expect(accountLock(acc('a', 'cash', 0, true), none)).toEqual({ locked: true, pendingOnly: false, canDelete: false })
  })
  it('an account used only by pending transactions is locked and cannot be deleted', () => {
    expect(accountLock(acc('a', 'cash'), new Set(['a']))).toEqual({ locked: true, pendingOnly: true, canDelete: false })
  })
  it('pending use of another account changes nothing', () => {
    expect(accountLock(acc('a', 'cash'), new Set(['b']))).toEqual({ locked: false, pendingOnly: false, canDelete: true })
  })
  it('server and pending together is not "pending only"', () => {
    expect(accountLock(acc('a', 'cash', 0, true), new Set(['a']))).toEqual({ locked: true, pendingOnly: false, canDelete: false })
  })
  it('a locked account still sends only name and holder (the existing payload)', () => {
    const v = { name: 'N', type: 'bank' as const, openingBalanceMinor: 5, holder: null }
    const locked = accountLock(acc('a', 'cash'), new Set(['a'])).locked
    expect(accountUpdatePatch({ hasTransactions: locked }, v)).toEqual({ name: 'N', holder: null })
  })
})

describe('canManageAccounts', () => {
  it('owners manage accounts when the data is live', () => expect(canManageAccounts('owner', false)).toBe(true))
  it('owners are offered nothing while showing a saved snapshot', () => expect(canManageAccounts('owner', true)).toBe(false))
  it('members never manage accounts', () => {
    expect(canManageAccounts('member', false)).toBe(false)
    expect(canManageAccounts('member', true)).toBe(false)
  })
})

describe('lock explanations', () => {
  it('say why, and the two reasons stay distinct', () => {
    expect(lockNote(false)).toBe('Account type and opening balance are locked because this account has transactions.')
    expect(lockNote(true)).toBe('Account type and opening balance are locked until pending transactions sync.')
  })
  it('match the lock the rules report', () => {
    const none = new Set<string>()
    expect(lockNote(accountLock(acc('a', 'cash', 0, true), none).pendingOnly)).toBe(lockNote(false))
    expect(lockNote(accountLock(acc('a', 'cash'), new Set(['a'])).pendingOnly)).toBe(lockNote(true))
  })
})
