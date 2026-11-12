import { describe, expect, it } from 'vitest'
import { syncCounts } from './syncLabels'

const item = (wallet_id: string, status: string) => ({ wallet_id, status })

describe('syncCounts', () => {
  it('is all zero with nothing queued', () => expect(syncCounts([], 'w')).toEqual({ issues: 0, pending: 0, counted: 0 }))
  it('splits issues from pending and counts only items that move the figures', () => {
    const items = [item('w', 'PENDING'), item('w', 'SYNCING'), item('w', 'FAILED'), item('w', 'BLOCKED'), item('w', 'CONFLICT')]
    // FAILED is an issue to the user but still counts in the projected figures; BLOCKED and CONFLICT do not.
    expect(syncCounts(items, 'w')).toEqual({ issues: 3, pending: 2, counted: 3 })
  })
  it('ignores other wallets', () => expect(syncCounts([item('other', 'PENDING'), item('w', 'PENDING')], 'w')).toEqual({ issues: 0, pending: 1, counted: 1 }))
})
