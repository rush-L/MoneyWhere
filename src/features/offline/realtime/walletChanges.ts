import type { SupabaseClient } from '@supabase/supabase-js'

export type RealtimeStatus = 'CONNECTED' | 'CONNECTING' | 'DISCONNECTED' | 'ERROR'

/**
 * Listens for "a transaction in this wallet changed" on the wallet's private Broadcast topic (see the
 * transactions_realtime migration). It carries no data: callers reload through their normal queries.
 * Returns the unsubscribe function. Failures never throw; the app keeps working on load-on-open.
 */
export function subscribeWalletChanges(
  client: Pick<SupabaseClient, 'channel' | 'removeChannel' | 'realtime'>,
  walletId: string,
  onChange: () => void,
  onStatus: (s: RealtimeStatus) => void = () => {},
): () => void {
  let stopped = false
  let missed = false // the channel dropped at some point: Broadcast has no replay, so catch up once on rejoin
  let channel: ReturnType<typeof client.channel> | null = null
  onStatus('CONNECTING')

  // Private channels need the current JWT on the realtime socket before joining.
  void Promise.resolve(client.realtime.setAuth())
    .catch((e: unknown) => console.warn('[realtime] setAuth failed', e))
    .then(() => {
      if (stopped) return
      channel = client.channel(`wallet:${walletId}`, { config: { private: true } })
      channel
        .on('broadcast', { event: 'tx_changed' }, () => !stopped && onChange())
        .subscribe((status, err) => {
          if (stopped) return
          if (status === 'SUBSCRIBED') {
            onStatus('CONNECTED')
            if (missed) {
              missed = false
              onChange()
            }
            return
          }
          missed = true
          if (status === 'CLOSED') onStatus('DISCONNECTED')
          else {
            console.warn('[realtime] wallet channel', status, err?.message ?? '') // realtime-js rejoins on its own
            onStatus('ERROR')
          }
        })
    })

  return () => {
    stopped = true
    if (channel) void client.removeChannel(channel)
  }
}
