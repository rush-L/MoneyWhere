import { describe, expect, it } from 'vitest'
import { accountFromSummary, accountUpdatePatch, parseNewAccount } from './account'

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
