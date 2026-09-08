import { type Chain, type PublicClient, createPublicClient, defineChain, http } from 'viem'

export const robinhoodChain: Chain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
})

export function publicClient(rpcUrl: string): PublicClient {
  return createPublicClient({ chain: robinhoodChain, transport: http(rpcUrl) })
}
