import { describe, expect, it } from 'vitest'
import { formatAlert } from '../../src/alerts/format.js'
import { createSetup } from '../../src/strategy/setups.js'
import type { Swing } from '../../src/domain/types.js'

const POOL = '0x1111111111111111111111111111111111111111' as const
const swing: Swing = { lowTs: 0, low: '100', highTs: 1000, high: '200', confirmedAtTs: 1000, provisional: false }
const FIB = { fibEntry: 0.886, fibZoneTop: 0.786, slBufferPct: 2, alertLevels: [0.5, 0.618, 0.786] }
const s = createSetup(POOL, swing, FIB, 1000)

describe('formatAlert', () => {
  it('nevner tokenet, nivået og prisen i et milepælsvarsel', () => {
    const txt = formatAlert({ kind: 'milestone', setup: s, level: 0.618, price: 138.2 }, 'PEPE/WETH')
    expect(txt).toContain('PEPE/WETH')
    expect(txt).toContain('0.618')
    expect(txt).toContain('138.2')
  })

  it('viser avstanden ned til entry-sonen', () => {
    const txt = formatAlert({ kind: 'milestone', setup: s, level: 0.618, price: 138.2 }, 'X/WETH')
    expect(txt).toMatch(/sone/i)
    expect(txt).toContain('121.4')
    expect(txt).toContain('111.4')
  })

  it('markerer sonevarselet tydeligere enn milepælsvarselet', () => {
    const zone = formatAlert({ kind: 'zone', setup: s, price: 115 }, 'X/WETH')
    expect(zone).toMatch(/SONE/i)
    expect(zone).toContain('98')
  })

  it('oppgir begrunnelse ved ugyldiggjøring', () => {
    const txt = formatAlert({ kind: 'invalidated', setup: s, reason: 'pris under swing low' }, 'X/WETH')
    expect(txt).toContain('pris under swing low')
  })

  it('formaterer degradert drift med varighet i sekunder', () => {
    expect(formatAlert({ kind: 'degraded', sinceMs: 45_000 }, '')).toContain('45')
  })

  it('formaterer gjenopprettet drift', () => {
    expect(formatAlert({ kind: 'recovered' }, '')).toMatch(/tilbake|gjenoppr/i)
  })
})
