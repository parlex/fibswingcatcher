import { describe, expect, it } from 'vitest'
import type { PoolMeta } from '../../src/data/pool.js'
import { decodeSwapLog, priceFromSqrtX96 } from '../../src/data/decode.js'
import { encodeAbiParameters, keccak256, toHex } from 'viem'

const meta: PoolMeta = {
  address: '0x1111111111111111111111111111111111111111',
  token0: '0xaaaa000000000000000000000000000000000000',
  token1: '0xbbbb000000000000000000000000000000000000',
  decimals0: 18,
  decimals1: 18,
  baseIsToken0: true,
  feeBps: 30,
}

const TOPIC = keccak256(toHex('Swap(address,address,int256,int256,uint160,uint128,int24)'))
const Q96 = 2n ** 96n

const makeLog = (amount0: bigint, amount1: bigint, sqrtPriceX96: bigint) => ({
  address: meta.address,
  topics: [TOPIC, `0x${'0'.repeat(64)}`, `0x${'0'.repeat(64)}`] as [string, string, string],
  data: encodeAbiParameters(
    [
      { type: 'int256' }, { type: 'int256' }, { type: 'uint160' },
      { type: 'uint128' }, { type: 'int24' },
    ],
    [amount0, amount1, sqrtPriceX96, 0n, 0],
  ),
  transactionHash: '0xdead' as const,
  logIndex: 7,
})

describe('priceFromSqrtX96', () => {
  it('gir 1.0 når sqrtPrice er Q96 og desimalene er like', () => {
    expect(Number(priceFromSqrtX96(Q96, meta))).toBeCloseTo(1, 9)
  })

  it('gir 4.0 når sqrtPrice er 2 × Q96', () => {
    expect(Number(priceFromSqrtX96(2n * Q96, meta))).toBeCloseTo(4, 9)
  })

  it('justerer for ulikt antall desimaler', () => {
    const usdcLike = { ...meta, decimals1: 6 }
    expect(Number(priceFromSqrtX96(Q96, usdcLike))).toBeCloseTo(1e12, -6)
  })

  it('takler svært små priser uten å bli 0', () => {
    const p = Number(priceFromSqrtX96(Q96 / 100_000n, meta))
    expect(p).toBeGreaterThan(0)
    expect(p).toBeLessThan(1e-9)
  })

  it('inverterer prisen når baseIsToken0 er false', () => {
    const flipped = { ...meta, baseIsToken0: false }
    expect(priceFromSqrtX96(2n * Q96, flipped)).toBe('0.25')
  })

  it('inverterer og justerer desimaler samtidig når baseIsToken0 er false', () => {
    const flipped = { ...meta, decimals0: 6, decimals1: 18, baseIsToken0: false }
    expect(priceFromSqrtX96(2n * Q96, flipped)).toBe('250000000000')
  })

  it('returnerer "0" i stedet for å dele på null når den inverterte prisen ville vært 0', () => {
    const flipped = { ...meta, baseIsToken0: false }
    expect(priceFromSqrtX96(1n, flipped)).toBe('0')
  })
})

describe('decodeSwapLog', () => {
  it('leser pris fra sqrtPriceX96, ikke fra mengdeforholdet', () => {
    // Mengdeforholdet |250 / -100| = 2.5, men sqrtPrice sier 4 — de MÅ divergere,
    // ellers beviser ikke testen at prisen faktisk kommer fra sqrtPriceX96.
    const trade = decodeSwapLog(makeLog(-100n, 250n, 2n * Q96), meta, 1_700_000)
    expect(trade.priceQuote).toBe('4')
  })

  it('merker et kjøp av base-tokenet som buy', () => {
    // amount0 negativ = token0 forlater poolen = noen kjøper base
    expect(decodeSwapLog(makeLog(-100n, 400n, Q96), meta, 1).side).toBe('buy')
  })

  it('merker et salg av base-tokenet som sell', () => {
    expect(decodeSwapLog(makeLog(100n, -400n, Q96), meta, 1).side).toBe('sell')
  })

  it('rapporterer størrelser som absoluttverdier', () => {
    const trade = decodeSwapLog(makeLog(-100n, 400n, Q96), meta, 1)
    expect(trade.sizeBase).toBe(100n)
    expect(trade.sizeQuote).toBe(400n)
  })

  it('tar med txHash, logIndex og blokk-tidsstempel', () => {
    const trade = decodeSwapLog(makeLog(-1n, 1n, Q96), meta, 1_700_000)
    expect(trade).toMatchObject({ txHash: '0xdead', logIndex: 7, ts: 1_700_000 })
  })

  it('snur base og quote når baseIsToken0 er false', () => {
    const flipped = { ...meta, baseIsToken0: false }
    const trade = decodeSwapLog(makeLog(-100n, 400n, Q96), flipped, 1)
    expect(trade.sizeBase).toBe(400n)
    expect(trade.sizeQuote).toBe(100n)
  })
})
