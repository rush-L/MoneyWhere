import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { supabase } from '../../../lib/supabase'
import type { NewTransaction, TransactionRow } from '../../transactions/transaction'
import { createTransactionService, TransactionError } from '../../transactions/transactionService'
import { createCache, type Cache } from '../db/cache'
import { openOfflineDb } from '../db/idb'
import { createOutbox, type Outbox, type OutboxItem } from '../outbox/outbox'
import { classifyFailure } from '../sync/errors'
import { subscribeWalletChanges, type RealtimeStatus } from '../realtime/walletChanges'
import { sendItem } from '../sync/sendItem'
import { createSyncer, syncOutbox } from '../sync/syncEngine'

interface OfflineValue {
  /** Browser connectivity hint only. Supabase may still be unreachable; the sync engine decides on real failures. */
  online: boolean
  /** The signed-in user's outbox, oldest first (all statuses). */
  items: readonly OutboxItem[]
  /** Bumps whenever a sync run confirmed an item or a Realtime change arrived for the watched wallet; pages reload server data on change. */
  syncedTick: number
  /** Connection state of the watched wallet's Realtime channel. Optional: the app works without it. */
  realtime: RealtimeStatus
  /** Pages call this (via useWatchWallet) to say which wallet is open; one channel at a time. */
  setWatchedWallet: (walletId: string | null) => void
  cache: Cache | null
  /** Online with an empty queue: straight to Supabase. Otherwise (or if the network fails): queued on the device. */
  saveTransaction: (walletId: string, t: NewTransaction) => Promise<'synced' | 'queued'>
  /**
   * Edit / delete. A transaction with an open outbox item is folded into it (one mutation reaches the server).
   * Otherwise online goes through the version-aware RPC; if Supabase is unreachable, the user's OWN transaction is
   * queued (same mutation id, so a lost response is safe). Another user's transaction (owner) is online-only.
   * Throws TransactionConflictError / OutboxBusyError / Error with a message safe to show.
   */
  editTransaction: (walletId: string, row: TxRef, t: NewTransaction) => Promise<'synced' | 'queued'>
  deleteTransaction: (walletId: string, row: TxRef) => Promise<'synced' | 'queued'>
  /** Keep server version: drop a CONFLICT/BLOCKED item. */
  discardItem: (id: string) => Promise<void>
  /** A FRESH IndexedDB read (not React state): does this user's outbox hold ANY item, in any status? Read-only. */
  hasPendingChanges: () => Promise<boolean>
}

/** What an edit/delete needs to know about the row the user is looking at. */
export type TxRef = TransactionRow

const Ctx = createContext<OfflineValue | null>(null)

const subscribeOnline = (cb: () => void) => {
  addEventListener('online', cb)
  addEventListener('offline', cb)
  return () => {
    removeEventListener('online', cb)
    removeEventListener('offline', cb)
  }
}
export const useOnline = () => useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true)

