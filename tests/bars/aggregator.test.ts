import { describe, expect, it } from 'vitest'
import type { Trade } from '../../src/domain/types.js'
import { aggregate, timeframeMs } from '../../src/bars/aggregator.js'

const t = (ts: number, price: string, sizeQuote: bigint, logIndex?: number): Trade => ({
  ts, txHash: '0xabc', logIndex: logIndex ?? ts, priceQuote: price,
  sizeQuote, sizeBase: 1n, side: 'buy', liquidity: 10n ** 24n,
})

describe('timeframeMs', () => {
  it('oversetter tidsrammer til millisekunder', () => {
    expect(timeframeMs('5m')).toBe(300_000)
    expect(timeframeMs('15m')).toBe(900_000)
    expect(timeframeMs('1h')).toBe(3_600_000)
    expect(timeframeMs('4h')).toBe(14_400_000)
  })
})

describe('aggregate', () => {
  const H = 3_600_000

  it('gir én bar med korrekt OHLCV for handler i samme bøtte', () => {
    const bars = aggregate(
      [t(H + 10, '100', 10n), t(H + 20, '120', 20n), t(H + 30, '90', 30n), t(H + 40, '110', 40n)],
      H, 0n,
    )
    expect(bars).toHaveLength(1)
    expect(bars[0]).toMatchObject({
      openTs: H, open: '100', high: '120', low: '90', close: '110',
      volumeQuote: 100n, tradeCount: 4,
    })
  })

  it('deler på bøttegrenser, ikke på første handel', () => {
    const bars = aggregate([t(H + 1, '100', 1n), t(2 * H + 1, '200', 1n)], H, 0n)
    expect(bars.map((b) => b.openTs)).toEqual([H, 2 * H])
  })

  it('hopper over tomme intervaller i stedet for å lage flate bars', () => {
    const bars = aggregate([t(H, '100', 1n), t(4 * H, '200', 1n)], H, 0n)
    expect(bars.map((b) => b.openTs)).toEqual([H, 4 * H])
  })

  it('filtrerer bort handler under minSizeQuote', () => {
    const bars = aggregate([t(H, '100', 5n), t(H + 1, '999', 1n), t(H + 2, '110', 50n)], H, 10n)
    expect(bars[0]!.tradeCount).toBe(1)
    expect(bars[0]!.high).toBe('110')
  })

  it('gir ingen bars når alle handler er under terskelen', () => {
    expect(aggregate([t(H, '100', 1n)], H, 10n)).toEqual([])
  })

  it('sorterer uordnede handler før aggregering', () => {
    const bars = aggregate([t(H + 30, '90', 1n), t(H + 10, '100', 1n)], H, 0n)
    expect(bars[0]).toMatchObject({ open: '100', close: '90' })
  })

  it('er deterministisk — samme input gir samme output', () => {
    const input = [t(H + 5, '100', 1n), t(H + 7, '105', 2n)]
    expect(aggregate(input, H, 0n)).toEqual(aggregate(input, H, 0n))
  })

  it('muterer ikke innput-arrayen', () => {
    const input = [t(H + 30, '90', 1n), t(H + 10, '100', 1n)]
    const originalOrder = input.map((trade) => trade.ts)
    aggregate(input, H, 0n)
    const afterOrder = input.map((trade) => trade.ts)
    expect(afterOrder).toEqual(originalOrder)
  })

  it('bruker logIndex som tie-break når timestamp er identisk', () => {
    const bars = aggregate([t(H + 10, '100', 1n, 5), t(H + 10, '110', 1n, 3)], H, 0n)
    expect(bars[0]).toMatchObject({ open: '110', close: '100' })
  })
})
