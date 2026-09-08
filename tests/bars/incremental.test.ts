import { describe, expect, it } from 'vitest'
import { IncrementalBars } from '../../src/bars/incremental.js'
import { aggregate } from '../../src/bars/aggregator.js'
import type { Trade } from '../../src/domain/types.js'

const H = 3_600_000
const ONE = 10n ** 18n

let seq = 0
const t = (ts: number, price: string, sizeQuote = ONE, logIndex?: number): Trade => {
  seq += 1
  return {
    ts,
    txHash: `0x${seq.toString(16).padStart(8, '0')}`,
    logIndex: logIndex ?? (seq * 7 + 3) % 101,
    priceQuote: price,
    sizeQuote,
    sizeBase: ONE,
    side: 'buy',
    liquidity: 1_000n * ONE,
  }
}

/** Et vindu så stort at ingenting klippes — klipping testes for seg. */
const HUGE = 10_000 * H

const build = (trades: Trade[], minSize = 0n, windowMs = HUGE): IncrementalBars => {
  const bars = new IncrementalBars(H, windowMs, minSize)
  for (const tr of trades) bars.add(tr)
  return bars
}

describe('IncrementalBars', () => {
  it('gir én bar med alle OHLC lik prisen for én handel', () => {
    expect(build([t(H + 10, '100')]).bars()).toEqual([
      { openTs: H, open: '100', high: '100', low: '100', close: '100', volumeQuote: ONE, tradeCount: 1 },
    ])
  })

  it('oppdaterer high, low, close og volum for flere handler i samme bøtte', () => {
    const bars = build([t(H + 10, '100'), t(H + 20, '120'), t(H + 30, '90'), t(H + 40, '110')]).bars()
    expect(bars).toHaveLength(1)
    expect(bars[0]).toMatchObject({
      openTs: H, open: '100', high: '120', low: '90', close: '110',
      volumeQuote: 4n * ONE, tradeCount: 4,
    })
  })

  it('fanger en topp som kommer sist i baren', () => {
    // Regimet en ekte pool alltid er i, og det ingen fixture i denne grenen
    // hadde da fib-nivåene ble tegnet fra en bar med én pris.
    const bars = build([t(H + 10, '150'), t(H + 20, '170'), t(H + 30, '200')]).bars()
    expect(bars[0]).toMatchObject({ high: '200', close: '200', open: '150' })
  })

  it('deler på bøttegrenser', () => {
    const bars = build([t(H + 1, '100'), t(2 * H + 1, '200')]).bars()
    expect(bars.map((b) => b.openTs)).toEqual([H, 2 * H])
  })

  it('hopper over tomme intervaller i stedet for å lage flate bars', () => {
    const bars = build([t(H, '100'), t(4 * H, '200')]).bars()
    expect(bars.map((b) => b.openTs)).toEqual([H, 4 * H])
  })

  it('filtrerer bort handler under minSize', () => {
    const bars = build([t(H, '100', 10n), t(H + 1, '999', 1n), t(H + 2, '110', 50n)], 10n).bars()
    expect(bars[0]).toMatchObject({ tradeCount: 2, high: '110' })
  })

  it('en handel som lander i en tidligere bøtte oppdaterer den baren', () => {
    const bars = build([
      t(H + 10, '100'),
      t(2 * H + 10, '200'),
      t(H + 20, '150'),   // sent levert, hører til bar 1
    ]).bars()
    expect(bars).toHaveLength(2)
    expect(bars[0]).toMatchObject({ high: '150', close: '150', tradeCount: 2 })
    expect(bars[1]).toMatchObject({ open: '200', tradeCount: 1 })
  })

  it('en sent levert handel endrer ikke close når den ikke er nyest i bøtta', () => {
    const bars = build([
      t(H + 30, '100'),
      t(H + 10, '150'),   // tidligere i samme bøtte
    ]).bars()
    expect(bars[0]).toMatchObject({ open: '150', close: '100', high: '150' })
  })

  it('bruker logIndex som tie-break når tidsstemplene er like', () => {
    const bars = build([t(H + 10, '100', ONE, 5), t(H + 10, '110', ONE, 3)]).bars()
    expect(bars[0]).toMatchObject({ open: '110', close: '100' })
  })

  it('den sist ankomne vinner close når både ts og logIndex er like', () => {
    // `aggregate` sorterer stabilt, så to identiske nøkler beholder
    // ankomstrekkefølgen og den siste setter close. Her ankommer den sist.
    const trades = [t(H + 10, '100', ONE, 5), t(H + 10, '110', ONE, 5)]
    expect(build(trades).bars()).toEqual(aggregate(trades, H, 0n))
    expect(build(trades).bars()[0]).toMatchObject({ open: '100', close: '110' })
  })

  it('justerer klippekanten ned til en barstart så den eldste baren er hel', () => {
    // Rå kant ville vært 5,5H og kastet bar 5H midt av. `detectSwings` tar
    // sin første kandidatbunn fra bars[0], så en halv bar der flytter
    // startpunktet for deteksjonen.
    const bars = new IncrementalBars(H, 5 * H, 0n)
    bars.add(t(5 * H + 10, '100'))
    bars.add(t(10 * H + H / 2, '200'))
    expect(bars.bars().map((b) => b.openTs)).toEqual([5 * H, 10 * H])
  })

  it('klipper bars utenfor vinduet og holder antallet bundet', () => {
    const bars = new IncrementalBars(H, 5 * H, 0n)
    for (let i = 0; i < 500; i++) bars.add(t(i * H + 10, String(100 + i)))
    expect(bars.size()).toBeLessThanOrEqual(7)
    expect(bars.bars().at(-1)).toMatchObject({ openTs: 499 * H, close: '599' })
  })

  it('beholder rå desimalstrenger uten å reserialisere dem', () => {
    const bars = build([t(H, '0.00000012345'), t(H + 1, '0.00000015')]).bars()
    expect(bars[0]).toMatchObject({ open: '0.00000012345', high: '0.00000015', low: '0.00000012345' })
  })
})

