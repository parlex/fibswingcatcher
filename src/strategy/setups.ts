import type { Hex, SetupState, Swing } from '../domain/types.js'
import { type FibLevels, type FibOpts, fibLevels, rrAt } from './fib.js'

export type Setup = {
  id: string
  poolAddress: Hex
  state: SetupState
  swing: Swing
  levels: FibLevels
  createdAtTs: number
  alertsSent: number[]
}

export type EvalCtx = {
  /** Siste handelspris. Triggerklokken — den ser hvert tick. */
  price: number
  nowTs: number
  intervalMs: number
  maxSetupAgeBars: number
  minRR: number
  tpPct: number
  /**
   * Sluttprisen på den siste *lukkede* baren, eller `undefined` når ingen bar
   * har lukket ennå.
   *
   * Ugyldiggjøring krever en lukking under swing low, mens trigger fortsatt
   * skjer på tick. Asymmetrien er spec 2.4 sin egen, og den er prinsipiell:
   * en inngang skal fanges fort, et strukturbrudd skal bekreftes sakte. Uten
   * den holder ett enkelt wick — eller én manipulert støvhandel — for å
   * ødelegge et gyldig oppsett for godt.
   */
  lastClosedBarClose: number | undefined
}

export type SetupTransition = {
  state: SetupState
  reason: string
  newAlerts: number[]
}

export function createSetup(
  poolAddress: Hex, swing: Swing, opts: FibOpts, nowTs: number,
): Setup {
  return {
    id: `${poolAddress}-${swing.lowTs}-${swing.highTs}`,
    poolAddress,
    state: 'DETECTED',
    swing,
    levels: fibLevels(swing, opts),
    createdAtTs: nowTs,
    alertsSent: [],
  }
}

export function evaluateSetup(setup: Setup, ctx: EvalCtx): SetupTransition {
  const none: number[] = []
  const swingLow = Number(setup.swing.low)

  if (ctx.lastClosedBarClose !== undefined && ctx.lastClosedBarClose < swingLow) {
    return {
      state: 'INVALIDATED',
      reason: `bar lukket på ${ctx.lastClosedBarClose} under swing low ${swingLow}`,
      newAlerts: none,
    }
  }

  const ageBars = (ctx.nowTs - setup.createdAtTs) / ctx.intervalMs
  if (ageBars > ctx.maxSetupAgeBars) {
    return { state: 'EXPIRED', reason: `eldre enn ${ctx.maxSetupAgeBars} bars`, newAlerts: none }
  }

  const inZone = ctx.price <= setup.levels.zoneTop && ctx.price >= setup.levels.zoneBottom
  if (inZone) {
    const rr = rrAt(ctx.price, setup.levels.sl, ctx.tpPct)
    if (rr < ctx.minRR) {
      return { state: 'REJECTED', reason: `RR ${rr.toFixed(2)} under minRR ${ctx.minRR}`, newAlerts: none }
    }
    return { state: 'TRIGGERED', reason: `pris ${ctx.price} inne i sonen`, newAlerts: none }
  }

  const newAlerts = setup.levels.alerts
    .filter((a) => ctx.price <= a.price && !setup.alertsSent.includes(a.level))
    .map((a) => a.level)
    .sort((a, b) => a - b)

  return { state: setup.state, reason: 'ingen endring', newAlerts }
}
