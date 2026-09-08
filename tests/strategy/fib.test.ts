import { describe, expect, it } from 'vitest'
import type { Swing } from '../../src/domain/types.js'
import { fibLevels, rrAt, tpFor } from '../../src/strategy/fib.js'

const swing: Swing = {
  lowTs: 0, low: '100', highTs: 1000, high: '200', confirmedAtTs: 1000, provisional: false,
}

const OPTS = {
  fibEntry: 0.886, fibZoneTop: 0.786, slBufferPct: 2,
  alertLevels: [0.5, 0.618, 0.786],
}

describe('fibLevels', () => {
  it('regner ut sonen fra specens eksempel 100 → 200', () => {
    const l = fibLevels(swing, OPTS)
    expect(l.zoneBottom).toBeCloseTo(111.4, 6)
    expect(l.zoneTop).toBeCloseTo(121.4, 6)
    expect(l.sl).toBeCloseTo(98, 6)
  })

  it('gir en sone der bunnen er lavere enn toppen', () => {
    const l = fibLevels(swing, OPTS)
    expect(l.zoneBottom).toBeLessThan(l.zoneTop)
  })

  it('gir varselpriser for hvert konfigurert nivå, fallende', () => {
    const l = fibLevels(swing, OPTS)
    expect(l.alerts.map((a) => a.level)).toEqual([0.5, 0.618, 0.786])
    expect(l.alerts[0]!.price).toBeCloseTo(150, 6)
    expect(l.alerts[1]!.price).toBeCloseTo(138.2, 6)
    expect(l.alerts[2]!.price).toBeCloseTo(121.4, 6)
    expect(l.alerts[0]!.price).toBeGreaterThan(l.alerts[2]!.price)
  })

  it('skalerer med beinets størrelse', () => {
    const big = fibLevels({ ...swing, low: '1000', high: '5000' }, OPTS)
    expect(big.zoneBottom).toBeCloseTo(5000 - 0.886 * 4000, 6)
  })
})

describe('rrAt og tpFor', () => {
  it('gir RR ≈ 5 for specens eksempel', () => {
    const l = fibLevels(swing, OPTS)
    expect(rrAt(l.zoneBottom, l.sl, 60)).toBeCloseTo(5.0, 1)
  })

  it('gir lavere RR ved dårligere fyll høyt i sonen', () => {
    const l = fibLevels(swing, OPTS)
    expect(rrAt(l.zoneTop, l.sl, 60)).toBeLessThan(rrAt(l.zoneBottom, l.sl, 60))
  })

  it('regner TP fra faktisk fyllpris, ikke fra sonebunnen', () => {
    expect(tpFor(111.4, 60)).toBeCloseTo(178.24, 2)
    expect(tpFor(121.4, 60)).toBeCloseTo(194.24, 2)
  })

  it('gir RR = 0 når stoppen ligger på eller over fyllprisen', () => {
    expect(rrAt(100, 100, 60)).toBe(0)
    expect(rrAt(100, 120, 60)).toBe(0)
  })
})
