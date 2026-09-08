import { decodeAbiParameters } from 'viem'
import type { Hex, Trade } from '../domain/types.js'
import type { PoolMeta } from './pool.js'

const SWAP_ARGS = [
  { type: 'int256' }, { type: 'int256' }, { type: 'uint160' },
  { type: 'uint128' }, { type: 'int24' },
] as const

const Q96 = 2n ** 96n
const SCALE = 10n ** 18n

export type RawLog = {
  data: Hex | string
  topics: readonly string[]
  transactionHash: string
  logIndex: number
}

/**
 * Pris = (sqrtPriceX96 / 2^96)^2, justert for desimaler, uttrykt som
 * quote-token per base-token. Regnet i bigint med 18 desimalers presisjon,
 * fordi tokenpriser rutinemessig har 12+ signifikante siffer.
 */
export function priceFromSqrtX96(sqrtPriceX96: bigint, meta: PoolMeta): string {
  // token1 per token0, skalert med SCALE
  let scaled = (sqrtPriceX96 * sqrtPriceX96 * SCALE) / (Q96 * Q96)
  const decAdj = meta.decimals0 - meta.decimals1
  if (decAdj > 0) scaled *= 10n ** BigInt(decAdj)
  else if (decAdj < 0) scaled /= 10n ** BigInt(-decAdj)

  // Er base token1, er prisen den inverse
  if (!meta.baseIsToken0) {
    if (scaled === 0n) return '0'
    scaled = (SCALE * SCALE) / scaled
  }

  const whole = scaled / SCALE
  const frac = (scaled % SCALE).toString().padStart(18, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole.toString()
}

export function decodeSwapLog(log: RawLog, meta: PoolMeta, blockTs: number): Trade {
  const [amount0, amount1, sqrtPriceX96] = decodeAbiParameters(SWAP_ARGS, log.data as Hex)

  const amountBase = meta.baseIsToken0 ? amount0 : amount1
  const amountQuote = meta.baseIsToken0 ? amount1 : amount0
  const abs = (v: bigint) => (v < 0n ? -v : v)

  return {
    ts: blockTs,
    txHash: log.transactionHash as Hex,
    logIndex: log.logIndex,
    priceQuote: priceFromSqrtX96(sqrtPriceX96, meta),
    sizeBase: abs(amountBase),
    sizeQuote: abs(amountQuote),
    // Base forlater poolen (negativ) = noen kjøpte base
    side: amountBase < 0n ? 'buy' : 'sell',
  }
}
