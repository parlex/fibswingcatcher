import type { Config } from '../config/schema.js'
import type { Bar, Trade } from '../domain/types.js'
import type { PoolMeta } from '../data/pool.js'
import type { Notifier } from '../alerts/types.js'
import type { SetupStore } from '../store/setups.js'
import { aggregate, timeframeMs } from '../bars/aggregator.js'
import { detectSwings } from '../strategy/swings.js'
import { createSetup, evaluateSetup } from '../strategy/setups.js'

export type Logger = {
  info(o: object, msg?: string): void
  warn(o: object, msg?: string): void
  error(o: object, msg?: string): void
}

export type ObserverDeps = {
  pool: PoolMeta
  label: string
  config: Config
  setups: SetupStore
  notifier: Notifier
  log: Logger
}

const TERMINAL = new Set(['CLOSED', 'INVALIDATED', 'EXPIRED', 'REJECTED'])

/**
 * To klokker, med vilje holdt fra hverandre:
 *
 *   struktur  — oppsett *opprettes* når en bar på strukturtidsrammen lukker,
 *               fordi swing-deteksjon bare gir mening på ferdige bars.
 *   trigger   — oppsett *evalueres* på hver eneste handel, fordi et wick ned
 *               i fib-sonen kan vare ti sekunder og er usynlig på barnivå.
 *
 * Å slå dem sammen er nøyaktig den feilen hele prosjektet finnes for å unngå.
 */
export class Observer {
  private trades: Trade[] = []
  private bars: Bar[] = []
  private lastBarTs = -1
  private intervalMs: number
  private minTradeSize: bigint
  private minSwingVolume: bigint

  constructor(private deps: ObserverDeps) {
    this.intervalMs = timeframeMs(deps.config.strategy.structureTimeframe)
    this.minTradeSize = BigInt(deps.config.strategy.minTradeSizeQuote)
    this.minSwingVolume = BigInt(deps.config.strategy.minSwingVolumeQuote)
  }

  /** En handel fra den levende strømmen. Begge klokkene går. */
  async onTrade(trade: Trade): Promise<void> {
    await this.ingest(trade, false)
  }

  /**
   * En handel fra backfillet historikk.
   *
   * Backfillen finnes for å gi swing-detektoren struktur, aldri for å trigge.
   * En replayet handel er minutter til timer gammel, så den:
   *
   *   - bygger bars og mater strukturdeteksjonen, og oppretter oppsett;
   *   - primer `alertsSent` for nivåer prisen alt har passert, så en omstart
   *     ikke annonserer dem på nytt;
   *   - utfører **ingen** tilstandsoverganger. Et dypp i sonen for en time
   *     siden skal ikke etterlate oppsettet som TRIGGERED, for da tier
   *     `evaluateAll` når prisen kommer tilbake i sonen for ekte;
   *   - sender **ingen** varsler.
   */
  async replay(trade: Trade): Promise<void> {
    await this.ingest(trade, true)
  }

  private async ingest(trade: Trade, replay: boolean): Promise<void> {
    if (trade.sizeQuote < this.minTradeSize) return

    this.trades.push(trade)
    this.rebuildBars()

    const barTs = Math.floor(trade.ts / this.intervalMs) * this.intervalMs
    if (barTs > this.lastBarTs) {
      this.lastBarTs = barTs
      this.detectNewSetups(trade.ts)
    }

    await this.evaluateAll(Number(trade.priceQuote), trade.ts, replay)
  }

  async onStale(sinceMs: number): Promise<void> {
    this.deps.log.warn({ sinceMs }, 'datastrøm stale — disarmerer')
    for (const s of this.deps.setups.allActive()) {
      if (s.state === 'ARMED') this.deps.setups.upsert({ ...s, state: 'DETECTED' })
    }
    await this.deps.notifier.send({ kind: 'degraded', sinceMs })
  }

  async onHealthy(): Promise<void> {
    await this.deps.notifier.send({ kind: 'recovered' })
  }

  private rebuildBars(): void {
    this.bars = aggregate(this.trades, this.intervalMs, this.minTradeSize)
  }

  private detectNewSetups(nowTs: number): void {
    const { strategy } = this.deps.config
    const swings = detectSwings(this.bars, {
      minSwingPct: strategy.minSwingPct,
      minSwingDurationMs: strategy.minSwingDurationMs,
      minSwingVolumeQuote: this.minSwingVolume,
    })

    const latest = swings.at(-1)
    if (!latest) return

    const fibOpts = {
      fibEntry: strategy.fibEntry,
      fibZoneTop: strategy.fibZoneTop,
      slBufferPct: strategy.slBufferPct,
      alertLevels: strategy.alertLevels,
    }
    const setup = createSetup(this.deps.pool.address, latest, fibOpts, nowTs)
    if (this.deps.setups.get(setup.id)) return

    // Et provisorisk bein kan utvide toppen sin. Da er det gamle oppsettet
    // tegnet fra feil topp og må vike, ellers samler det seg opp foreldede
    // fib-nivåer for samme bunn.
    //
    // Denne opprydningen kjører også under replay, og er det ene stedet
    // historikk får sette EXPIRED. Det er strukturbokføring, ikke en
    // evaluerings-overgang: uten den ville replayen etterlatt ett foreldet
    // oppsett per utvidelse, og den første levende handelen hadde evaluert
    // dem alle og sendt nettopp den bygen replay-modusen finnes for å hindre.
    for (const old of this.deps.setups.allActive()) {
      if (old.poolAddress === setup.poolAddress && old.swing.lowTs === latest.lowTs) {
        this.deps.setups.upsert({ ...old, state: 'EXPIRED' })
        this.deps.log.info({ id: old.id, erstattetAv: setup.id }, 'oppsett erstattet av utvidet bein')
      }
    }

    this.deps.setups.upsert(setup)
    this.deps.log.info({ id: setup.id, levels: setup.levels }, 'nytt oppsett')
  }

  private async evaluateAll(price: number, nowTs: number, replay: boolean): Promise<void> {
    const { strategy } = this.deps.config

    for (const setup of this.deps.setups.allActive()) {
      const tr = evaluateSetup(setup, {
        price, nowTs,
        intervalMs: this.intervalMs,
        maxSetupAgeBars: strategy.maxSetupAgeBars,
        minRR: strategy.minRR,
        tpPct: strategy.tpPct,
      })

      for (const level of tr.newAlerts) {
        // Registreringen skjer også under replay: den er nettopp poenget med
        // primingen, slik at et passert nivå ikke annonseres etter omstart.
        this.deps.setups.recordAlert(setup.id, level)
        if (replay) continue
        const alert = setup.levels.alerts.find((a) => a.level === level)!
        await this.deps.notifier.send({
          kind: 'milestone',
          setup: this.deps.setups.get(setup.id)!,
          level,
          price: alert.price,
        })
      }

      // Historikk flytter aldri tilstanden. Se `replay()`.
      if (replay) continue

      if (tr.state === setup.state) continue

      this.deps.setups.upsert({ ...this.deps.setups.get(setup.id)!, state: tr.state })

      if (tr.state === 'TRIGGERED') {
        await this.deps.notifier.send({ kind: 'zone', setup, price })
      } else if (tr.state === 'INVALIDATED' || tr.state === 'EXPIRED') {
        await this.deps.notifier.send({ kind: tr.state === 'INVALIDATED' ? 'invalidated' : 'expired', setup, reason: tr.reason })
      }

      if (TERMINAL.has(tr.state)) {
        this.deps.log.info({ id: setup.id, state: tr.state, reason: tr.reason }, 'oppsett avsluttet')
      }
    }
  }
}
