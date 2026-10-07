import type { Outbox, OutboxItem } from '../outbox/outbox'
import { classifyFailure, describeFailure } from './errors'

export interface SyncDeps {
  outbox: Outbox
  /** The user this run syncs for (the authenticated user when it started). */
  userId: string
  /** The authenticated user right now; re-read before every send. */
  currentUserId: () => string | null
  /**
   * Idempotent send of the item (insert / versioned update / versioned delete). Throws on failure. Returns
   * 'conflict' when the server changed the row first: a valid mutation that lost, not an error.
   */
  send: (item: OutboxItem) => Promise<'ok' | 'conflict' | void>
}

export interface SyncResult {
  synced: number
  conflicted: number
  stoppedBy: 'network' | 'transient' | 'user-changed' | null
}

/**
 * One replay run for one user, oldest first. Only that user's items are ever read; the per-item
 * `user_id` check is defence in depth. Other users' items stay PENDING, untouched, until they sign in.
 */
export async function syncOutbox(d: SyncDeps): Promise<SyncResult> {
  const { outbox, userId } = d
  let synced = 0
  let conflicted = 0
  await outbox.resetSyncing(userId)
  for (const item of await outbox.listSyncable(userId)) {
    if (d.currentUserId() !== userId) return { synced, conflicted, stoppedBy: 'user-changed' }
    if (item.user_id !== userId) {
      await outbox.markBlocked(item.id, 'user-mismatch: queued by a different user; not sent')
      continue
    }
    const live = await outbox.markSyncing(item) // send what is stored NOW: the user may have edited/removed it since the list
    if (!live) continue
    try {
      if ((await d.send(live)) === 'conflict') {
        await outbox.markConflict(item.id, 'The transaction was changed by someone else first; the server version was kept.')
        conflicted++ // like BLOCKED: independent of later items, never retried
        continue
      }
      await outbox.complete(item.id)
      synced++
    } catch (e) {
      const error = describeFailure(e)
      const kind = classifyFailure(e)
      if (kind === 'permanent') {
        console.error('[sync] blocked', item.id, error)
        await outbox.markBlocked(item.id, error)
        continue // later items are independent appends
      }
      if (kind === 'network') await outbox.markPending(item.id, error)
      else await outbox.markFailed(item.id, error)
      return { synced, conflicted, stoppedBy: kind } // keep creation order: do not leapfrog the failed item
    }
  }
  return { synced, conflicted, stoppedBy: null }
}

/** At most one run per user at a time; a trigger during a run schedules exactly one more run. */
export function createSyncer(run: () => Promise<SyncResult>) {
  let running: Promise<void> | null = null
  let again = false
  const loop = async () => {
    do {
      again = false
      await run().catch((e) => console.error('[sync] run failed', e))
    } while (again)
    running = null
  }
  return () => {
    if (running) again = true
    else running = loop()
    return running
  }
}
