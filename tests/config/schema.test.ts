import { describe, expect, it } from 'vitest'
import { ConfigSchema, DEFAULT_CONFIG } from '../../src/config/schema.js'

describe('ConfigSchema', () => {
  it('godtar defaultene fra specen', () => {
    expect(() => ConfigSchema.parse(DEFAULT_CONFIG)).not.toThrow()
  })

  it('har defaultene specen krever', () => {
    expect(DEFAULT_CONFIG.strategy.structureTimeframe).toBe('1h')
    expect(DEFAULT_CONFIG.strategy.minSwingPct).toBe(15)
    expect(DEFAULT_CONFIG.strategy.fibEntry).toBe(0.886)
    expect(DEFAULT_CONFIG.strategy.fibZoneTop).toBe(0.786)
    expect(DEFAULT_CONFIG.strategy.tpPct).toBe(60)
    expect(DEFAULT_CONFIG.strategy.slBufferPct).toBe(2)
    expect(DEFAULT_CONFIG.strategy.minRR).toBe(3)
    expect(DEFAULT_CONFIG.strategy.maxSetupAgeBars).toBe(48)
    expect(DEFAULT_CONFIG.strategy.minSwingDurationMs).toBe(30_000)
    expect(DEFAULT_CONFIG.data.maxDataStalenessMs).toBe(10_000)
  })

  it('avviser negativ minRR', () => {
    const bad = structuredClone(DEFAULT_CONFIG)
    bad.strategy.minRR = -3
    expect(() => ConfigSchema.parse(bad)).toThrow()
  })

  it('avviser fibZoneTop som ikke er grunnere enn fibEntry', () => {
    const bad = structuredClone(DEFAULT_CONFIG)
    bad.strategy.fibZoneTop = 0.9
    expect(() => ConfigSchema.parse(bad)).toThrow(/fibZoneTop/)
  })

  it('avviser ukjente nøkler', () => {
    const bad = { ...structuredClone(DEFAULT_CONFIG), tullball: 1 }
    expect(() => ConfigSchema.parse(bad)).toThrow()
  })
})
