import type { Swing } from '../domain/types.js'

export type FibOpts = {
  fibEntry: number
  fibZoneTop: number
  slBufferPct: number
  alertLevels: number[]
}

export type FibLevels = {
  zoneBottom: number
  zoneTop: number
  sl: number
  alerts: { level: number; price: number }[]
}

export function fibLevels(swing: Swing, opts: FibOpts): FibLevels {
  const low = Number(swing.low)
  const high = Number(swing.high)
  const range = high - low
  const at = (level: number) => high - level * range

  return {
    zoneBottom: at(opts.fibEntry),
    zoneTop: at(opts.fibZoneTop),
    sl: low * (1 - opts.slBufferPct / 100),
    alerts: opts.alertLevels.map((level) => ({ level, price: at(level) })),
  }
}

export function tpFor(fillPrice: number, tpPct: number): number {
  return fillPrice * (1 + tpPct / 100)
}

export function rrAt(fillPrice: number, sl: number, tpPct: number): number {
  const risk = fillPrice - sl
  if (risk <= 0) return 0
  return (tpFor(fillPrice, tpPct) - fillPrice) / risk
}
