/** Tiny promise wrappers over IndexedDB. Browser code lives here, never in src/domain. */

export const DB_NAME = 'moneywhere-offline'
export const OUTBOX = 'outbox'
export const CACHE = 'cache'

export const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })

/** Resolves when the transaction has committed (not merely when its requests succeeded). */
export const committed = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })

/**
 * v1: `outbox` (auto-increment `seq` = creation order; unique `id` = the transaction UUID; `user_id` index)
 * and `cache` (key → JSON snapshot of the data needed to create a transaction offline).
 */
export function openOfflineDb(factory: IDBFactory = indexedDB, name = DB_NAME): Promise<IDBDatabase> {
  const open = factory.open(name, 1)
  open.onupgradeneeded = () => {
    const db = open.result
    const outbox = db.createObjectStore(OUTBOX, { keyPath: 'seq', autoIncrement: true })
    outbox.createIndex('id', 'id', { unique: true })
    outbox.createIndex('user_id', 'user_id')
    db.createObjectStore(CACHE, { keyPath: 'key' })
  }
  return request(open)
}
