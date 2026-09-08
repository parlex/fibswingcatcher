import { describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters } from 'viem'
import { LiveStream, type StreamEvent } from '../../src/data/live.js'
import type { PoolMeta } from '../../src/data/pool.js'

const meta: PoolMeta = {
  address: '0x1111111111111111111111111111111111111111',
  token0: '0xaaaa000000000000000000000000000000000000',
  token1: '0xbbbb000000000000000000000000000000000000',
  decimals0: 18, decimals1: 18, baseIsToken0: true, feeBps: 30,
}

const Q96 = 2n ** 96n
const mkLog = (logIndex: number) => ({
  blockNumber: 1n, logIndex, transactionHash: `0x${logIndex}`,
  topics: ['0x00'],
  data: encodeAbiParameters(
    [{ type: 'int256' }, { type: 'int256' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }],
    [-1n, 1n, Q96, 0n, 0],
  ),
})

function harness(maxStalenessMs = 10_000) {
  let onLog: ((l: ReturnType<typeof mkLog>) => void) | undefined
  let onError: ((e: Error) => void) | undefined
  let clock = 0
  const timers: { fn: () => void; at: number }[] = []
  const events: StreamEvent[] = []
  const unsubscribe = vi.fn()
  const subscribe = vi.fn((l: typeof onLog, e: typeof onError) => {
    onLog = l; onError = e; return unsubscribe
  })

  const clearTimer = vi.fn((t: unknown) => { const i = timers.indexOf(t as never); if (i >= 0) timers.splice(i, 1) })

  const stream = new LiveStream({
    subscribe: subscribe as never,
    now: () => clock,
    setTimer: (fn: () => void, ms: number) => { const t = { fn, at: clock + ms }; timers.push(t); return t },
    clearTimer,
    maxStalenessMs,
    meta,
    blockTs: async () => 1_700_000_000,
  })
  stream.on((e) => events.push(e))

  return {
    stream, events, subscribe, unsubscribe, clearTimer, timers,
    emitLog: (i: number) => onLog?.(mkLog(i)),
    emitError: (e: Error) => onError?.(e),
    advance: (ms: number) => {
      clock += ms
      for (const t of [...timers]) if (t.at <= clock) { timers.splice(timers.indexOf(t), 1); t.fn() }
    },
  }
}

describe('LiveStream', () => {
  it('abonnerer ved start', () => {
    const h = harness()
    h.stream.start()
    expect(h.subscribe).toHaveBeenCalledOnce()
  })

  it('sender dekodede handler videre', async () => {
    const h = harness()
    h.stream.start()
    h.emitLog(0)
    await vi.waitFor(() => expect(h.events.filter((e) => e.kind === 'trade')).toHaveLength(1))
  })

  it('sender stale når det går for lenge uten event', () => {
    const h = harness(10_000)
    h.stream.start()
    h.advance(10_001)
    expect(h.events.at(-1)).toMatchObject({ kind: 'stale' })
  })

  it('sender ikke stale når events kommer jevnlig', async () => {
    const h = harness(10_000)
    h.stream.start()
    for (let i = 0; i < 5; i++) { h.advance(5_000); h.emitLog(i); await vi.waitFor(() => {}) }
    expect(h.events.some((e) => e.kind === 'stale')).toBe(false)
  })

  it('sender healthy igjen når data kommer tilbake etter stale', async () => {
    const h = harness(10_000)
    h.stream.start()
    h.advance(10_001)
    h.emitLog(0)
    await vi.waitFor(() => expect(h.events.some((e) => e.kind === 'healthy')).toBe(true))
  })

  it('abonnerer på nytt etter feil', () => {
    const h = harness()
    h.stream.start()
    h.emitError(new Error('socket lukket'))
    h.advance(60_000)
    expect(h.subscribe.mock.calls.length).toBeGreaterThan(1)
  })

  it('sier opp abonnementet ved stop og abonnerer ikke på nytt', () => {
    const h = harness()
    h.stream.start()
    h.stream.stop()
    expect(h.unsubscribe).toHaveBeenCalled()
    h.advance(120_000)
    expect(h.subscribe).toHaveBeenCalledOnce()
  })

  it('deduplikerer gjentatte logger', async () => {
    const h = harness()
    h.stream.start()
    h.emitLog(0); h.emitLog(0)
    await vi.waitFor(() => expect(h.events.filter((e) => e.kind === 'trade')).toHaveLength(1))
  })

  it('sender stale bare én gang per stale-episode, ikke én gang per varslingsvindu', () => {
    const h = harness(10_000)
    h.stream.start()
    h.advance(10_001) // krysser terskelen første gang
    h.advance(10_000) // fortsatt ingen event — samme episode
    h.advance(10_000) // fortsatt ingen event — samme episode
    h.advance(10_000) // fortsatt ingen event — samme episode
    expect(h.events.filter((e) => e.kind === 'stale')).toHaveLength(1)
  })

  it('nullstiller stale-undertrykkelsen ved recovery, så en ny episode gir en ny stale-hendelse', async () => {
    const h = harness(10_000)
    h.stream.start()
    h.advance(10_001)
    h.emitLog(0)
    await vi.waitFor(() => expect(h.events.some((e) => e.kind === 'healthy')).toBe(true))
    h.advance(10_001) // ny episode etter recovery
    expect(h.events.filter((e) => e.kind === 'stale')).toHaveLength(2)
  })

  it('fjerner et ventende reconnect-timer ved stop, ikke bare no-oper det', () => {
    const h = harness()
    h.stream.start()
    h.emitError(new Error('socket lukket')) // planlegger et reconnect-forsøk
    expect(h.timers.length).toBe(2) // stale-timer + ventende reconnect-timer
    h.stream.stop()
    expect(h.timers.length).toBe(0) // begge håndtak faktisk fjernet, ikke bare no-opet
    expect(h.clearTimer).toHaveBeenCalledTimes(2)
    h.advance(120_000)
    expect(h.subscribe).toHaveBeenCalledOnce()
  })
})
