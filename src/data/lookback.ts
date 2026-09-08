/**
 * Hvor langt tilbake oppstarten skal hente historikk, regnet om fra en målt
 * blokktakt.
 *
 * Feilen her er asymmetrisk, og det er hele grunnen til at modulen finnes. Et
 * for *kort* tilbakeblikk gir tynn struktur og kan logges. Et for *langt* når
 * kjedehøyden, `fromBlock` faller til 0, og oppstarten blir en skanning av
 * titalls millioner blokker som utenfra ikke er til å skille fra en hengt
 * prosess. Derfor to vern, og derfor er logikken skilt ut hit hvor den kan
 * testes framfor å ligge i entrypointet.
 */

/**
 * Bevisst under den målte takten på Robinhood Chain (~0,0099 blokker/ms, altså
 * 9,9 blokker i sekundet). Bommer målingen skal tilbakeblikket bli for kort.
 */
export const FALLBACK_BLOCKS_PER_MS = 1 / 1_000

/**
 * Tak på målt takt: 0,1 blokker/ms = 100 blokker i sekundet.
 *
 * Ti ganger over den målte takten, og godt over noen kjede i drift. Den gamle
 * verdien var 1 blokker/ms, som *ikke* hindret katastrofen sin egen
 * dokumentasjon beskrev: 24 bars gir 86 400 000 ms tilbakeblikk, så 1
 * blokk/ms ga 86 400 000 blokker mot en kjedehøyde på 57 869 685 — nøyaktig
 * den `fromBlock = 0n` taket skulle stoppe.
 */
export const MAX_BLOCKS_PER_MS = 0.1

/**
 * Tak på tilbakeblikket, som brøkdel av kjedehøyden. Dette er vernet som
 * faktisk biter først.
 *
 * Et 24-bars tilbakeblikk på denne kjeden er 855 361 blokker, altså 1,5 % av
 * høyden. Rekker beregningen over 10 % er det ikke et tilbakeblikk lenger, det
 * er en kjedeskanning — og det er bevis på at takten ble målt feil.
 */
export const MAX_LOOKBACK_FRACTION = 0.1

export type RateSource = 'measured' | 'clamped' | 'fallback'

export type LookbackDecision = {
  fromBlock: bigint
  lookbackBlocks: bigint
  /** Takten som faktisk ble brukt. */
  blocksPerMs: number
  /** Takten slik den ble målt, uansett om den ble brukt. For loggen. */
  measuredBlocksPerMs: number | undefined
  rateSource: RateSource
  /** True når tilbakeblikket overskred kjedetaket og ble skrudd ned. */
  guarded: boolean
}

export type BlockTimeReader = {
  getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }>
}

/**
 * Måler blokktakt ved å sammenligne to blokker. `undefined` når den ikke kan
 * måles — tom kjede, like tidsstempler, eller tid som går baklengs. Klamping
 * hører ikke hit; denne funksjonen rapporterer bare hva kjeden sa.
 */
export async function measureBlocksPerMs(
  client: BlockTimeReader, latest: bigint, span = 100_000n,
): Promise<number | undefined> {
  const width = latest > span ? span : latest
  if (width === 0n) return undefined

  const [older, newest] = await Promise.all([
    client.getBlock({ blockNumber: latest - width }),
    client.getBlock({ blockNumber: latest }),
  ])
  const elapsedMs = (Number(newest.timestamp) - Number(older.timestamp)) * 1_000
  if (elapsedMs <= 0) return undefined

  return Number(width) / elapsedMs
}

/** Regner om et tilbakeblikk i tid til et startblokknummer, med begge vernene. */
export function lookbackFrom(
  latest: bigint, measured: number | undefined, lookbackMs: number,
): LookbackDecision {
  let rateSource: RateSource = 'measured'
  let blocksPerMs = measured ?? FALLBACK_BLOCKS_PER_MS

  if (measured === undefined) {
    rateSource = 'fallback'
  } else if (measured > MAX_BLOCKS_PER_MS) {
    blocksPerMs = MAX_BLOCKS_PER_MS
    rateSource = 'clamped'
  }

  let lookbackBlocks = BigInt(Math.ceil(lookbackMs * blocksPerMs))
  const ceiling = BigInt(Math.floor(Number(latest) * MAX_LOOKBACK_FRACTION))

  let guarded = false
  if (lookbackBlocks > ceiling) {
    // Beregningen rekker for langt bakover for å være troverdig. Da er den
    // konservative fallbacken riktigere enn å starte fra genesis, og
    // kalleren skal si det høyt.
    guarded = true
    rateSource = 'fallback'
    blocksPerMs = FALLBACK_BLOCKS_PER_MS
    lookbackBlocks = BigInt(Math.ceil(lookbackMs * FALLBACK_BLOCKS_PER_MS))
  }

  return {
    fromBlock: latest > lookbackBlocks ? latest - lookbackBlocks : 0n,
    lookbackBlocks,
    blocksPerMs,
    measuredBlocksPerMs: measured,
    rateSource,
    guarded,
  }
}
