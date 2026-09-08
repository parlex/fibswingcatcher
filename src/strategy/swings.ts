import type { Bar, Swing } from '../domain/types.js'

export type SwingOpts = {
  minSwingPct: number
  minSwingDurationMs: number
  minSwingVolumeQuote: bigint
}

type Pivot = { ts: number; price: number }

export function detectSwings(bars: Bar[], opts: SwingOpts): Swing[] {
  const swings: Swing[] = []
  if (bars.length === 0) return swings

  const threshold = opts.minSwingPct / 100
  let direction: 'down' | 'up' = 'down'
  let candidateLow: Pivot = { ts: bars[0]!.openTs, price: Number(bars[0]!.low) }
  let candidateHigh: Pivot = { ts: bars[0]!.openTs, price: Number(bars[0]!.high) }
  let confirmedLow: Pivot | undefined
  // Timestamp of the bar that broke the up-confirmation threshold (down -> up
  // flip), i.e. the bar that confirmed this leg's bottom. Set once per leg and
  // never revisited afterwards — unlike candidateHigh.ts, which keeps moving
  // as later bars extend the running top. confirmedAtTs must anchor to the
  // former, not the latter, or a bar that both extends the top *and* breaks
  // the retracement threshold in the same iteration would misreport itself as
  // the confirming bar.
  let legConfirmedAtTs = 0
  let volumeSinceLow = 0n

  for (const b of bars) {
    const low = Number(b.low)
    const high = Number(b.high)

    if (direction === 'down') {
      if (low < candidateLow.price) {
        candidateLow = { ts: b.openTs, price: low }
        volumeSinceLow = 0n
      }
      volumeSinceLow += b.volumeQuote

      if (high >= candidateLow.price * (1 + threshold)) {
        direction = 'up'
        confirmedLow = candidateLow
        candidateHigh = { ts: b.openTs, price: high }
        legConfirmedAtTs = b.openTs
      }
    } else {
      if (high > candidateHigh.price) candidateHigh = { ts: b.openTs, price: high }
      volumeSinceLow += b.volumeQuote

      if (low <= candidateHigh.price * (1 - threshold) && confirmedLow) {
        const duration = candidateHigh.ts - confirmedLow.ts
        if (duration >= opts.minSwingDurationMs && volumeSinceLow >= opts.minSwingVolumeQuote) {
          swings.push({
            lowTs: confirmedLow.ts, low: String(confirmedLow.price),
            highTs: candidateHigh.ts, high: String(candidateHigh.price),
            confirmedAtTs: legConfirmedAtTs,
            provisional: false,
          })
        }
        direction = 'down'
        candidateLow = { ts: b.openTs, price: low }
        volumeSinceLow = 0n
        confirmedLow = undefined
      }
    }
  }

  if (direction === 'up' && confirmedLow) {
    const duration = candidateHigh.ts - confirmedLow.ts
    if (duration >= opts.minSwingDurationMs && volumeSinceLow >= opts.minSwingVolumeQuote) {
      swings.push({
        lowTs: confirmedLow.ts, low: String(confirmedLow.price),
        highTs: candidateHigh.ts, high: String(candidateHigh.price),
        confirmedAtTs: legConfirmedAtTs,
        provisional: true,
      })
    }
  }

  return swings
}
