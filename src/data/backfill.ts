import type { Trade } from '../domain/types.js'
import { type RetryInfo, type RetryOpts, resolveRetry, withRetry } from './retry.js'
import { type RawLog, decodeSwapLog } from './decode.js'
import type { PoolMeta } from './pool.js'

export type BlockLog = RawLog & { blockNumber: bigint }

export type LogReader = {
  getLogs(args: { address: string; fromBlock: bigint; toBlock: bigint }): Promise<BlockLog[]>
  getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }>
}

export type BackfillOpts = RetryOpts & {
  /**
   * Sier om en feil betyr «vinduet ga for mange treff».
   *
   * Robinhood Chain sitt endepunkt topper ut på 10 000 logger per spørring, og
   * den travleste poolen på kjeden gjør ~1,8 swap per blokk — 500 000 blokker
   * ville bedt om ~900 000 treff. Det er ikke en forbigående feil: samme
   * spørsmål gir samme svar for alltid, så vinduet må deles, ikke prøves på
   * nytt. Hva feilen *ser ut som* er transportspesifikt, så kalleren eier
   * gjenkjenningen — se `isResultLimitError` i `./viem.ts`.
   */
  shouldSplit?: (e: unknown) => boolean
  /** Kalles når et vindu deles, slik at oppstarten kan forklare seg. */
  onSplit?: (info: { from: bigint; to: bigint; error: unknown }) => void
}

export type { RetryInfo }

export async function backfillTrades(
  client: LogReader, meta: PoolMeta, from: bigint, to: bigint, rangeSize: number,
  opts: BackfillOpts = {},
): Promise<Trade[]> {
  const shouldSplit = opts.shouldSplit ?? (() => false)
  const onSplit = opts.onSplit ?? (() => {})
  // Et for stort vindu er en permanent feil for retry-en: den skal slippe
  // feilen rett gjennom til delingen nedenfor.
  const retry = resolveRetry({ ...opts, isPermanent: shouldSplit })

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
      if (from >= to || !shouldSplit(e)) throw e
      onSplit({ from, to, error: e })
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
