import type { Trade } from '../domain/types.js'
import { type RawLog, decodeSwapLog } from './decode.js'
import type { PoolMeta } from './pool.js'

export type BlockLog = RawLog & { blockNumber: bigint }

export type LogReader = {
  getLogs(args: { address: string; fromBlock: bigint; toBlock: bigint }): Promise<BlockLog[]>
  getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }>
}

export async function backfillTrades(
  client: LogReader, meta: PoolMeta, from: bigint, to: bigint, rangeSize: number,
): Promise<Trade[]> {
  const seen = new Set<string>()
  const timestamps = new Map<bigint, number>()
  const trades: Trade[] = []
  const step = BigInt(rangeSize)

  for (let start = from; start <= to; start += step) {
    const end = start + step - 1n > to ? to : start + step - 1n
    const logs = await client.getLogs({ address: meta.address, fromBlock: start, toBlock: end })

    for (const log of logs) {
      const key = `${log.transactionHash}-${log.logIndex}`
      if (seen.has(key)) continue
      seen.add(key)

      let ts = timestamps.get(log.blockNumber)
      if (ts === undefined) {
        const block = await client.getBlock({ blockNumber: log.blockNumber })
        ts = Number(block.timestamp) * 1000
        timestamps.set(log.blockNumber, ts)
      }

      trades.push(decodeSwapLog(log, meta, ts))
    }
  }

  return trades.sort((a, b) => a.ts - b.ts || a.logIndex - b.logIndex)
}
