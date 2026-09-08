import type { Bar, Trade } from '../domain/types.js'

/**
 * En bar under bygging, med nok bokføring til at en sent levert handel kan
 * foldes inn uten at barens handler er beholdt.
 *
 * `first` og `last` er (ts, logIndex) — samme ordning `aggregate` sorterer
 * etter — og de er grunnen til at rå handler ikke trengs: `open` skal bare
 * endres av en handel som er tidligere enn alle vi har sett i bøtta, og
 * `close` bare av en som er senere.
 */
type Slot = {
  bar: Bar
  firstTs: number
  firstLogIndex: number
  lastTs: number
  lastLogIndex: number
}

/** Samme sammenligning som `aggregate`: to priser av samme størrelsesorden. */
const gt = (a: string, b: string): boolean => Number(a) > Number(b)

/**
 * Bars vedlikeholdt inkrementelt, bundet til et tidsvindu.
 *
 * `aggregate` sorterer og bøtter hele handelsarrayen om igjen for hver
 * innkommende handel. Kostnaden vokser dermed med poolens aktivitet: på
 * kjedens travleste pool holder et 24-bars vindu rundt 1,1 millioner handler,
 * og per-handel-kostnaden ble målt til 223 004 µs. Sanntidsbudsjettet ved
 * 13 swaps/s er 76 923 µs, så prosessen faller irreversibelt bak i løpet av et
 * døgn. Etter endringen: 0,09 µs i denne modulen, flatt uansett vindusstørrelse.
 *
 * Innsikten som gjør dette mulig er at rå handler ikke trengs i det hele tatt:
 * `detectSwings` tar bars, og `evaluateSetup` tar en pris. Så vi holder bare
 * barene, og hver handel oppdaterer sin bøtte direkte. Minnet blir O(bars i
 * vinduet) — 25 objekter, siden kanten justeres ned til en barstart — i stedet
 * for O(handler i vinduet).
 *
 * Ekvivalensen med `aggregate` er ikke en antagelse: `tests/bars/incremental.test.ts`
 * krever bit-identiske bars for tilfeldige sekvenser med uordnet levering,
 * kolliderende `(ts, logIndex)` og handler under terskelen, både med og uten
 * klipping.
 *
 * Én forutsetning er verdt å skrive ned, for den er ikke håndhevet:
 * ekvivalensen hviler på at prisstrenger er *kanoniske*. `aggregate` går
 * gjennom handlene i sortert rekkefølge og denne i ankomstrekkefølge, og `gt`
 * sammenligner tall mens strengen beholdes — så to numerisk like men tekstulike
 * priser ('100' og '100.0') i samme bøtte gir ulik streng. `priceFromSqrtX96`
 * er den eneste kilden til `priceQuote` i treet og gir én representasjon per
 * verdi, så tilfellet er uoppnåelig i dag.
 */
export class IncrementalBars {
  private slots: Slot[] = []
  private newestTs = 0

  constructor(
    private readonly intervalMs: number,
    private readonly windowMs: number,
    private readonly minSizeQuote: bigint,
  ) {}

  add(trade: Trade): void {
    if (trade.sizeQuote < this.minSizeQuote) return
    if (trade.ts > this.newestTs) this.newestTs = trade.ts

    const openTs = Math.floor(trade.ts / this.intervalMs) * this.intervalMs
    const found = this.indexFor(openTs)
    if (found >= 0) this.fold(this.slots[found]!, trade)
    else this.slots.splice(~found, 0, this.open(openTs, trade))

    this.prune()
  }

  /**
   * Barene i vinduet, kronologisk.
   *
   * Kopier, ikke referanser: `fold` muterer barene på plass, så en konsument
   * som holdt på en `Bar` ville sett den endre seg under seg. Gratis ved 25
   * bars, og det fjerner en felle for neste leser.
   */
  bars(): Bar[] {
    return this.slots.map((s) => ({ ...s.bar }))
  }

  /** Antall beholdte bars — det er dette som er bundet, ikke antall handler. */
  size(): number {
    return this.slots.length
  }

  /**
   * Nedre kant av vinduet, justert ned til en barstart, slik at den eldste
   * beholdte baren alltid er hel fra sin egen begynnelse. `detectSwings` tar
   * sin første kandidatbunn fra `bars[0]`, så en halv bar der ville flyttet
   * startpunktet for deteksjonen.
   */
  private cutoff(): number {
    return Math.floor((this.newestTs - this.windowMs) / this.intervalMs) * this.intervalMs
  }

  private prune(): void {
    const cutoff = this.cutoff()
    while (this.slots.length > 0 && this.slots[0]!.bar.openTs < cutoff) this.slots.shift()
  }

  private open(openTs: number, trade: Trade): Slot {
    const p = trade.priceQuote
    return {
      bar: {
        openTs,
        open: p, high: p, low: p, close: p,
        volumeQuote: trade.sizeQuote,
        tradeCount: 1,
      },
      firstTs: trade.ts, firstLogIndex: trade.logIndex,
      lastTs: trade.ts, lastLogIndex: trade.logIndex,
    }
  }

  private fold(slot: Slot, trade: Trade): void {
    const p = trade.priceQuote
    const { bar } = slot

    if (gt(p, bar.high)) bar.high = p
    if (gt(bar.low, p)) bar.low = p
    bar.volumeQuote += trade.sizeQuote
    bar.tradeCount += 1

    // `>=` på logIndex-likhet med vilje: `aggregate` sorterer stabilt, så to
    // handler med identisk (ts, logIndex) beholder ankomstrekkefølgen og den
    // siste setter `close`. Her ankommer den siste sist.
    const later =
      trade.ts > slot.lastTs ||
      (trade.ts === slot.lastTs && trade.logIndex >= slot.lastLogIndex)
    if (later) {
      bar.close = p
      slot.lastTs = trade.ts
      slot.lastLogIndex = trade.logIndex
    }

    // Strengt `<` av samme grunn: ved likhet er den først ankomne fortsatt
    // først i sorteringen, og `open` skal ikke flytte seg.
    const earlier =
      trade.ts < slot.firstTs ||
      (trade.ts === slot.firstTs && trade.logIndex < slot.firstLogIndex)
    if (earlier) {
      bar.open = p
      slot.firstTs = trade.ts
      slot.firstLogIndex = trade.logIndex
    }
  }

  /**
   * Indeksen til bøtta for `openTs`, eller `~innsettingspunkt` når den ikke
   * finnes — samme konvensjon som en binærsøk-miss.
   *
   * Handler kommer nesten alltid i tidsrekkefølge, så den vanlige veien er
   * «samme bøtte som sist» eller «ny bøtte etter sist». Begge er O(1); bare en
   * sent levert handel koster et binærsøk.
   */
  private indexFor(openTs: number): number {
    const last = this.slots.at(-1)
    if (last) {
      if (last.bar.openTs === openTs) return this.slots.length - 1
      if (openTs > last.bar.openTs) return ~this.slots.length
    }

    let lo = 0
    let hi = this.slots.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const at = this.slots[mid]!.bar.openTs
      if (at === openTs) return mid
      if (at < openTs) lo = mid + 1
      else hi = mid - 1
    }
    return ~lo
  }
}
