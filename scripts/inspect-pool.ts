import 'dotenv/config'
import { createPublicClient, http, keccak256, toHex } from 'viem'

const SIGNATURES = {
  'UniswapV2 Swap': 'Swap(address,uint256,uint256,uint256,uint256,address)',
  'UniswapV3 Swap': 'Swap(address,address,int256,int256,uint160,uint128,int24)',
  'UniswapV4 Swap': 'Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)',
}

const pool = process.argv[2]
if (!pool) throw new Error('bruk: tsx scripts/inspect-pool.ts <pool-adresse>')

const client = createPublicClient({ transport: http(process.env.RPC_HTTP_URL) })
const latest = await client.getBlockNumber()
const logs = await client.getLogs({
  address: pool as `0x${string}`,
  fromBlock: latest - 50_000n,
  toBlock: latest,
})

const counts = new Map<string, number>()
for (const l of logs) counts.set(l.topics[0] ?? 'ingen', (counts.get(l.topics[0] ?? 'ingen') ?? 0) + 1)

console.log(`chainId: ${await client.getChainId()}, blokk: ${latest}, logger: ${logs.length}\n`)
for (const [name, sig] of Object.entries(SIGNATURES)) {
  const topic = keccak256(toHex(sig))
  console.log(`${counts.has(topic) ? '✓' : ' '} ${name.padEnd(16)} ${topic}  treff: ${counts.get(topic) ?? 0}`)
}
console.log('\nAlle topic0 i poolen:')
for (const [topic, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${topic}  ${n}`)
