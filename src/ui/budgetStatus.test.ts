import { describe, expect, it } from 'vitest'
import { calculateBudgetStatus } from '../domain/finance'
import { percentLabel, statusBadge } from './budgetStatus'

describe('statusBadge', () => {
  it.each([
    ['below 80%', 7999, 'good', 'On track'],
    ['exactly 80%', 8000, 'caution', 'Near limit'],
    ['85%', 8500, 'caution', 'Near limit'],
    ['99.99%', 9999, 'caution', 'Near limit'],
    ['exactly 100%', 10000, 'over', 'Fully used'],
    ['above 100%', 10001, 'over', 'Over budget'],
  ] as const)('%s', (_n, spent, tone, label) => {
    expect(statusBadge(calculateBudgetStatus(10000, spent))).toEqual({ tone, label })
  })
})

describe('percentLabel', () => {
  it('truncates instead of rounding', () => {
    expect(percentLabel(85, 'warning')).toBe('85.0%')
    expect(percentLabel(116.66, 'exceeded')).toBe('116.6%')
    expect(percentLabel(0, 'normal')).toBe('0.0%')
    expect(percentLabel(29.7, 'normal')).toBe('29.7%') // 29.7 * 10 is 296.99999999999994 in floating point
  })
  it('never shows a threshold before the status reaches it', () => {
    expect(percentLabel(79.96, 'normal')).toBe('79.9%')
    expect(percentLabel(99.96, 'warning')).toBe('99.9%')
  })
  it('never shows less than the threshold once the status has reached it', () => {
    expect(percentLabel(79.99999999999, 'warning')).toBe('80.0%')
    expect(percentLabel(99.99999999999, 'exceeded')).toBe('100.0%')
  })
  it('agrees with the domain status at every boundary of a 10,000 budget', () => {
    const shown = (spent: number) => {
      const s = calculateBudgetStatus(10000, spent)
      return percentLabel(s.percentUsed, s.status)
    }
    expect(shown(7999)).toBe('79.9%')
    expect(shown(8000)).toBe('80.0%')
    expect(shown(8500)).toBe('85.0%')
    expect(shown(9999)).toBe('99.9%')
    expect(shown(10000)).toBe('100.0%')
    expect(shown(10001)).toBe('100.0%')
    expect(shown(11666)).toBe('116.6%')
  })
})
