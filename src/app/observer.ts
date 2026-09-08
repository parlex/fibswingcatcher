import type { Config } from '../config/schema.js'
import type { Bar, Trade } from '../domain/types.js'
import type { PoolMeta } from '../data/pool.js'
import type { Notifier } from '../alerts/types.js'
import type { SetupStore } from '../store/setups.js'
import { aggregate, timeframeMs } from '../bars/aggregator.js'
import { detectSwings } from '../strategy/swings.js'
import { createSetup, evaluateSetup } from '../strategy/setups.js'
import { toBaseUnits } from '../domain/units.js'

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
  /**
   * Poolens pris lest uavhengig av eventen, typisk fra `slot0`.
   *
   * Spec 6.7 mottiltak 2. Leses bare ved *tilstandsendrende* evalueringer —
   * en sone-berøring på vei til TRIGGERED, eller et brudd på vei til
   * INVALIDATED — altså ett RPC-kall på et sjeldent øyeblikk. Ikke ved
   * milepælsvarsler. Utelatt betyr «ingen uavhengig kontroll», som er riktig
   * for tester og for en backtest uten kjede.
   */
  spotPrice?: () => Promise<string>
}

const TERMINAL = new Set(['CLOSED', 'INVALIDATED', 'EXPIRED', 'REJECTED'])

/**
 * Sluttilstander som er *fakta om historikken*, ikke beslutninger om nåtiden.
 *
 * Et strukturbrudd eller en aldersutløping som skjedde før oppstart er like
 * sant under replay som superseder-EXPIRED vi alt tillater. Nekter vi dem,
 * overlever et dødt oppsett replayen og sender «oppsett ugyldig» til
 * låseskjermen på første levende handel. TRIGGERED og REJECTED er derimot
 * handelsbeslutninger, og de hører bare til levende data.
 */
const STRUCTURAL_TERMINAL = new Set(['INVALIDATED', 'EXPIRED'])

/**
 * Hvor langt handelsprisen får avvike fra poolens egen `slot0`-pris før
 * overgangen nektes.
 *
 * Romslig med vilje: mellom loggen og oppslaget kan ekte swaps ha flyttet
 * prisen, og en falsk avvisning er verre enn et sent varsel. Angrepet vi ser
 * etter flytter prisen titalls prosent i en tynn pool — det er hele poenget
 * med å velge en tynn pool.
 */
