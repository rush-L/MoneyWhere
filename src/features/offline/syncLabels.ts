import type { OutboxStatus } from './outbox/outbox'

/** Shown whenever data comes from this device's snapshot instead of the server. */
export const staleNote = (revalidating: boolean) =>
  revalidating ? 'Showing data saved on this device. Checking for updates…' : 'Showing data saved on this device. Reconnect to refresh.'

export type SyncTone = 'info' | 'warn' | 'error'

/**
 * What the user is told about a transaction the server has not confirmed. Plain language only: raw error text
 * never reaches the screen. `editable` = safe to change on this device (never sent, so nothing can be in doubt).
 * `attempted`: a send was already tried, so the server may already have the row (a lost response).
 */
export function describeSync(status: Exclude<OutboxStatus, 'SYNCED'>, attempted: boolean): { text: string; tone: SyncTone; editable: boolean } {
  switch (status) {
    case 'PENDING':
      return attempted
        ? { text: '↻ Waiting to sync. It can be edited again once the server confirms it.', tone: 'info', editable: false }
        : { text: '↻ Saved on this device · waiting to sync', tone: 'info', editable: true }
    case 'SYNCING':
      return { text: '↻ Syncing…', tone: 'info', editable: false }
    case 'FAILED':
      return { text: '⚠ Not synced yet. It is saved on this device and will be retried automatically.', tone: 'warn', editable: false }
    case 'BLOCKED':
      return { text: "⚠ Not synced: the server rejected this change. It exists only on this device and isn't counted by the server.", tone: 'error', editable: false }
    case 'CONFLICT':
      return { text: "⚠ Your offline change wasn't applied: someone changed this transaction first. The server version is shown.", tone: 'error', editable: false }
  }
}
