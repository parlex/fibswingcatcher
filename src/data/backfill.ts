import type { Trade } from '../domain/types.js'
import { type RawLog, decodeSwapLog } from './decode.js'
import type { PoolMeta } from './pool.js'

export type BlockLog = RawLog & { blockNumber: bigint }

export type LogReader = {
  getLogs(args: { address: string; fromBlock: bigint; toBlock: bigint }): Promise<BlockLog[]>
  getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }>
}

export type RetryInfo = {
  attempt: number
  delayMs: number
  error: unknown
}

export type BackfillOpts = {
  /** Antall forsøk per RPC-kall før feilen slippes videre. */
  maxAttempts?: number
  /** Første pause. Dobles for hvert nye forsøk. */
  baseDelayMs?: number
  /** Injiserbar for testene, slik at de ikke må vente i sanntid. */
  sleep?: (ms: number) => Promise<void>
  /**
   * Kalles før hver pause. Uten den ser en 429-storm ut som en oppstart som
   * bare er treg, og det er nettopp forskjellen man trenger å se.
   */
  onRetry?: (info: RetryInfo) => void
  /**
   * Sier om en feil betyr «vinduet ga for mange treff».
   *
   * Robinhood Chain sitt endepunkt topper ut på 10 000 logger per spørring, og
   * den travleste poolen på kjeden gjør 1,3 swap per blokk — 500 000 blokker
   * ville bedt om ~650 000 treff. Det er ikke en forbigående feil: samme
   * spørsmål gir samme svar for alltid, så vinduet må deles, ikke prøves på
   * nytt. Hva feilen *ser ut som* er transportspesifikt, så kalleren eier
   * gjenkjenningen — se `isResultLimitError` i `./viem.ts`.
   */
  shouldSplit?: (e: unknown) => boolean
  /** Kalles når et vindu deles, slik at oppstarten kan forklare seg. */
  onSplit?: (info: { from: bigint; to: bigint; error: unknown }) => void
}

const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_BASE_DELAY_MS = 500

/**
 * Tak på pausen.
 *
 * Med standardverdiene bindes den aldri: fem forsøk gir 500, 1000, 2000 og
 * 4000 ms, altså 7,5 sekunder til sammen. Taket finnes for kallere som setter
 * `maxAttempts` høyere — fra og med det åttende forsøket ville doblingen
 * ellers gått fra et halvt minutt til flere minutter per pause.
 */
const MAX_DELAY_MS = 30_000

const nap = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Prøver et RPC-kall på nytt med voksende pause.
 *
 * Finnes for rate-limiting. Det offentlige endepunktet på Robinhood Chain
 * svarer 429 på `eth_getLogs` når kallene kommer tett, og en oppstart som
 * krasjer på det er ubrukelig. `LogReader` er transportagnostisk og kan ikke
 * skille en 429 fra en permanent feil, så alt prøves på nytt: en varig feil
 * koster noen sekunder ekstra før den slippes videre, som er billig i forhold
 * til at hele oppstarten faller.
 */
async function withRetry<T>(fn: () => Promise<T>, r: Required<BackfillOpts>): Promise<T> {
  let delay = r.baseDelayMs
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (e) {
      // Deterministiske feil skal ikke prøves på nytt — de skal deles.
      if (r.shouldSplit(e)) throw e
      if (attempt >= r.maxAttempts) throw e
      r.onRetry({ attempt, delayMs: delay, error: e })
      await r.sleep(delay)
      delay = Math.min(delay * 2, MAX_DELAY_MS)
    }
  }
}

export async function backfillTrades(
  client: LogReader, meta: PoolMeta, from: bigint, to: bigint, rangeSize: number,
  opts: BackfillOpts = {},
): Promise<Trade[]> {
  const retry: Required<BackfillOpts> = {
    maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    baseDelayMs: opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    sleep: opts.sleep ?? nap,
    onRetry: opts.onRetry ?? (() => {}),
    shouldSplit: opts.shouldSplit ?? (() => false),
    onSplit: opts.onSplit ?? (() => {}),
  }

  /**
   * Henter loggene for ett blokkvindu, og halverer vinduet om det ga for mange
   * treff. `rangeSize` er dermed et *hint*, ikke en grense: et stort vindu
   * koster få kall på en stille pool, og deler seg selv ned på en travel.
   */
  const fetchLogs = async (from: bigint, to: bigint): Promise<BlockLog[]> => {
    try {
      return await withRetry(
        () => client.getLogs({ address: meta.address, fromBlock: from, toBlock: to }),
        retry,
      )
    } catch (e) {
      if (from >= to || !retry.shouldSplit(e)) throw e
      retry.onSplit({ from, to, error: e })
      const mid = from + (to - from) / 2n
      const lower = await fetchLogs(from, mid)
      const upper = await fetchLogs(mid + 1n, to)
      return [...lower, ...upper]
    }
  }
  const seen = new Set<string>()
  const timestamps = new Map<bigint, number>()
  const trades: Trade[] = []
  const step = BigInt(rangeSize)

  for (let start = from; start <= to; start += step) {
    const end = start + step - 1n > to ? to : start + step - 1n
    const logs = await fetchLogs(start, end)

    for (const log of logs) {
      const key = `${log.transactionHash}-${log.logIndex}`
      if (seen.has(key)) continue
      seen.add(key)

      let ts = timestamps.get(log.blockNumber)
      if (ts === undefined) {
        const block = await withRetry(
          () => client.getBlock({ blockNumber: log.blockNumber }),
          retry,
        )
        ts = Number(block.timestamp) * 1000
        timestamps.set(log.blockNumber, ts)
      }

      trades.push(decodeSwapLog(log, meta, ts))
    }
  }

  return trades.sort((a, b) => a.ts - b.ts || a.logIndex - b.logIndex)
}
