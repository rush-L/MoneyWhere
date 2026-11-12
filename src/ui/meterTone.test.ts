import { describe, expect, it } from 'vitest'
import { calculateBudgetStatus } from '../domain/finance'
import { meterTone } from './meterTone'

// Budget 10000 minor units; spent is chosen to hit each boundary. Dashboard and Budgets both render Meter from this status.
describe('budget status -> meter tone (shared by Dashboard and Budgets)', () => {
  it.each([
    ['below 80% (79.99%)', 7999, 'ok'],
    ['exactly 80%', 8000, 'near'],
    ['85%', 8500, 'near'],
    ['99.99%', 9999, 'near'],
    ['exactly 100%', 10000, 'over'],
    ['above 100%', 10001, 'over'],
  ] as const)('%s', (_n, spent, tone) => {
    expect(meterTone(calculateBudgetStatus(10000, spent).status)).toBe(tone)
  })
})