/** Mounted only while a user is authenticated; remounted (key) when the user changes. */
export function OfflineProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const online = useOnline()
  const [stores, setStores] = useState<{ outbox: Outbox; cache: Cache } | null>(null)
  const [opened, setOpened] = useState(false) // the IndexedDB open attempt has finished (either way)
  const [items, setItems] = useState<readonly OutboxItem[]>([])
  const [syncedTick, setSyncedTick] = useState(0)
  const [watchedWallet, setWatchedWallet] = useState<string | null>(null)
  const [realtime, setRealtime] = useState<RealtimeStatus>('DISCONNECTED')
  const userRef = useRef(userId)
  useEffect(() => {
    userRef.current = userId
  }, [userId])

  useEffect(() => {
    openOfflineDb().then(
      (db) => {
        setStores({ outbox: createOutbox(db), cache: createCache(db) })
        setOpened(true)
      },
      (e) => {
        console.error('[offline] IndexedDB unavailable', e) // app keeps working online
        setOpened(true)
      },
    )
  }, [])

  const txService = useMemo(() => (supabase ? createTransactionService(supabase) : null), [])
  const syncRef = useRef<(() => Promise<void>) | null>(null)

  // Outbox view + sync triggers: session available / app start (this effect), browser back online, queueing.
  useEffect(() => {
    if (!stores) return
    const refresh = () => void stores.outbox.list(userId).then(setItems, (e) => console.error('[offline]', e))
    refresh()
    const off = stores.outbox.subscribe(refresh)
    const sync = createSyncer(async () => {
      // Offline: no attempt at all. An attempt that fails still marks the item "may have reached the server", which
      // would make an offline-created transaction uneditable; an item that was never sent can still be edited.
      if (!navigator.onLine || !txService) return { synced: 0, conflicted: 0, stoppedBy: null }
      const r = await syncOutbox({
        outbox: stores.outbox,
        userId,
        currentUserId: () => userRef.current,
        send: (i) => sendItem(txService, i),
      })
      if (r.synced + r.conflicted > 0) setSyncedTick((n) => n + 1)
      return r
    })
    syncRef.current = sync
    void sync()
    const onOnline = () => {
      setSyncedTick((n) => n + 1) // reload server data so "saved on this device" notices clear even with an empty queue
      void sync()
    }
    addEventListener('online', onOnline)
    return () => {
      syncRef.current = null
      off()
      removeEventListener('online', onOnline)
    }
  }, [stores, txService, userId])

  // Realtime = invalidation only: a (debounced) change bumps the same tick a finished sync does, and pages reload.
  // The provider is keyed on the user, so logout / user switch unmounts this effect and closes the channel.
  useEffect(() => {
    if (!supabase || !watchedWallet) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = subscribeWalletChanges(
      supabase,
      watchedWallet,
      () => {
        clearTimeout(timer)
        timer = setTimeout(() => setSyncedTick((n) => n + 1), 300) // coalesce bursts (a 3-item sync = 3 events)
      },
      setRealtime,
    )
    return () => {
      clearTimeout(timer)
      off()
    }
  }, [watchedWallet])

  const saveTransaction = useCallback(
    async (walletId: string, t: NewTransaction) => {
      const id = crypto.randomUUID() // the one UUID: local row, IndexedDB, Supabase
      if (navigator.onLine && txService && stores && (await stores.outbox.listSyncable(userId)).length === 0) {
        try {
          await txService.send(id, userId, t)
          return 'synced' as const
        } catch (e) {
          if (classifyFailure(e) !== 'network') {
            console.error('[transactions]', e)
            throw new Error('Could not save the transaction. Please try again.', { cause: e })
          }
          // Browser said online but Supabase is unreachable: fall through to the queue (same id, so a lost response is safe).
        }
      }
      if (!stores) throw new Error('Offline storage is unavailable on this device. Connect to the internet and try again.')
      await stores.outbox.enqueue({ id, user_id: userId, wallet_id: walletId, payload: t })
      void syncRef.current?.()
      return 'queued' as const
    },
    [stores, txService, userId],
  )

  // Shared by edit and delete. Returns 'synced' when the server took it, 'queued' when it is in the outbox.
  const mutateOrQueue = useCallback(
    async (row: TxRef, direct: (mutationId: string) => Promise<void>, queue: (mutationId: string) => Promise<void>, fold: () => Promise<void>) => {
      if (!stores) throw new Error('Offline storage is unavailable on this device. Connect to the internet and try again.')
      if ((await stores.outbox.list(userId)).some((i) => i.id === row.id)) {
        await fold() // an open item for this transaction: fold into it (throws OutboxBusyError if it cannot be)
        void syncRef.current?.()
        return 'queued' as const
      }
      const own = row.created_by === userId
      const mutationId = crypto.randomUUID()
      if (navigator.onLine && txService) {
        try {
          await direct(mutationId)
          return 'synced' as const
        } catch (e) {
          if (!(e instanceof TransactionError) || classifyFailure(e.cause) !== 'network') throw e
          // unreachable: fall through. Same mutationId, so if the server did commit, the replay is ALREADY_APPLIED.
        }
      }
      if (!own) throw new Error('You need an internet connection to change another member\'s transaction.')
      if (row.version === undefined) throw new Error('This transaction was saved before editing offline was supported. Connect to the internet to change it.')
      await queue(mutationId)
      void syncRef.current?.()
      return 'queued' as const
    },
    [stores, txService, userId],
  )

  const editTransaction = useCallback(
    (walletId: string, row: TxRef, t: NewTransaction) =>
      mutateOrQueue(
        row,
        (mid) => txService!.update(row.id, row.version, t, mid),
        (mid) => stores!.outbox.edit({ id: row.id, user_id: userId, wallet_id: walletId, expected_version: row.version!, payload: t, base: row, mutation_id: mid }),
        () => stores!.outbox.edit({ id: row.id, user_id: userId, wallet_id: walletId, expected_version: row.version ?? 0, payload: t, base: row }),
      ),
    [mutateOrQueue, txService, stores, userId],
  )
  const deleteTransaction = useCallback(
    (walletId: string, row: TxRef) =>
      mutateOrQueue(
        row,
        (mid) => txService!.remove(row.id, row.version, mid),
        (mid) => stores!.outbox.remove({ id: row.id, user_id: userId, wallet_id: walletId, expected_version: row.version ?? null, base: row, mutation_id: mid }),
        () => stores!.outbox.remove({ id: row.id, user_id: userId, wallet_id: walletId, expected_version: row.version ?? null, base: row }),
      ),
    [mutateOrQueue, txService, stores, userId],
  )
  const discardItem = useCallback(async (id: string) => void (await stores?.outbox.discard(id)), [stores])
  const hasPendingChanges = useCallback(async () => (stores ? stores.outbox.hasAny(userId) : false), [stores, userId])

  const value = useMemo(
    () => ({ online, items, syncedTick, realtime: watchedWallet ? realtime : ('DISCONNECTED' as const), setWatchedWallet, cache: stores?.cache ?? null, saveTransaction, editTransaction, deleteTransaction, discardItem, hasPendingChanges }),
    [online, items, syncedTick, realtime, watchedWallet, stores, saveTransaction, editTransaction, deleteTransaction, discardItem, hasPendingChanges],
  )
  // Pages load on mount: wait for the (millisecond) IndexedDB open so their first read can already use the snapshot
  // instead of starting a network request that offline can only fail slowly.
  return <Ctx.Provider value={value}>{opened ? children : <p role="status" className="center">Loading…</p>}</Ctx.Provider>
}

export function useOffline(): OfflineValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useOffline must be used inside <OfflineProvider>')
  return v
}

/** Mark `walletId` as the open wallet for Realtime. Unmount / wallet change / navigation hands over to the next page. */
export function useWatchWallet(walletId: string) {
  const { setWatchedWallet } = useOffline()
  useEffect(() => {
    setWatchedWallet(walletId)
    return () => setWatchedWallet(null)
  }, [walletId, setWatchedWallet])
}