describe('IncrementalBars er ekvivalent med aggregate', () => {
  /** Deterministisk LCG, så en feil er reproduserbar. */
  function rng(seed: number): () => number {
    let s = seed
    return () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff
      return s / 0x7fffffff
    }
  }

  /**
   * Dette er testen som gjør det trygt å bytte ut `aggregate` i hot-pathen.
   *
   * `aggregate` er den ene beviste kilden til bar-bygging i dette prosjektet.
   * En inkrementell variant er bare verdt noe hvis den gir bit-identiske
   * bars for enhver handelssekvens — inkludert uordnet levering, like
   * tidsstempler og handler under terskelen.
   */
  /**
   * Generatoren lager kollisjoner med vilje.
   *
   * Første utgave av denne testen hadde null like tidsstempler over 2 400
   * handler: steget var alltid positivt og `logIndex` kom fra en global
   * teller. Dermed hvilte `>=`/`<`-asymmetrien i `fold` — den subtileste
   * delen av filen — på to håndskrevne tilfeller. Nå står steget ofte stille,
   * og `logIndex` trekkes fra et lite sett, så både like `ts` og like
   * `(ts, logIndex)` forekommer. En sent levert handel bærer da rutinemessig
   * en *lavere* logIndex enn en alt sett handel på samme `ts`, som er
   * korrelasjonen ekte per-blokk-indekser har.
   */
  function fuzzTrades(seed: number): Trade[] {
    const r = rng(seed)
    const trades: Trade[] = []
    let ts = H
    for (let i = 0; i < 400; i++) {
      // Hvert tiende steg står stille, så tidsstempler kolliderer.
      ts += r() < 0.1 ? 0 : Math.floor(r() * (H / 3))
      // Hver tiende handel leveres ut av rekkefølge, opptil to bars bakover.
      const jitter = r() < 0.1 ? -Math.floor(r() * 2 * H) : 0
      const price = (0.5 + r() * 200).toPrecision(9)
      const size = r() < 0.15 ? 5n : ONE   // ~15 % under terskelen
      trades.push(t(Math.max(H, ts + jitter), price, size, Math.floor(r() * 4)))
    }
    return trades
  }

  const SEEDS = [1, 7, 42, 1337, 90210, 271828]

  it('generatoren lager faktisk kollisjoner — ellers tester fuzzingen ingenting', () => {
    let sameTs = 0
    let sameKey = 0
    for (const seed of SEEDS) {
      const tr = fuzzTrades(seed)
      const byTs = new Map<number, number[]>()
      for (const x of tr) {
        const at = byTs.get(x.ts) ?? []
        if (at.length > 0) sameTs += 1
        if (at.includes(x.logIndex)) sameKey += 1
        at.push(x.logIndex)
        byTs.set(x.ts, at)
      }
    }
    expect(sameTs).toBeGreaterThan(50)
    expect(sameKey).toBeGreaterThan(10)
  })

  for (const seed of SEEDS) {
    it(`gir identiske bars som aggregate for tilfeldig sekvens (seed ${seed})`, () => {
      const trades = fuzzTrades(seed)
      const minSize = 10n
      expect(build(trades, minSize).bars()).toEqual(aggregate(trades, H, minSize))
    })

    it(`er identisk med aggregate også med et endelig vindu (seed ${seed})`, () => {
      // Pruning var ikke med i fuzzingen i det hele tatt — bare to
      // håndskrevne tilfeller. Kanten er monotont stigende, så inkrementell
      // klipping skal gi samme resultat som å filtrere handlene én gang på
      // den endelige kanten.
      const trades = fuzzTrades(seed)
      const minSize = 10n
      const windowMs = 8 * H
      const newest = Math.max(...trades.filter((x) => x.sizeQuote >= minSize).map((x) => x.ts))
      const cutoff = Math.floor((newest - windowMs) / H) * H

      const actual = build(trades, minSize, windowMs).bars()
      const expected = aggregate(trades.filter((x) => x.ts >= cutoff), H, minSize)

      expect(actual).toEqual(expected)
      expect(actual.length).toBeLessThan(12)   // vinduet biter faktisk
    })
  }

  it('er identisk med aggregate også når alt leveres i omvendt rekkefølge', () => {
    const trades: Trade[] = []
    for (let i = 0; i < 120; i++) trades.push(t(H + i * 90_000, String(100 + (i % 17))))
    const reversed = [...trades].reverse()

    expect(build(reversed).bars()).toEqual(aggregate(reversed, H, 0n))
  })
})
