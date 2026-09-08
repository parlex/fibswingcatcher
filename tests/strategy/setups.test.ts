import { describe, expect, it } from 'vitest'
import type { Swing } from '../../src/domain/types.js'
import { fibLevels } from '../../src/strategy/fib.js'
import { createSetup, evaluateSetup } from '../../src/strategy/setups.js'

const H = 3_600_000
const POOL = '0x1111111111111111111111111111111111111111' as const

const swing: Swing = { lowTs: 0, low: '100', highTs: 10 * H, high: '200', confirmedAtTs: 10 * H, provisional: false }
const FIB = { fibEntry: 0.886, fibZoneTop: 0.786, slBufferPct: 2, alertLevels: [0.5, 0.618, 0.786] }

const setup = () => createSetup(POOL, swing, FIB, 10 * H)
const ctx = (price: number, nowTs = 11 * H) => ({
  price, nowTs, intervalMs: H, maxSetupAgeBars: 48, minRR: 3, tpPct: 60,
})

describe('createSetup', () => {
  it('starter i DETECTED uten varsler sendt', () => {
    const s = setup()
    expect(s.state).toBe('DETECTED')
    expect(s.alertsSent).toEqual([])
    expect(s.levels.zoneBottom).toBeCloseTo(111.4, 6)
  })
})

describe('evaluateSetup', () => {
  it('holder seg i DETECTED når prisen er over alle nivåer', () => {
    const tr = evaluateSetup(setup(), ctx(190))
    expect(tr.state).toBe('DETECTED')
    expect(tr.newAlerts).toEqual([])
  })

  it('varsler om 0.5 når prisen krysser ned gjennom det', () => {
    const tr = evaluateSetup(setup(), ctx(149))
    expect(tr.newAlerts).toEqual([0.5])
  })

  it('varsler om alle passerte nivåer ved et raskt fall', () => {
    const tr = evaluateSetup(setup(), ctx(125))
    expect(tr.newAlerts).toEqual([0.5, 0.618])
  })

  it('varsler aldri om samme nivå to ganger', () => {
    const s = { ...setup(), alertsSent: [0.5, 0.618] }
    expect(evaluateSetup(s, ctx(125)).newAlerts).toEqual([])
  })

  it('varsler ikke på nytt når prisen spretter tilbake over et nivå', () => {
    const s = { ...setup(), alertsSent: [0.5] }
    const back = evaluateSetup(s, ctx(180))
    expect(back.newAlerts).toEqual([])
    const down = evaluateSetup({ ...s, alertsSent: back.newAlerts.concat(s.alertsSent) }, ctx(149))
    expect(down.newAlerts).toEqual([])
  })

  it('går til TRIGGERED når prisen er inne i sonen', () => {
    const tr = evaluateSetup(setup(), ctx(115))
    expect(tr.state).toBe('TRIGGERED')
  })

  it('går til INVALIDATED når prisen bryter under swing low', () => {
    const tr = evaluateSetup(setup(), ctx(99))
    expect(tr.state).toBe('INVALIDATED')
    expect(tr.reason).toMatch(/swing low/)
  })

  it('går til EXPIRED etter maxSetupAgeBars', () => {
    const tr = evaluateSetup(setup(), ctx(190, 10 * H + 49 * H))
    expect(tr.state).toBe('EXPIRED')
  })

  it('er ikke EXPIRED nøyaktig på maxSetupAgeBars-grensen', () => {
    const tr = evaluateSetup(setup(), ctx(190, 10 * H + 48 * H))
    expect(tr.state).toBe('DETECTED')
  })

  it('går til REJECTED når RR i sonen er under minRR', () => {
    const tr = evaluateSetup(setup(), { ...ctx(115), minRR: 99 })
    expect(tr.state).toBe('REJECTED')
    expect(tr.reason).toMatch(/RR/)
  })

  it('bruker faktisk pris, ikke zoneBottom, i RR-beregningen', () => {
    // rrAt(115, sl=98, 60) ≈ 4.06 (REJECTED at minRR 4.5),
    // rrAt(zoneBottom=111.4, sl=98, 60) ≈ 4.99 (would be TRIGGERED at minRR 4.5)
    const tr = evaluateSetup(setup(), { ...ctx(115), minRR: 4.5 })
    expect(tr.state).toBe('REJECTED')
  })

  it('ugyldiggjør når prisen er godt under swing low', () => {
    const tr = evaluateSetup(setup(), ctx(97))
    expect(tr.state).toBe('INVALIDATED')
  })

  it('zoneBottom er alltid over swing low, for enhver gyldig fibEntry', () => {
    // fibEntry er begrenset til (0, 1) i config-skjemaet. Siden
    // zoneBottom = high - fibEntry * range, og swing.low < high, er
    // zoneBottom strukturelt alltid over swing low — invalidering og
    // trigger kan derfor aldri kollidere, uavhengig av sjekkrekkefølge.
    const swingLow = Number(swing.low)
    for (const fibEntry of [0.5, 0.786, 0.886, 0.99]) {
      const levels = fibLevels(swing, {
        fibEntry, fibZoneTop: fibEntry - 0.1, slBufferPct: 2, alertLevels: [],
      })
      expect(levels.zoneBottom).toBeGreaterThan(swingLow)
    }
  })

  it('blir ikke TRIGGERED i gapet mellom swing low og zoneBottom', () => {
    // Med standardfixturen er zoneBottom 111.4. En pris i (100, 111.4)
    // skal verken ugyldiggjøre eller trigge.
    const tr = evaluateSetup(setup(), ctx(105))
    expect(tr.state).toBe('DETECTED')
  })

  it('bevarer en ikke-DETECTED tilstand når ingenting endres', () => {
    const s = { ...setup(), state: 'ARMED' as const }
    const tr = evaluateSetup(s, ctx(190))
    expect(tr.state).toBe('ARMED')
  })
})
