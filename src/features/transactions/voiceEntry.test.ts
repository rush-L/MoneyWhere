import { describe, expect, it } from 'vitest'
import { parseVoice } from './voiceEntry'

const accounts = [{ id: 'a-cash', name: 'Cash' }, { id: 'a-gcash', name: 'GCash' }, { id: 'a-bdo', name: 'BDO Savings' }]
const categories = [{ id: 'c-food', name: 'Food' }, { id: 'c-coffee', name: 'Coffee' }, { id: 'c-fare', name: 'Pamasahe' }]
const p = (s: string) => parseVoice(s, accounts, categories)

describe('parseVoice', () => {
  it('English expense: amount, account, category, leftover note', () => {
    expect(p('Coffee 120 pesos cash')).toMatchObject({ type: 'expense', amount: '120', accountId: 'a-cash', categoryId: 'c-coffee', note: '' })
    expect(p('spent ₱1,250.50 on food with GCash for lunch with team')).toMatchObject({ amount: '1250.50', accountId: 'a-gcash', categoryId: 'c-food' })
  })
  it('Tagalog expense', () => {
    expect(p('pamasahe 50 piso cash')).toMatchObject({ type: 'expense', amount: '50', accountId: 'a-cash', categoryId: 'c-fare' })
    expect(p('bumili ng bigas 300 sa gcash')).toMatchObject({ amount: '300', accountId: 'a-gcash', note: 'bumili ng bigas' })
  })
  it('income keywords in both languages; no category for income', () => {
    expect(p('salary 20000 bdo savings')).toMatchObject({ type: 'income', amount: '20000', accountId: 'a-bdo', categoryId: '' })
    expect(p('sweldo 15000 sa cash')).toMatchObject({ type: 'income', amount: '15000', accountId: 'a-cash' })
  })
  it('transfer takes two accounts in spoken order', () => {
    expect(p('transfer 500 from cash to gcash')).toMatchObject({ type: 'transfer', amount: '500', accountId: 'a-cash', destinationAccountId: 'a-gcash', categoryId: '' })
    expect(p('lipat 1000 mula gcash papunta cash')).toMatchObject({ accountId: 'a-gcash', destinationAccountId: 'a-cash' })
  })
  it('does not guess: no number or no match leaves the field empty; extra decimals pass through unrounded', () => {
    expect(p('coffee')).toMatchObject({ amount: '', accountId: '', categoryId: 'c-coffee' })
    expect(p('tindahan 12.345')).toMatchObject({ amount: '12.345', accountId: '', categoryId: '', note: 'tindahan' })
  })
  it('whole-word names only ("cash" inside "cashback" is not the Cash account)', () => {
    expect(p('cashback 100')).toMatchObject({ accountId: '', note: 'cashback' })
  })
})