const MAX_SPOT_DIVERGENCE = 0.05

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
  private newestTs = Number.NEGATIVE_INFINITY
  private intervalMs: number
  private windowMs: number
  private minTradeSize: bigint
  private minSwingVolume: bigint

  constructor(private deps: ObserverDeps) {
    this.intervalMs = timeframeMs(deps.config.strategy.structureTimeframe)
    // Strukturvinduet er det samme spennet backfillen henter. Det er den ene
    // størrelsen som sier hvor mye historikk strukturdeteksjonen skal ha, og
    // dermed også hvor mye handelsbufferet trenger å holde på.
    this.windowMs = deps.config.data.backfillLookbackBars * this.intervalMs
    // Tersklene er skrevet som mennesker tenker («50 WETH») men sammenlignes
    // med `Trade.sizeQuote`, som er rå kjede-enheter rett fra Swap-eventen.
    // Uten skaleringen betyr '50' femti wei på et 18-desimalers token, altså
    // ingen terskel — og da holder én støvhandel til å ødelegge et oppsett.
    const quoteDecimals = deps.pool.baseIsToken0 ? deps.pool.decimals1 : deps.pool.decimals0
    this.minTradeSize = toBaseUnits(deps.config.strategy.minTradeSizeQuote, quoteDecimals)
    this.minSwingVolume = toBaseUnits(deps.config.strategy.minSwingVolumeQuote, quoteDecimals)
  }

  /** Antall handler i det rullende bufferet. For logging og test. */
  get bufferedTrades(): number {
    return this.trades.length
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

    // En handel eldre enn vinduet slippes her, før den kommer inn. Klippingen
    // nedenfor ville fjernet den igjen umiddelbart — men ikke før
    // `evaluateAll` hadde målt den gamle prisen mot alle aktive oppsett, og en
    // eldgammel pris under swing low ugyldiggjør et fullgodt oppsett.
    if (trade.ts < this.cutoffTs()) return

    if (trade.ts > this.newestTs) this.newestTs = trade.ts
    this.trades.push(trade)
    this.pruneTrades()
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
    for (const s of this.deps.setups.activeForPool(this.deps.pool.address)) {
      if (s.state === 'ARMED') this.deps.setups.upsert({ ...s, state: 'DETECTED' })
    }
    await this.deps.notifier.send({ kind: 'degraded', sinceMs })
  }

  async onHealthy(): Promise<void> {
    await this.deps.notifier.send({ kind: 'recovered' })
  }

  /**
   * Nedre kant av strukturvinduet, justert ned til en barstart.
   *
   * Justeringen finnes for at den eldste beholdte baren alltid skal være hel
   * fra sin egen begynnelse. Uten den ville klippingen skjært en bar midt av,
   * og `detectSwings` tar sin første kandidatbunn og -topp fra nettopp
   * `bars[0]` — en halv bar der ville flyttet startpunktet for deteksjonen.
   */
  private cutoffTs(): number {
    return Math.floor((this.newestTs - this.windowMs) / this.intervalMs) * this.intervalMs
  }

  /**
   * Holder handelsbufferen bundet til strukturvinduet.
   *
   * Uten dette vokser `trades` uten tak, og siden `rebuildBars` sorterer og
   * skanner hele arrayen for hver innkommende handel, blir kostnaden
   * kvadratisk i antall handler. En prosess som skal stå i dagevis og se på en
   * travel pool maler seg da ned i løpet av timer. Å re-aggregere et *bundet*
   * vindu på hver handel er greit — poenget er at kostnaden slutter å vokse.
   */
  private pruneTrades(): void {
    const cutoff = this.cutoffTs()
    this.trades = this.trades.filter((t) => t.ts >= cutoff)
  }

  private rebuildBars(): void {
    this.bars = aggregate(this.trades, this.intervalMs, this.minTradeSize)
  }

  /**
   * Bare de *lukkede* barene. Den siste baren i `this.bars` inneholder
   * handelen som nettopp kom inn og er per definisjon ufullstendig.
   *
   * Dette er strukturklokken slik spec 2.1 beskriver den. Uten kuttet kjørte
   * deteksjonen på en bar som holdt én eneste pris: satte den handelen en ny
   * topp, ble beinets `high` det ene printet, oppsett-id-en `pool-lowTs-highTs`
   * ble låst til det, og når baren senere lukket på sin ekte topp ga
   * deteksjonen samme id — så nivåene ble aldri regnet om. Målt over
   * tilfeldige vandringer bar 8 av 26 oppsett et foreldet bein, verste tilfelle
   * en `zoneTop` 4,9 % for lav, altså en halv sonebredde feil.
   */
  private closedBars(): Bar[] {
    return this.bars.slice(0, -1)
  }

  /** Sluttprisen på siste lukkede bar, for ugyldiggjøring på lukking. */
  private lastClosedBarClose(): number | undefined {
    const bar = this.closedBars().at(-1)
    return bar ? Number(bar.close) : undefined
  }

  private detectNewSetups(nowTs: number): void {
    const { strategy } = this.deps.config
    const bars = this.closedBars()
    const swings = detectSwings(bars, {
      minSwingPct: strategy.minSwingPct,
      minSwingDurationMs: strategy.minSwingDurationMs,
      minSwingVolumeQuote: this.minSwingVolume,
    })

    const latest = swings.at(-1)
    if (!latest) return

    // Et bein hvis bunn ligger på den eldste beholdte baren er forankret i en
    // vinduskant, ikke i en pivot: prisen kan ha vært lavere rett før vinduet,
    // og vi kastet nettopp bevisene. Fib-nivåer tegnet derfra er tall uten
    // mening, og etter hvert som vinduet glir flytter en slik bunn seg hver
    // bar — hvert steg et nytt oppsett som varsler for seg selv.
    //
    // Kravet gjelder også ved kaldstart. `bars[0]` er da den første
    // backfillede baren, altså et blokknummer valgt av et takt-anslag — det
    // mest vilkårlige punktet som finnes, ikke det minst. Prisen er tynn i
    // opptil ett vindu etter oppstart, og det er riktig pris å betale for å
    // ikke tegne fib-nivåer fra en tilfeldig blokk.
    const oldestBar = bars[0]
    if (oldestBar && latest.lowTs <= oldestBar.openTs) {
      this.deps.log.info(
        { lowTs: latest.lowTs, eldsteBarTs: oldestBar.openTs },
        'oppsett avvist — bunnen ligger på vinduskanten',
      )
      return
    }

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
    for (const old of this.deps.setups.activeForPool(setup.poolAddress)) {
      // Samme bunn: beinet har utvidet toppen sin.
      // Samme topp: bunnen har flyttet seg — typisk fordi vinduet gled — og
      // to oppsett tegnet fra én ekte topp er søsken, ikke to oppsett.
      if (old.swing.lowTs === latest.lowTs || old.swing.highTs === latest.highTs) {
        this.deps.setups.upsert({ ...old, state: 'EXPIRED' })
        this.deps.log.info({ id: old.id, erstattetAv: setup.id }, 'oppsett erstattet')
      }
    }

    this.deps.setups.upsert(setup)
    this.deps.log.info({ id: setup.id, levels: setup.levels }, 'nytt oppsett')
  }

  /**
   * Sjekker handelsprisen mot poolens egen `slot0`-pris.
   *
   * Feiler åpent når oppslaget ikke lar seg gjøre: et dødt RPC-endepunkt skal
   * ikke gjøre boten stum. Feiler lukket når prisene spriker: da er
   * handelsprisen ikke til å stole på, og et varsel bygget på den er verre
   * enn ingen.
   */
  private async priceLooksReal(price: number, setupId: string): Promise<boolean> {
    const read = this.deps.spotPrice
    if (!read) return true

    let spot: number
    try {
      spot = Number(await read())
    } catch (err) {
      this.deps.log.warn({ setupId, err }, 'kunne ikke lese poolens spotpris — stoler på handelsprisen')
      return true
    }

    if (!(spot > 0)) return true
    const divergence = Math.abs(price - spot) / spot
    if (divergence <= MAX_SPOT_DIVERGENCE) return true

    this.deps.log.warn(
      { setupId, price, spot, divergence },
      'handelsprisen spriker fra poolens spotpris — nekter tilstandsendringen',
    )
    return false
  }

  private async evaluateAll(price: number, nowTs: number, replay: boolean): Promise<void> {
    const { strategy } = this.deps.config

    for (const setup of this.deps.setups.activeForPool(this.deps.pool.address)) {
      const tr = evaluateSetup(setup, {
        price, nowTs,
        intervalMs: this.intervalMs,
        maxSetupAgeBars: strategy.maxSetupAgeBars,
        minRR: strategy.minRR,
        tpPct: strategy.tpPct,
        lastClosedBarClose: this.lastClosedBarClose(),
      })

      for (const level of tr.newAlerts) {
        // Registreringen skjer også under replay: den er nettopp poenget med
        // primingen, slik at et passert nivå ikke annonseres etter omstart.
        //
        // `recordAlert` sier om nivået faktisk ble lagt til. To samtidige
        // `onTrade`-kall beregner begge `newAlerts` før første `await`, så
        // uten denne sjekken sender de samme milepæl to ganger.
        const recorded = this.deps.setups.recordAlert(setup.id, level)
        if (replay || !recorded) continue
        const alert = setup.levels.alerts.find((a) => a.level === level)!
        await this.deps.notifier.send({
          kind: 'milestone',
          setup: this.deps.setups.get(setup.id)!,
          level,
          price: alert.price,
        })
      }

      if (tr.state === setup.state) continue

      // Replay får sette de strukturelle sluttilstandene, men aldri
      // TRIGGERED eller REJECTED. Se `STRUCTURAL_TERMINAL`.
      if (replay && !STRUCTURAL_TERMINAL.has(tr.state)) continue

      // Spec 6.7 mottiltak 2: en tilstandsendring er verdt ett uavhengig
      // prisoppslag. Milepæler er det ikke.
      if (!replay && !(await this.priceLooksReal(price, setup.id))) continue

      this.deps.setups.upsert({ ...this.deps.setups.get(setup.id)!, state: tr.state })

      if (!replay) {
        if (tr.state === 'TRIGGERED') {
          await this.deps.notifier.send({ kind: 'zone', setup, price })
        } else if (tr.state === 'INVALIDATED' || tr.state === 'EXPIRED') {
          await this.deps.notifier.send({ kind: tr.state === 'INVALIDATED' ? 'invalidated' : 'expired', setup, reason: tr.reason })
        }
      }

      if (TERMINAL.has(tr.state)) {
        this.deps.log.info({ id: setup.id, state: tr.state, reason: tr.reason }, 'oppsett avsluttet')
      }
    }
  }
}
