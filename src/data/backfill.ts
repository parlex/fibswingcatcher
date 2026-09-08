import type { Trade } from '../domain/types.js'
import { type RawLog, decodeSwapLog } from './decode.js'
import type { PoolMeta } from './pool.js'

export type BlockLog = RawLog & { blockNumber: bigint }

export type LogReader = {
  getLogs(args: { address: string; fromBlock: bigint; toBlock: bigint }): Promise<BlockLog[]>
  getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }>
}

export type BackfillOpts = {
  /** Antall forsøk per RPC-kall før feilen slippes videre. */
  maxAttempts?: number
  /** Første pause. Dobles for hvert nye forsøk, med tak på 30 sekunder. */
  baseDelayMs?: number
  /** Injiserbar for testene, slik at de ikke må vente i sanntid. */
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_BASE_DELAY_MS = 500
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
      if (attempt >= r.maxAttempts) throw e
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
  }
  const seen = new Set<string>()
  const timestamps = new Map<bigint, number>()
  const trades: Trade[] = []
  const step = BigInt(rangeSize)

  for (let start = from; start <= to; start += step) {
    const end = start + step - 1n > to ? to : start + step - 1n
    const logs = await withRetry(
      () => client.getLogs({ address: meta.address, fromBlock: start, toBlock: end }),
      retry,
    )

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
