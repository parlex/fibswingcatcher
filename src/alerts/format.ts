import type { Alert } from './types.js'

const n = (v: number) => {
  if (v >= 1) {
    return v.toFixed(4).replace(/\.?0+$/, '')
  }
  if (v === 0) return '0'
  // For v < 1: use exponent to calculate needed decimal places for ~6 sig figs
  // Never use exponential notation, even for very small numbers
  const exponent = Math.floor(Math.log10(v))
  const decimalPlaces = Math.min(5 - exponent, 20)
  return v.toFixed(decimalPlaces).replace(/\.?0+$/, '')
}

export function formatAlert(a: Alert, label: string): string {
  switch (a.kind) {
    case 'milestone': {
      const { zoneTop, zoneBottom, sl } = a.setup.levels
      const toZone = ((a.price - zoneTop) / a.price) * 100
      return [
        `${label} — fib ${a.level} truffet`,
        `pris ${n(a.price)}`,
        `sone ${n(zoneTop)} → ${n(zoneBottom)} (${toZone.toFixed(1)} % ned)`,
        `sl ${n(sl)}`,
      ].join('\n')
    }
    case 'zone': {
      const { zoneTop, zoneBottom, sl } = a.setup.levels
      return [
        `${label} — I SONEN`,
        `pris ${n(a.price)}`,
        `sone ${n(zoneTop)} → ${n(zoneBottom)}`,
        `sl ${n(sl)}`,
      ].join('\n')
    }
    case 'invalidated':
      return `${label} — oppsett ugyldig: ${a.reason}`
    case 'expired':
      return `${label} — oppsett utløpt: ${a.reason}`
    case 'degraded':
      return `Datastrøm nede i ${Math.round(a.sinceMs / 1000)} s — alle oppsett disarmert`
    case 'recovered':
      return 'Datastrøm tilbake'
  }
}
