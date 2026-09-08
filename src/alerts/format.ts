import type { Alert } from './types.js'

const n = (v: number) => (v < 1 ? v.toPrecision(6) : v.toFixed(4).replace(/\.?0+$/, ''))

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
