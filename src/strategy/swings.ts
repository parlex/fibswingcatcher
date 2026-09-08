import type { Bar, Swing } from '../domain/types.js'

export type SwingOpts = {
  minSwingPct: number
  minSwingDurationMs: number
  minSwingVolumeQuote: bigint
}

// `price` is a Number() projection used only for threshold comparisons, per
// this project's precision rule. `raw` is the decimal string exactly as it
// arrived on the Bar, and is what ultimately gets emitted on the Swing — a
// Swing's low/high must never round-trip through Number(), which silently
// mangles small or long decimals (e.g. '0.00000012345' -> '1.2345e-7').
type Pivot = { ts: number; price: number; raw: string }

export function detectSwings(bars: Bar[], opts: SwingOpts): Swing[] {
  const swings: Swing[] = []
  if (bars.length === 0) return swings

  const threshold = opts.minSwingPct / 100
  let direction: 'down' | 'up' = 'down'
  let candidateLow: Pivot = { ts: bars[0]!.openTs, price: Number(bars[0]!.low), raw: bars[0]!.low }
  let candidateHigh: Pivot = { ts: bars[0]!.openTs, price: Number(bars[0]!.high), raw: bars[0]!.high }
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
        candidateLow = { ts: b.openTs, price: low, raw: b.low }
        volumeSinceLow = 0n
      }
      volumeSinceLow += b.volumeQuote

      if (high >= candidateLow.price * (1 + threshold)) {
        direction = 'up'
        confirmedLow = candidateLow
        candidateHigh = { ts: b.openTs, price: high, raw: b.high }
        legConfirmedAtTs = b.openTs
      }
    } else {
      if (high > candidateHigh.price) candidateHigh = { ts: b.openTs, price: high, raw: b.high }

      if (low <= candidateHigh.price * (1 - threshold) && confirmedLow) {
        const duration = candidateHigh.ts - confirmedLow.ts
        if (duration >= opts.minSwingDurationMs && volumeSinceLow >= opts.minSwingVolumeQuote) {
          swings.push({
            lowTs: confirmedLow.ts, low: confirmedLow.raw,
            highTs: candidateHigh.ts, high: candidateHigh.raw,
            confirmedAtTs: legConfirmedAtTs,
            provisional: false,
          })
        }
        direction = 'down'
        // This bar is the one that establishes the new candidate low, so its
        // own volume belongs to the leg that starts here — not to the leg
        // that just closed. Mirrors the down-branch: a bar that moves the
        // candidate low resets the accumulator to that bar's own volume,
        // never to the volume of the leg it displaces.
        candidateLow = { ts: b.openTs, price: low, raw: b.low }
        volumeSinceLow = b.volumeQuote
        confirmedLow = undefined
      } else {
        volumeSinceLow += b.volumeQuote
      }
    }
  }

  if (direction === 'up' && confirmedLow) {
    const duration = candidateHigh.ts - confirmedLow.ts
    if (duration >= opts.minSwingDurationMs && volumeSinceLow >= opts.minSwingVolumeQuote) {
      swings.push({
        lowTs: confirmedLow.ts, low: confirmedLow.raw,
        highTs: candidateHigh.ts, high: candidateHigh.raw,
        confirmedAtTs: legConfirmedAtTs,
        provisional: true,
      })
    }
  }

  return swings
}
