import { CACHE, committed, request } from './idb'

/** Per-user snapshots (key is prefixed with the user id by callers). Only what offline transaction entry needs. */
export type Cache = ReturnType<typeof createCache>

export function createCache(db: IDBDatabase) {
  return {
    async get<T>(key: string): Promise<T | null> {
      const row = await request<{ key: string; value: T } | undefined>(db.transaction(CACHE).objectStore(CACHE).get(key))
      return row?.value ?? null
    },
    async put(key: string, value: unknown): Promise<void> {
      const tx = db.transaction(CACHE, 'readwrite')
      tx.objectStore(CACHE).put({ key, value })
      await committed(tx)
    },
  }
}

export const walletsKey = (userId: string) => `${userId}:wallets`
export const walletKey = (userId: string, walletId: string) => `${userId}:wallet:${walletId}`

/**
 * Network first; a successful read refreshes the snapshot, a failed one falls back to it (`stale: true`).
 * When the browser reports offline the snapshot is used straight away: a request would only fail after
 * supabase-js has retried it with backoff (~7 s), and nothing could come of it.
 */
export async function readThrough<T>(cache: Cache | null, key: string, fetcher: () => Promise<T>): Promise<{ data: T; stale: boolean }> {
  if (cache && navigator.onLine === false) {
    const snap = await cache.get<T>(key).catch(() => null)
    if (snap !== null) return { data: snap, stale: true }
  }
  try {
    const data = await fetcher()
    cache?.put(key, data).catch((e) => console.error('[offline] cache write failed', e))
    return { data, stale: false }
  } catch (e) {
    const snap = cache ? await cache.get<T>(key).catch(() => null) : null
    if (snap === null) throw e
    return { data: snap, stale: true }
  }
}
