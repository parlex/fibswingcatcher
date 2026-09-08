import { describe, expect, it } from 'vitest'
import {
  MAX_BLOCKS_PER_MS, MAX_LOOKBACK_FRACTION, lookbackFrom, measureBlocksPerMs,
} from '../../src/data/lookback.js'

// Ekte tall fra Robinhood Chain: 24 bars a 1h, kjedehøyde og målt takt
const LOOKBACK_MS = 24 * 3_600_000
const LATEST = 57_869_685n
const MEASURED = 0.0099

describe('measureBlocksPerMs', () => {
  const reader = (older: bigint, newest: bigint) => ({
    async getBlock({ blockNumber }: { blockNumber: bigint }) {
      return { timestamp: blockNumber === LATEST ? newest : older }
    },
  })

  it('måler takten over vinduet', async () => {
    // 100 000 blokker på 10 000 sekunder = 10 blokker/s = 0,01 blokker/ms
    const rate = await measureBlocksPerMs(reader(1_000_000n, 1_010_000n), LATEST)
    expect(rate).toBeCloseTo(0.01, 6)
  })

  it('gir undefined når to blokker har samme tidsstempel', async () => {
    expect(await measureBlocksPerMs(reader(1_000_000n, 1_000_000n), LATEST)).toBeUndefined()
  })

  it('gir undefined når tiden går baklengs', async () => {
    expect(await measureBlocksPerMs(reader(1_000_000n, 999_000n), LATEST)).toBeUndefined()
  })

  it('gir undefined på en kjede uten blokker', async () => {
    expect(await measureBlocksPerMs(reader(0n, 0n), 0n)).toBeUndefined()
  })
})

describe('lookbackFrom', () => {
  it('bruker den målte takten når den er troverdig', () => {
    const d = lookbackFrom(LATEST, MEASURED, LOOKBACK_MS)
    expect(d.rateSource).toBe('measured')
    expect(d.guarded).toBe(false)
    expect(d.lookbackBlocks).toBe(855_361n)
    expect(d.fromBlock).toBe(57_014_324n)
  })

  it('faller forsiktig tilbake når takten ikke kunne måles', () => {
    const d = lookbackFrom(LATEST, undefined, LOOKBACK_MS)
    expect(d.rateSource).toBe('fallback')
    expect(d.lookbackBlocks).toBe(86_400n)   // 0,001 blokker/ms x 86 400 000 ms
    expect(d.fromBlock).toBe(LATEST - 86_400n)
  })

  it('en degenerert måling gir et kort, merket tilbakeblikk — ikke blokk 0', () => {
    // elapsedMs nesten null gir en absurd takt. Før vernet ble fromBlock 0n,
    // altså en skanning av hele kjeden forkledd som en hengt prosess.
    const d = lookbackFrom(LATEST, 100, LOOKBACK_MS)
    expect(d.guarded).toBe(true)
    expect(d.fromBlock).toBeGreaterThan(0n)
    expect(d.lookbackBlocks).toBe(86_400n)
  })

  it('en troverdig-men-høy takt vernes også', () => {
    const d = lookbackFrom(LATEST, 0.5, LOOKBACK_MS)
    expect(d.guarded).toBe(true)
    expect(d.fromBlock).toBeGreaterThan(0n)
  })

  it('invariant: taket på takten ligger under den takten som ga genesis', () => {
    // Den gamle verdien 1 blokk/ms lå 1,5x OVER 0,6698 og hindret dermed ikke
    // fromBlock 0n i det hele tatt. Dette er relasjonen som må holde.
    expect(MAX_BLOCKS_PER_MS).toBeLessThan(Number(LATEST) / LOOKBACK_MS)
    expect(lookbackFrom(LATEST, 1, LOOKBACK_MS).fromBlock).toBeGreaterThan(0n)
  })

  it('taket på takten biter der kjedetaket ikke skygger for det', () => {
    // Med 24 bars skygger kjedetaket helt for takt-taket: en klampet takt gir
    // 8 640 000 blokker, som fortsatt er over kjedetaket på 5 786 968, så
    // vernet overtar. Med 4 bars slipper den klampede takten under, og da er
    // klampingen synlig i svaret.
    const shortLookbackMs = 4 * 3_600_000
    const d = lookbackFrom(LATEST, 100, shortLookbackMs)
    expect(d.rateSource).toBe('clamped')
    expect(d.guarded).toBe(false)
    expect(d.blocksPerMs).toBe(MAX_BLOCKS_PER_MS)
    expect(d.lookbackBlocks).toBe(1_440_000n)
  })

  it('slipper gjennom en takt så vidt under kjedetaket', () => {
    const justUnder = Number(LATEST) * MAX_LOOKBACK_FRACTION / LOOKBACK_MS * 0.99
    const d = lookbackFrom(LATEST, justUnder, LOOKBACK_MS)
    expect(d.guarded).toBe(false)
    expect(d.rateSource).toBe('measured')
  })

  it('verner en takt så vidt over kjedetaket', () => {
    const justOver = Number(LATEST) * MAX_LOOKBACK_FRACTION / LOOKBACK_MS * 1.01
    expect(lookbackFrom(LATEST, justOver, LOOKBACK_MS).guarded).toBe(true)
  })

  it('gir aldri blokk 0 på en moden kjede, uansett hvor gal målingen er', () => {
    // 0,6698 er den eksakte takten der lookbackBlocks == kjedehøyden, altså
    // nøyaktig punktet der fromBlock ble 0n før vernet.
    const exactlyChainHeight = Number(LATEST) / LOOKBACK_MS
    for (const rate of [MEASURED, 0.05, 0.067, 0.1, exactlyChainHeight, 0.67, 1, 10, 1_000, 1e9]) {
      const d = lookbackFrom(LATEST, rate, LOOKBACK_MS)
      expect(d.fromBlock, `takt ${rate}`).toBeGreaterThan(0n)
      expect(d.lookbackBlocks, `takt ${rate}`).toBeLessThan(LATEST)
    }
  })

  it('på en ung kjede er genesis greit — men det blir merket', () => {
    const d = lookbackFrom(1_000n, MEASURED, LOOKBACK_MS)
    expect(d.guarded).toBe(true)
    expect(d.fromBlock).toBe(0n)
  })

  it('beholder den målte takten i svaret, slik at loggen kan vise den', () => {
    expect(lookbackFrom(LATEST, 100, LOOKBACK_MS).measuredBlocksPerMs).toBe(100)
    expect(lookbackFrom(LATEST, undefined, LOOKBACK_MS).measuredBlocksPerMs).toBeUndefined()
  })
})
