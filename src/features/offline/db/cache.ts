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
    /**
     * Removes every snapshot of ONE user (keys are `${userId}:…`; the colon ends the prefix, so one id can never match
     * another's). Other users' snapshots and the outbox are not touched.
     */
    async clearUser(userId: string): Promise<void> {
      const tx = db.transaction(CACHE, 'readwrite')
      tx.objectStore(CACHE).delete(IDBKeyRange.bound(`${userId}:`, `${userId}:￿`))
      await committed(tx)
    },
  }
}

export const walletsKey = (userId: string) => `${userId}:wallets`
export const walletKey = (userId: string, walletId: string) => `${userId}:wallet:${walletId}`

export type ReadResult<T> = { data: T; stale: boolean; revalidating?: boolean }

/**
 * Network first; a successful read refreshes the snapshot, a failed one falls back to it (`stale: true`).
 * When the browser reports offline the snapshot is used straight away: a request would only fail after
 * supabase-js has retried it with backoff (~7 s), and nothing could come of it.
 *
 * Stale-while-revalidate (opt in with `onSettled`, for first loads only): if a snapshot exists it is returned at once
 * as `{ stale: true, revalidating: true }`, the fetch runs in the background and `onSettled` is called exactly once
 * with the server data (`stale: false`) or, if the fetch failed, the same snapshot (`stale: true`). The snapshot is
 * never presented as confirmed. After a mutation or sync, callers must NOT pass `onSettled`: they need server data.
 */
export async function readThrough<T>(cache: Cache | null, key: string, fetcher: () => Promise<T>, onSettled?: (r: ReadResult<T>) => void): Promise<ReadResult<T>> {
  const snapshot = cache ? await cache.get<T>(key).catch(() => null) : null
  if (snapshot !== null && (navigator.onLine === false || onSettled)) {
    if (onSettled && navigator.onLine !== false) {
      fetcher().then(
        (data) => {
          cache?.put(key, data).catch((e) => console.error('[offline] cache write failed', e))
          onSettled({ data, stale: false })
        },
        () => onSettled({ data: snapshot, stale: true }),
      )
      return { data: snapshot, stale: true, revalidating: true }
    }
    return { data: snapshot, stale: true }
  }
  try {
    const data = await fetcher()
    cache?.put(key, data).catch((e) => console.error('[offline] cache write failed', e))
    return { data, stale: false }
  } catch (e) {
    if (snapshot === null) throw e
    return { data: snapshot, stale: true }
  }
}
