import { describe, expect, it } from 'vitest'
import type { Bar } from '../../src/domain/types.js'
import { detectSwings } from '../../src/strategy/swings.js'

const H = 3_600_000
const OPTS = {
  minSwingPct: 15,
  minSwingDurationMs: 0,
  minSwingVolumeQuote: 0n,
}

let seq = 0
const bar = (low: number, high: number, volume = 1_000_000n): Bar => {
  const openTs = ++seq * H
  return {
    openTs,
    open: String(low), high: String(high), low: String(low), close: String(high),
    volumeQuote: volume, tradeCount: 10,
  }
}
const reset = () => { seq = 0 }

describe('detectSwings', () => {
  it('finner et bein opp når bevegelsen overstiger minSwingPct', () => {
    reset()
    const bars = [bar(100, 105), bar(90, 95), bar(95, 130), bar(120, 125)]
    const swings = detectSwings(bars, OPTS)
    expect(swings).toHaveLength(1)
    expect(swings[0]!.low).toBe('90')
    expect(swings[0]!.high).toBe('130')
    expect(swings[0]!.lowTs).toBe(2 * H)
    expect(swings[0]!.highTs).toBe(3 * H)
  })

  it('merker et pågående bein som provisorisk', () => {
    reset()
    const bars = [bar(100, 105), bar(90, 95), bar(95, 130)]
    expect(detectSwings(bars, OPTS)[0]!.provisional).toBe(true)
  })

  it('merker et bein som bekreftet når prisen har retracet nok', () => {
    reset()
    const bars = [bar(100, 105), bar(90, 95), bar(95, 130), bar(100, 105)]
    const confirmed = detectSwings(bars, OPTS).filter((s) => !s.provisional)
    expect(confirmed).toHaveLength(1)
    expect(confirmed[0]!.high).toBe('130')
  })

  it('ignorerer bevegelser under minSwingPct', () => {
    reset()
    const bars = [bar(100, 101), bar(99, 100), bar(100, 105), bar(103, 104)]
    expect(detectSwings(bars, OPTS)).toEqual([])
  })

  it('avviser bein som er kortere enn minSwingDurationMs', () => {
    reset()
    const bars = [bar(100, 105), bar(90, 95), bar(95, 130)]
    const strict = { ...OPTS, minSwingDurationMs: 10 * H }
    expect(detectSwings(bars, strict)).toEqual([])
  })

  it('avviser bein med for lite volum', () => {
    reset()
    const bars = [bar(100, 105, 1n), bar(90, 95, 1n), bar(95, 130, 1n)]
    const strict = { ...OPTS, minSwingVolumeQuote: 1_000n }
    expect(detectSwings(bars, strict)).toEqual([])
  })

  it('flytter kandidatbunnen ned så lenge nye lows kommer', () => {
    reset()
    const bars = [bar(100, 102), bar(80, 85), bar(60, 65), bar(65, 100)]
    const swings = detectSwings(bars, OPTS)
    expect(swings[0]!.low).toBe('60')
  })

  it('finner flere påfølgende bein', () => {
    reset()
    const bars = [
      bar(100, 105), bar(50, 55), bar(55, 90),
      bar(85, 88), bar(60, 65), bar(65, 120),
    ]
    expect(detectSwings(bars, OPTS).length).toBeGreaterThanOrEqual(2)
  })

  it('setter confirmedAtTs til baren som brøt terskelen, ikke til toppen', () => {
    reset()
    const bars = [bar(100, 105), bar(90, 95), bar(95, 130), bar(125, 200)]
    const swings = detectSwings(bars, OPTS)
    // Bar 4 utvider candidateHigh til 200 (highTs flytter seg til 4*H), men
    // legConfirmedAtTs ble satt én gang ved bunnbekreftelsen på bar 3 og
    // rører seg ikke — de to feltene divergerer bevisst i denne fixturen.
    expect(swings[0]!.confirmedAtTs).toBe(3 * H)
    expect(swings[0]!.highTs).toBe(4 * H)
  })

  it('nullstiller volumeSinceLow når kandidatbunnen flytter seg videre ned', () => {
    reset()
    // Uten nullstillingen når candidateLow flytter seg ned, ville det store
    // volumet fra baren FØR bunnen flyttet seg (10_000n) lekke inn i beinet
    // som til slutt bekreftes, og terskelen på 3n ville feilaktig bli passert
    // (10_000n+1n+1n=10_002n) i stedet for korrekt avvist (1n+1n=2n).
    const bars = [bar(100, 102, 10_000n), bar(50, 55, 1n), bar(55, 90, 1n)]
    const strict = { ...OPTS, minSwingVolumeQuote: 3n }
    expect(detectSwings(bars, strict)).toEqual([])
  })

  it('nullstiller volumeSinceLow når retningen snur tilbake til ned', () => {
    reset()
    // Bein 1 bekreftes med et stort volum (10_000n) ved bar 3 (som også
    // flipper retningen tilbake til ned). Uten nullstilling ved den flippen
    // ville dette store volumet lekke inn i bein 2, som ellers korrekt
    // avvises (2n < 3n) men feilaktig ville passere (10_001n >= 3n).
    const bars = [
      bar(100, 105), bar(90, 95), bar(95, 130, 10_000n),
      bar(100, 105, 1n), bar(105, 120, 1n),
    ]
    const strict = { ...OPTS, minSwingVolumeQuote: 3n }
    expect(detectSwings(bars, strict)).toHaveLength(1)
  })

  it('lar baren som etablerer den nye kandidatbunnen telle mot det nye beinet, ikke det gamle', () => {
    reset()
    // Bein 1 (50->90) lukkes av bar 4, som samtidig ER lavpunktet for bein 2
    // (60->120). Bar 4 sitt volum (1000n) skal telle mot bein 2, ikke bein 1.
    const bars = [
      bar(100, 105, 0n), bar(50, 55, 0n), bar(55, 90, 0n),
      bar(60, 65, 1000n), bar(65, 120, 0n),
    ]
    const strict = { ...OPTS, minSwingVolumeQuote: 500n }
    const swings = detectSwings(bars, strict)
    // Bein 1 har volumeSinceLow=0 (bar 4 sitt volum tilhører ikke bein 1) og
    // avvises derfor på 500n-terskelen. Bein 2 har volumeSinceLow=1000n
    // (starter med bar 4 sitt volum) og godkjennes.
    expect(swings).toHaveLength(1)
    expect(swings[0]!.low).toBe('60')
  })

  it('bevarer desimalpresisjonen i low/high (ingen Number-avrunding)', () => {
    reset()
    const barExact = (low: string, high: string, volume = 1_000_000n): Bar => {
      const openTs = ++seq * H
      return {
        openTs,
        open: low, high, low, close: high,
        volumeQuote: volume, tradeCount: 10,
      }
    }
    // '0.00000012345' ville blitt til '1.2345e-7' hvis verdien noen gang gikk
    // via Number() på vei ut. minSwingPct=15%: 0.00000012345*1.15=0.0000001419675.
    const bars = [
      barExact('0.00000012345', '0.00000013'),
      barExact('0.00000013', '0.00000015'),
      barExact('0.0000001', '0.00000015'),
    ]
    const swings = detectSwings(bars, OPTS)
    const confirmed = swings.filter((s) => !s.provisional)
    expect(confirmed).toHaveLength(1)
    expect(confirmed[0]!.low).toBe('0.00000012345')
    expect(confirmed[0]!.high).toBe('0.00000015')
  })
})

describe('kausalitet', () => {
  it('et BEKREFTET bein endrer seg aldri når framtidige bars legges til', () => {
    reset()
    const bars: Bar[] = []
    for (let i = 0; i < 60; i++) {
      const base = 100 + Math.sin(i / 3) * 40
      bars.push(bar(Math.round(base - 5), Math.round(base + 5)))
    }

    for (let n = 1; n <= bars.length; n++) {
      const prefix = detectSwings(bars.slice(0, n), OPTS).filter((s) => !s.provisional)
      const full = detectSwings(bars, OPTS)
      for (const s of prefix) {
        const match = full.find((f) => f.confirmedAtTs === s.confirmedAtTs)
        expect(match, `bein bekreftet ved ${s.confirmedAtTs} forsvant`).toBeDefined()
        expect(match).toEqual(s)
      }
    }
  })
})
