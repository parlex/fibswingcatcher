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

  it('avviser et strukturvindu som er for lite for deteksjon', () => {
    // 1 bar lot deteksjonen være lydløst død: detectSwings trenger én bar til
    // bunnen, én til bekreftelsen, og én til vinduskanten den nekter å
    // forankre i.
    const bad = structuredClone(DEFAULT_CONFIG)
    bad.data.backfillLookbackBars = 1
    expect(() => ConfigSchema.parse(bad)).toThrow()

    const ok = structuredClone(DEFAULT_CONFIG)
    ok.data.backfillLookbackBars = 4
    expect(() => ConfigSchema.parse(ok)).not.toThrow()
  })

  it('avviser en terskel som ikke er en tokenmengde', () => {
    // z.string() godtok 'femti' og '50,5', og begge kastet en rå SyntaxError
    // fra BigInt() inne i Observer-konstruktøren — etter oppstart, langt fra
    // årsaken.
    for (const bad of ['femti', '50,5', '', '-1', '1.2.3', '0x10']) {
      const cfg = structuredClone(DEFAULT_CONFIG)
      cfg.strategy.minTradeSizeQuote = bad
      expect(() => ConfigSchema.parse(cfg), bad).toThrow()
    }
  })

  it('godtar tokenmengder med og uten desimaler', () => {
    for (const ok of ['0', '50', '0.5', '10000.000001']) {
      const cfg = structuredClone(DEFAULT_CONFIG)
      cfg.strategy.minSwingVolumeQuote = ok
      expect(() => ConfigSchema.parse(cfg), ok).not.toThrow()
    }
  })

  it('avviser ukjente nøkler', () => {
    const bad = { ...structuredClone(DEFAULT_CONFIG), tullball: 1 }
    expect(() => ConfigSchema.parse(bad)).toThrow()
  })
})
