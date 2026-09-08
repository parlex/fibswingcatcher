import type { Bar, Trade } from '../domain/types.js'

const TIMEFRAMES = { '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 } as const

export function timeframeMs(tf: keyof typeof TIMEFRAMES): number {
  return TIMEFRAMES[tf]
}

function gt(a: string, b: string): boolean {
  return Number(a) > Number(b)
}

export function aggregate(trades: Trade[], intervalMs: number, minSizeQuote: bigint): Bar[] {
  const kept = trades
    .filter((tr) => tr.sizeQuote >= minSizeQuote)
    .sort((a, b) => a.ts - b.ts || a.logIndex - b.logIndex)

  const bars: Bar[] = []
  let current: Bar | undefined

  for (const tr of kept) {
    const openTs = Math.floor(tr.ts / intervalMs) * intervalMs
    if (!current || current.openTs !== openTs) {
      current = {
        openTs,
        open: tr.priceQuote, high: tr.priceQuote,
        low: tr.priceQuote, close: tr.priceQuote,
        volumeQuote: 0n, tradeCount: 0,
      }
      bars.push(current)
    }
    if (gt(tr.priceQuote, current.high)) current.high = tr.priceQuote
    if (gt(current.low, tr.priceQuote)) current.low = tr.priceQuote
    current.close = tr.priceQuote
    current.volumeQuote += tr.sizeQuote
    current.tradeCount += 1
  }

  return bars
}
