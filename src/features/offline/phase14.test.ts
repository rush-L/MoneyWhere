import { afterEach, describe, expect, it, vi } from 'vitest'
import { readThrough, type ReadResult } from './db/cache'
import { freshStores } from './testing'

describe('readThrough stale-while-revalidate', () => {
  afterEach(() => vi.unstubAllGlobals())
  const settle = <T>() => {
    let resolve!: (r: ReadResult<T>) => void
    const p = new Promise<ReadResult<T>>((r) => (resolve = r))
    return { p, onSettled: resolve }
  }

  it('online with a snapshot: returns it at once as stale+revalidating, then the server data replaces it and is cached', async () => {
    const { cache } = await freshStores()
    await cache.put('k', { n: 1 })
    vi.stubGlobal('navigator', { onLine: true })
    let release!: (v: { n: number }) => void
    const fetcher = vi.fn(() => new Promise<{ n: number }>((r) => (release = r))) // a slow / unreachable server
    const s = settle<{ n: number }>()
    expect(await readThrough(cache, 'k', fetcher, s.onSettled)).toEqual({ data: { n: 1 }, stale: true, revalidating: true })
    release({ n: 2 })
    expect(await s.p).toEqual({ data: { n: 2 }, stale: false })
    await new Promise((r) => setTimeout(r, 20))
    expect(await cache.get('k')).toEqual({ n: 2 })
  })

  it('background failure keeps the snapshot, still marked stale, and does not overwrite it', async () => {
    const { cache } = await freshStores()
    await cache.put('k', { n: 1 })
    vi.stubGlobal('navigator', { onLine: true })
    const s = settle<{ n: number }>()
    await readThrough(cache, 'k', async () => { throw new Error('down') }, s.onSettled)
    expect(await s.p).toEqual({ data: { n: 1 }, stale: true })
    expect(await cache.get('k')).toEqual({ n: 1 })
  })

  it('without a snapshot it waits for the server (nothing stale to show); without onSettled it stays network-first', async () => {
    const { cache } = await freshStores()
    vi.stubGlobal('navigator', { onLine: true })
    const onSettled = vi.fn()
    expect(await readThrough(cache, 'none', async () => ({ n: 3 }), onSettled)).toEqual({ data: { n: 3 }, stale: false })
    expect(onSettled).not.toHaveBeenCalled()
    await cache.put('k', { n: 1 })
    expect(await readThrough(cache, 'k', async () => ({ n: 2 }))).toEqual({ data: { n: 2 }, stale: false })
  })

  it('offline: snapshot, no request, no background fetch; keys are per user so another user never sees it', async () => {
    const { cache } = await freshStores()
    await cache.put('A:wallets', { n: 1 })
    vi.stubGlobal('navigator', { onLine: false })
    const fetcher = vi.fn(async () => ({ n: 2 }))
    expect(await readThrough(cache, 'A:wallets', fetcher, vi.fn())).toEqual({ data: { n: 1 }, stale: true })
    expect(fetcher).not.toHaveBeenCalled()
    await expect(readThrough(cache, 'B:wallets', async () => { throw new Error('down') }, vi.fn())).rejects.toThrow('down')
  })
})

describe('cache keys are per user and wallet', () => {
  it('categories and budgets snapshots never collide across users, wallets or months', async () => {
    const { categoriesKey, budgetsKey } = await import('./localFinance')
    const keys = [categoriesKey('A', 'w1'), categoriesKey('B', 'w1'), categoriesKey('A', 'w2'), budgetsKey('A', 'w1', '2026-10-01'), budgetsKey('B', 'w1', '2026-10-01'), budgetsKey('A', 'w1', '2026-11-01')]
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.filter((k) => k.startsWith('A:')).length).toBe(4)
  })
})
