// Fake client only: verifies OUR lifecycle/invalidation logic, not Supabase's network behaviour (see supabase/hosted/realtime.verify.ts).
import { describe, expect, it, vi } from 'vitest'
import { subscribeWalletChanges, type RealtimeStatus } from './walletChanges'

function fakeClient() {
  const active = new Set<FakeChannel>()
  const opened: string[] = []
  class FakeChannel {
    handler: () => void = () => {}
    cb: (s: string, e?: Error) => void = () => {}
    constructor(readonly topic: string, readonly config: unknown) {
      active.add(this)
      opened.push(topic)
    }
    on(_t: string, _f: unknown, h: () => void) {
      this.handler = h
      return this
    }
    subscribe(cb: (s: string, e?: Error) => void) {
      this.cb = cb
      return this
    }
  }
  const client = {
    realtime: { setAuth: vi.fn(async () => {}) },
    channel: (topic: string, config: unknown) => new FakeChannel(topic, config),
    removeChannel: vi.fn(async (c: FakeChannel) => void active.delete(c)),
  }
  return { client: client as never, raw: client, active, opened }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('subscribeWalletChanges', () => {
  it('subscribes to the private wallet topic, once', async () => {
    const f = fakeClient()
    subscribeWalletChanges(f.client, 'w1', () => {})
    await tick()
    expect([...f.active].map((c) => [c.topic, c.config])).toEqual([['wallet:w1', { config: { private: true } }]])
  })
  it('wallet change: unsubscribe old, subscribe new, never more than one channel', async () => {
    const f = fakeClient()
    const off = subscribeWalletChanges(f.client, 'w1', () => {})
    await tick()
    off()
    subscribeWalletChanges(f.client, 'w2', () => {})
    await tick()
    expect([...f.active].map((c) => c.topic)).toEqual(['wallet:w2'])
  })
  it('logout / unmount removes the channel; stopping before auth resolves never opens one', async () => {
    const f = fakeClient()
    subscribeWalletChanges(f.client, 'w1', () => {})()
    await tick()
    expect(f.opened).toEqual([])
    const off = subscribeWalletChanges(f.client, 'w1', () => {})
    await tick()
    off()
    expect(f.active.size).toBe(0)
  })
  it('a new authenticated user gets their own fresh subscription', async () => {
    const f = fakeClient()
    subscribeWalletChanges(f.client, 'w1', () => {})()
    subscribeWalletChanges(f.client, 'w9', () => {})
    await tick()
    expect([...f.active].map((c) => c.topic)).toEqual(['wallet:w9'])
  })
  it('each broadcast (insert/update/delete alike) calls the reload callback; nothing after unsubscribe', async () => {
    const f = fakeClient()
    const onChange = vi.fn()
    const off = subscribeWalletChanges(f.client, 'w1', onChange)
    await tick()
    const [c] = [...f.active]
    for (let i = 0; i < 3; i++) c!.handler() // INSERT, UPDATE, DELETE all arrive as the same event
    expect(onChange).toHaveBeenCalledTimes(3)
    off()
    c!.handler()
    expect(onChange).toHaveBeenCalledTimes(3)
  })
  it('status mapping; first connect does not reload, a rejoin after a drop reloads once', async () => {
    const f = fakeClient()
    const onChange = vi.fn()
    const seen: RealtimeStatus[] = []
    subscribeWalletChanges(f.client, 'w1', onChange, (s) => seen.push(s))
    await tick()
    const [c] = [...f.active]
    c!.cb('SUBSCRIBED')
    expect(onChange).not.toHaveBeenCalled()
    c!.cb('CHANNEL_ERROR', new Error('x'))
    c!.cb('TIMED_OUT')
    c!.cb('CLOSED')
    c!.cb('SUBSCRIBED')
    c!.cb('SUBSCRIBED')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(['CONNECTING', 'CONNECTED', 'ERROR', 'ERROR', 'DISCONNECTED', 'CONNECTED', 'CONNECTED'])
  })
  it('realtime failure never throws', async () => {
    const f = fakeClient()
    f.raw.realtime.setAuth.mockRejectedValueOnce(new Error('boom'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => subscribeWalletChanges(f.client, 'w1', () => {})).not.toThrow()
    await tick()
    expect(warn).toHaveBeenCalled()
  })
})
