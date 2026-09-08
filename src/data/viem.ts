import { parseAbiItem, toEventSelector } from 'viem'
import type { Hex } from '../domain/types.js'
import type { BlockLog, LogReader } from './backfill.js'

/**
 * Uniswap V3 sitt Swap-event. Bekreftet on-chain for poolen
 * 0xa427ad72db4227910805162ffae9d9b0c87bd1b5 på Robinhood Chain; kjeden kan
 * likevel huse en blanding av V3 og V4, så V3-antakelsen gjelder per pool og
 * bør sjekkes med scripts/inspect-pool.ts før en ny pool tas inn.
 */
export const SWAP_EVENT = parseAbiItem(
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
)

export const SWAP_TOPIC0: Hex = toEventSelector(SWAP_EVENT)

/**
 * En logg slik viem leverer den. De tre nullbare feltene er grunnen til at
 * denne adapteren finnes: viem lar dem være null for logger fra en blokk som
 * ennå ikke er minet, mens LogReader krever dem. Å presse en viem-klient inn
 * i LogReader med en cast ville bare slått av typesjekken.
 */
export type ViemLog = {
  data: Hex
  topics: readonly Hex[]
  transactionHash: Hex | null
  logIndex: number | null
  blockNumber: bigint | null
}

/** Det minste en klient må kunne for å fôre backfillen. En viem PublicClient
 *  oppfyller dette; en test-dobbel gjør det også, uten å måtte etterligne
 *  hele viem-overflaten. */
export type SwapLogClient = {
  getLogs(args: {
    address: Hex
    event: typeof SWAP_EVENT
    fromBlock: bigint
    toBlock: bigint
  }): Promise<readonly ViemLog[]>
  getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }>
}

/**
 * Snevrer en viem-logg inn til en BlockLog, eller forkaster den.
 *
 * To grunner til å forkaste:
 *  - Ventende logger mangler blokknummer, transaksjonshash og logIndex. Uten
 *    dem kan handelen verken tidsstemples eller dedupliseres.
 *  - Poolen sender også Mint, Burn og Collect. decodeSwapLog dekoder blindt
 *    fem Swap-parametere ut av `data` og ville kastet — eller, verre, gitt et
 *    tull-tall — på et event med en annen form.
 */
export function toBlockLog(log: ViemLog): BlockLog | undefined {
  if (log.topics[0] !== SWAP_TOPIC0) return undefined
  if (log.blockNumber === null || log.transactionHash === null || log.logIndex === null) {
    return undefined
  }
  return {
    data: log.data,
    topics: log.topics,
    transactionHash: log.transactionHash,
    logIndex: log.logIndex,
    blockNumber: log.blockNumber,
  }
}

/** Presenterer en viem-klient som en LogReader, med Swap-filteret lagt på
 *  RPC-siden så vi ikke drar hjem Mint- og Collect-logger for å kaste dem. */
export function viemLogReader(client: SwapLogClient): LogReader {
  return {
    async getLogs({ address, fromBlock, toBlock }) {
      const logs = await client.getLogs({
        address: address as Hex,
        event: SWAP_EVENT,
        fromBlock,
        toBlock,
      })
      return logs.flatMap((l) => {
        const b = toBlockLog(l)
        return b ? [b] : []
      })
    },
    async getBlock({ blockNumber }) {
      const { timestamp } = await client.getBlock({ blockNumber })
      return { timestamp }
    },
  }
}
