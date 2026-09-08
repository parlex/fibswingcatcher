import { describe, expect, it } from 'vitest'
import { toBaseUnits } from '../../src/domain/units.js'

describe('toBaseUnits', () => {
  it('skalerer et helt tall med tokenets desimaler', () => {
    expect(toBaseUnits('50', 6)).toBe(50_000_000n)
    expect(toBaseUnits('50', 18)).toBe(50_000_000_000_000_000_000n)
  })

  it('skalerer en desimalverdi', () => {
    expect(toBaseUnits('0.5', 6)).toBe(500_000n)
    expect(toBaseUnits('1.25', 18)).toBe(1_250_000_000_000_000_000n)
  })

  it('håndterer null og et token uten desimaler', () => {
    expect(toBaseUnits('0', 18)).toBe(0n)
    expect(toBaseUnits('7', 0)).toBe(7n)
  })

  it('mister ikke presisjon på lange desimaler', () => {
    expect(toBaseUnits('0.000000000000000001', 18)).toBe(1n)
    // Number() ville gjort dette til 1.2345e-7 og mistet siffer
    expect(toBaseUnits('0.00000012345', 18)).toBe(123_450_000_000n)
  })

  it('avviser mer presisjon enn tokenet har', () => {
    expect(() => toBaseUnits('0.1234567', 6)).toThrow(/desimaler/)
  })

  it('avviser noe som ikke er et tall', () => {
    expect(() => toBaseUnits('femti', 18)).toThrow()
    expect(() => toBaseUnits('', 18)).toThrow()
    expect(() => toBaseUnits('1.2.3', 18)).toThrow()
    expect(() => toBaseUnits('-1', 18)).toThrow()
  })
})
