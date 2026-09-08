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
    expect(swings[0]!.confirmedAtTs).toBe(3 * H)
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
