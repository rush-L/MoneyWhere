import { Badge } from '../../ui/Badge'
import { useOffline } from './hooks/OfflineProvider'

/** Header: ✓ Synced / ↻ Pending sync / ⚠ Sync issue, plus Offline and Live. Details live on each transaction. */
export function SyncStatus() {
  const { items, online, realtime } = useOffline()
  const issues = items.filter((i) => i.status === 'FAILED' || i.status === 'BLOCKED' || i.status === 'CONFLICT')
  const pending = items.length - issues.length
  const tone = issues.length ? 'over' : pending > 0 ? 'pending' : online ? 'good' : 'neutral'
  return (
    <Badge tone={tone} role="status" title={issues.length ? 'Some changes did not sync. Open Transactions for details.' : undefined}>
      {!online && 'Offline · '}
      {issues.length > 0 ? `⚠ Sync issue (${issues.length})` : pending > 0 ? `↻ Pending sync (${pending})` : online ? '✓ Synced' : 'Showing saved data'}
      {realtime !== 'DISCONNECTED' && <span title={`Live updates: ${realtime.toLowerCase()}`}>{realtime === 'CONNECTED' ? ' · Live' : realtime === 'CONNECTING' ? ' · …' : ' · Live off'}</span>}
    </Badge>
  )
}
