import type { PublicClient } from 'viem'
import type { Hex } from '../domain/types.js'

export type PoolMeta = {
  address: Hex
  token0: Hex
  token1: Hex
  decimals0: number
  decimals1: number
  baseIsToken0: boolean
  feeBps: number
}

const POOL_ABI = [
  { name: 'token0', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'token1', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'fee', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint24' }] },
] as const

const ERC20_ABI = [
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const

/**
 * `quoteToken` er tokenet prisen uttrykkes i — typisk WETH eller en stablecoin.
 * Base er det andre. Kalleren oppgir quote fordi bare den vet hva som er
 * "pengene" i akkurat denne poolen.
 */
export async function loadPoolMeta(
  client: PublicClient, address: Hex, quoteToken: Hex,
): Promise<PoolMeta> {
  const [token0, token1, fee] = await Promise.all([
    client.readContract({ address, abi: POOL_ABI, functionName: 'token0' }),
    client.readContract({ address, abi: POOL_ABI, functionName: 'token1' }),
    client.readContract({ address, abi: POOL_ABI, functionName: 'fee' }),
  ])

  const [decimals0, decimals1] = await Promise.all([
    client.readContract({ address: token0, abi: ERC20_ABI, functionName: 'decimals' }),
    client.readContract({ address: token1, abi: ERC20_ABI, functionName: 'decimals' }),
  ])

  const q = quoteToken.toLowerCase()
  if (q !== token0.toLowerCase() && q !== token1.toLowerCase()) {
    throw new Error(`quoteToken ${quoteToken} er ikke i pool ${address}`)
  }

  return {
    address, token0, token1,
    decimals0: Number(decimals0), decimals1: Number(decimals1),
    baseIsToken0: q === token1.toLowerCase(),
    feeBps: Number(fee) / 100,
  }
}
