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
const mkLog = (logIndex: number, opts: { txHash?: string; blockNumber?: bigint } = {}) => ({
  blockNumber: opts.blockNumber ?? 1n,
  logIndex,
  transactionHash: opts.txHash ?? `0x${logIndex}`,
  topics: ['0x00'],
  data: encodeAbiParameters(
    [{ type: 'int256' }, { type: 'int256' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }],
    [-1n, 1n, Q96, 0n, 0],
  ),
})

function harness(maxStalenessMs = 10_000, reorgDepthBlocks = 20) {
  let onLog: ((l: ReturnType<typeof mkLog>) => void) | undefined
  let onError: ((e: Error) => void) | undefined
  let clock = 0
  const timers: { fn: () => void; at: number }[] = []
  const events: StreamEvent[] = []
  const calls: { onLog: typeof onLog; onError: typeof onError }[] = []
  const unsubscribe = vi.fn()
  const subscribe = vi.fn((l: typeof onLog, e: typeof onError) => {
    onLog = l; onError = e
    calls.push({ onLog: l, onError: e })
    return unsubscribe
  })

  const setTimer = vi.fn((fn: () => void, ms: number) => { const t = { fn, at: clock + ms }; timers.push(t); return t })
  const clearTimer = vi.fn((t: unknown) => { const i = timers.indexOf(t as never); if (i >= 0) timers.splice(i, 1) })

  const stream = new LiveStream({
    subscribe: subscribe as never,
    now: () => clock,
    setTimer,
    clearTimer,
    maxStalenessMs,
    meta,
    reorgDepthBlocks,
    blockTs: async () => 1_700_000_000,
  })
  stream.on((e) => events.push(e))

  return {
    stream, events, subscribe, unsubscribe, setTimer, clearTimer, timers, calls, maxStalenessMs,
    emitLog: (i: number, opts?: { txHash?: string; blockNumber?: bigint }) => onLog?.(mkLog(i, opts)),
    emitError: (e: Error) => onError?.(e),
    advance: (ms: number) => {
      clock += ms
      const due = timers.filter((t) => t.at <= clock).sort((a, b) => a.at - b.at)
      for (const t of due) {
        const i = timers.indexOf(t)
        if (i >= 0) timers.splice(i, 1)
        t.fn()
      }
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

  // --- Fix round 2 ---

  it('sender ikke en trade som ble mottatt før stop, men hvis blockTs fortsatt er i flukt', async () => {
    let resolveTs: (v: number) => void = () => {}
    let onLog: ((l: ReturnType<typeof mkLog>) => void) | undefined
    let onError: ((e: Error) => void) | undefined
    let clock = 0
    const timers: { fn: () => void; at: number }[] = []
    const events: StreamEvent[] = []
    const unsubscribe = vi.fn()
    const subscribe = vi.fn((l: typeof onLog, e: typeof onError) => { onLog = l; onError = e; return unsubscribe })
    const stream = new LiveStream({
      subscribe: subscribe as never,
      now: () => clock,
      setTimer: (fn: () => void, ms: number) => { const t = { fn, at: clock + ms }; timers.push(t); return t },
      clearTimer: (t: unknown) => { const i = timers.indexOf(t as never); if (i >= 0) timers.splice(i, 1) },
      maxStalenessMs: 10_000,
      meta,
      reorgDepthBlocks: 20,
      blockTs: () => new Promise<number>((resolve) => { resolveTs = resolve }),
    })
    stream.on((e) => events.push(e))

    stream.start()
    onLog?.(mkLog(0)) // starter handleLog, henger fast på blockTs-awaiten
    stream.stop() // stopper mens awaiten fortsatt er i flukt
    resolveTs(1_700_000_000) // la awaiten løse seg, lenge etter stop
    await vi.waitFor(() => {})

    expect(events.filter((e) => e.kind === 'trade')).toHaveLength(0)
  })

  it('ignorerer en sent levert logg etter stop, selv om strømmen var stale (top-vakt)', () => {
    const h = harness(10_000)
    h.stream.start()
    h.advance(10_001)
    expect(h.events.some((e) => e.kind === 'stale')).toBe(true)
    h.stream.stop()
    h.emitLog(0) // sen levering fra den (allerede avmeldte) gamle sokkelen
    expect(h.events.some((e) => e.kind === 'healthy')).toBe(false)
  })

  it('planlegger bare ett reconnect-forsøk selv om samme sokkel feiler to ganger', () => {
    const h = harness()
    h.stream.start()
    h.emitError(new Error('e1'))
    h.emitError(new Error('e2')) // duplikat feil på samme døde sokkel, før reconnect har fyrt
    expect(h.timers.length).toBe(2) // stale-timer + nøyaktig én ventende reconnect-timer
    h.advance(60_000)
    expect(h.subscribe.mock.calls.length).toBe(2) // opprinnelig abonnement + nøyaktig ett reconnect-forsøk
  })

  it('ignorerer feil fra en forlatt sokkel etter vellykket reconnect (generasjonsvakt)', () => {
    const h = harness()
    h.stream.start()
    const staleOnError = h.calls[0]!.onError!
    h.emitError(new Error('e1')) // ekte feil på første sokkel -> planlegger reconnect
    h.advance(1_000) // reconnect fyrer, ny (sunn) sokkel abonneres
    expect(h.subscribe.mock.calls.length).toBe(2)
    const unsubscribeCallsAfterReconnect = h.unsubscribe.mock.calls.length

    staleOnError(new Error('sen feil fra den forlatte sokkelen')) // spøkelse fra forrige generasjon

    expect(h.unsubscribe.mock.calls.length).toBe(unsubscribeCallsAfterReconnect) // rørte ikke det nye abonnementet
    h.advance(60_000)
    expect(h.subscribe.mock.calls.length).toBe(2) // ingen ekstra reconnect utløst av spøkelsesfeilen
  })

  it('sender ikke healthy for en vanlig handel uten forutgående stale', () => {
    const h = harness()
    h.stream.start()
    h.emitLog(0)
    expect(h.events.filter((e) => e.kind === 'healthy')).toHaveLength(0)
  })

  it('sender nøyaktig én healthy-hendelse ved recovery, ikke på hver påfølgende handel', async () => {
    const h = harness(10_000)
    h.stream.start()
    h.advance(10_001)
    h.emitLog(0) // recovery — skal sende healthy nøyaktig én gang
    expect(h.events.filter((e) => e.kind === 'healthy')).toHaveLength(1)
    h.emitLog(1) // ordinær handel etter recovery — skal IKKE sende healthy på nytt
    expect(h.events.filter((e) => e.kind === 'healthy')).toHaveLength(1)
    await vi.waitFor(() => expect(h.events.filter((e) => e.kind === 'trade')).toHaveLength(2))
  })

  it('backoff dobles for hver feil og nullstilles etter en vellykket logg', async () => {
    const h = harness()
    h.stream.start()
    h.emitError(new Error('e1'))
    h.advance(1_000)
    h.emitError(new Error('e2'))
    h.advance(2_000)
    h.emitError(new Error('e3'))
    h.advance(4_000)
    h.emitLog(0)
    await vi.waitFor(() => expect(h.events.filter((e) => e.kind === 'trade')).toHaveLength(1))
    h.emitError(new Error('e4'))

    const reconnectDelays = h.setTimer.mock.calls
      .map(([, ms]) => ms)
      .filter((ms) => ms !== h.maxStalenessMs)
    expect(reconnectDelays).toEqual([1000, 2000, 4000, 1000])
  })

  it('kaster ut dedupe-nøkler utenfor reorg-vinduet, men fanger duplikater innenfor', async () => {
    const h = harness(10_000, 3) // reorgDepthBlocks = 3

    h.stream.start()
    h.emitLog(0, { blockNumber: 1n, txHash: '0xaaa' })
    await vi.waitFor(() => expect(h.events.filter((e) => e.kind === 'trade')).toHaveLength(1))

    // samme nøkkel, fortsatt innenfor reorg-vinduet (delta 2 <= 3) — skal fanges som duplikat
    h.emitLog(0, { blockNumber: 3n, txHash: '0xaaa' })
    await vi.waitFor(() => {})
    expect(h.events.filter((e) => e.kind === 'trade')).toHaveLength(1)

    // ny logg langt utenfor vinduet (delta 9 > 3) — kaster ut den gamle nøkkelen
    h.emitLog(1, { blockNumber: 10n, txHash: '0xccc' })
    await vi.waitFor(() => expect(h.events.filter((e) => e.kind === 'trade')).toHaveLength(2))

    // den opprinnelige nøkkelen dukker opp igjen — skal IKKE lenger anses som duplikat
    h.emitLog(0, { blockNumber: 1n, txHash: '0xaaa' })
    await vi.waitFor(() => expect(h.events.filter((e) => e.kind === 'trade')).toHaveLength(3))
  })

  it('deduplikerer på txHash+logIndex, ikke bare på ett av feltene (samme tx, ulik logIndex)', async () => {
    const h = harness()
    h.stream.start()
    h.emitLog(0, { txHash: '0xsammetx' })
    h.emitLog(1, { txHash: '0xsammetx' }) // samme transaksjon, ny logIndex — ekte multi-swap-per-tx
    await vi.waitFor(() => expect(h.events.filter((e) => e.kind === 'trade')).toHaveLength(2))
  })

  it('start() er idempotent — et andre kall lager ikke et nytt abonnement', () => {
    const h = harness()
    h.stream.start()
    h.stream.start()
    expect(h.subscribe).toHaveBeenCalledOnce()
  })

  it('nullstiller stale-tilstanden ved start, slik at en omstart ikke sender spøkelses-healthy', () => {
    const h = harness(10_000)
    h.stream.start()
    h.advance(10_001)
    expect(h.events.some((e) => e.kind === 'stale')).toBe(true)
    h.stream.stop()
    h.stream.start() // omstart mens den fortsatt var stale
    h.emitLog(0) // den aller første handelen etter omstart
    expect(h.events.some((e) => e.kind === 'healthy')).toBe(false)
  })

  it('fyrer forfalte timere i planlagt rekkefølge (at), ikke innsettingsrekkefølge', () => {
    const h = harness()
    const order: string[] = []
    // planlegges i rekkefølge B, A, C — men med forfallstidspunkt A < B < C
    h.setTimer(() => order.push('B'), 300)
    h.setTimer(() => order.push('A'), 100)
    h.setTimer(() => order.push('C'), 500)
    h.advance(500)
    expect(order).toEqual(['A', 'B', 'C'])
  })
})
