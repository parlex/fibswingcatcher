import { describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters } from 'viem'
import { backfillTrades } from '../../src/data/backfill.js'
import type { PoolMeta } from '../../src/data/pool.js'

const meta: PoolMeta = {
  address: '0x1111111111111111111111111111111111111111',
  token0: '0xaaaa000000000000000000000000000000000000',
  token1: '0xbbbb000000000000000000000000000000000000',
  decimals0: 18, decimals1: 18, baseIsToken0: true, feeBps: 30,
}

const Q96 = 2n ** 96n
const log = (blockNumber: bigint, logIndex: number, txHash = '0xaa') => ({
  blockNumber,
  logIndex,
  transactionHash: txHash,
  topics: ['0x00'],
  data: encodeAbiParameters(
    [{ type: 'int256' }, { type: 'int256' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }],
    [-1n, 1n, Q96, 0n, 0],
  ),
})

const reader = (logsByRange: Record<string, ReturnType<typeof log>[]>) => ({
  getLogs: vi.fn(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) =>
    logsByRange[`${fromBlock}-${toBlock}`] ?? []),
  getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) =>
    ({ timestamp: BigInt(1_700_000) + blockNumber })),
})

describe('backfillTrades', () => {
  it('pager gjennom blokkintervaller', async () => {
    const r = reader({ '0-9': [log(1n, 0)], '10-19': [log(11n, 0, '0xbb')], '20-20': [] })
    const trades = await backfillTrades(r, meta, 0n, 20n, 10)
    expect(r.getLogs).toHaveBeenCalledTimes(3)
    expect(trades).toHaveLength(2)
  })

  it('deduplikerer på (txHash, logIndex)', async () => {
    const r = reader({ '0-9': [log(1n, 0), log(1n, 0), log(1n, 1)] })
    const trades = await backfillTrades(r, meta, 0n, 9n, 10)
    expect(trades).toHaveLength(2)
  })

  it('setter tidsstempel fra blokken', async () => {
    const r = reader({ '0-9': [log(5n, 0)] })
    const [trade] = await backfillTrades(r, meta, 0n, 9n, 10)
    expect(trade!.ts).toBe(1_700_005_000)
  })

  it('henter hvert blokk-tidsstempel kun én gang', async () => {
    const r = reader({ '0-9': [log(5n, 0), log(5n, 1), log(5n, 2)] })
    await backfillTrades(r, meta, 0n, 9n, 10)
    expect(r.getBlock).toHaveBeenCalledTimes(1)
  })

  it('returnerer handler sortert kronologisk', async () => {
    const r = reader({ '0-9': [log(7n, 0), log(2n, 1, '0xbb'), log(2n, 0, '0xcc')] })
    const trades = await backfillTrades(r, meta, 0n, 9n, 10)
    expect(trades.map((t) => [t.ts, t.logIndex])).toEqual([
      [1_700_002_000, 0], [1_700_002_000, 1], [1_700_007_000, 0],
    ])
  })

  it('gir tom liste når det ikke finnes logger', async () => {
    expect(await backfillTrades(reader({}), meta, 0n, 9n, 10)).toEqual([])
  })
})

describe('backfillTrades ved rate-limiting', () => {
  it('prøver på nytt med voksende pause og lykkes deretter', async () => {
    const r = reader({ '0-9': [log(5n, 0)] })
    const inner = r.getLogs
    let attempts = 0
    r.getLogs = vi.fn(async (args: { fromBlock: bigint; toBlock: bigint }) => {
      if (++attempts <= 2) throw new Error('Too Many Requests')
      return inner(args)
    })
    const naps: number[] = []
    const trades = await backfillTrades(r, meta, 0n, 9n, 10, {
      sleep: async (ms) => { naps.push(ms) },
    })
    expect(attempts).toBe(3)
    expect(trades).toHaveLength(1)
    expect(naps).toEqual([500, 1_000])
  })

  it('gir opp etter siste forsøk og kaster videre', async () => {
    const r = reader({})
    r.getLogs = vi.fn(async () => { throw new Error('Too Many Requests') })
    await expect(
      backfillTrades(r, meta, 0n, 9n, 10, { maxAttempts: 3, sleep: async () => {} }),
    ).rejects.toThrow('Too Many Requests')
    expect(r.getLogs).toHaveBeenCalledTimes(3)
  })

  it('melder hvert nye forsøk til onRetry', async () => {
    const r = reader({ '0-9': [log(5n, 0)] })
    const inner = r.getLogs
    let attempts = 0
    r.getLogs = vi.fn(async (args: { fromBlock: bigint; toBlock: bigint }) => {
      if (++attempts <= 2) throw new Error('Too Many Requests')
      return inner(args)
    })
    const seen: { attempt: number; delayMs: number; message: string }[] = []
    await backfillTrades(r, meta, 0n, 9n, 10, {
      sleep: async () => {},
      onRetry: ({ attempt, delayMs, error }) =>
        seen.push({ attempt, delayMs, message: (error as Error).message }),
    })
    expect(seen).toEqual([
      { attempt: 1, delayMs: 500, message: 'Too Many Requests' },
      { attempt: 2, delayMs: 1_000, message: 'Too Many Requests' },
    ])
  })

  it('prøver også blokk-tidsstempler på nytt', async () => {
    const r = reader({ '0-9': [log(5n, 0)] })
    const inner = r.getBlock
    let attempts = 0
    r.getBlock = vi.fn(async (args: { blockNumber: bigint }) => {
      if (++attempts === 1) throw new Error('Too Many Requests')
      return inner(args)
    })
    const [trade] = await backfillTrades(r, meta, 0n, 9n, 10, { sleep: async () => {} })
    expect(attempts).toBe(2)
    expect(trade!.ts).toBe(1_700_005_000)
  })
})

describe('backfillTrades ved for mange treff', () => {
  const tooMany = () => new Error('logs matched by query exceeds limit of 10000')
  const splittable = (e: unknown) => /exceeds limit/.test((e as Error).message)

  it('deler vinduet i to når det ga for mange treff', async () => {
    const asked: string[] = []
    const r = {
      getLogs: vi.fn(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        asked.push(`${fromBlock}-${toBlock}`)
        if (toBlock - fromBlock > 4n) throw tooMany()
        return fromBlock === 0n ? [log(1n, 0)] : [log(7n, 0, '0xbb')]
      }),
      getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) =>
        ({ timestamp: BigInt(1_700_000) + blockNumber })),
    }
    const trades = await backfillTrades(r, meta, 0n, 9n, 10, {
      sleep: async () => {}, shouldSplit: splittable,
    })
    expect(asked).toEqual(['0-9', '0-4', '5-9'])
    expect(trades).toHaveLength(2)
  })

  it('prøver ikke på nytt når feilen er deterministisk', async () => {
    const r = reader({ '0-4': [log(1n, 0)], '5-9': [] })
    const inner = r.getLogs
    r.getLogs = vi.fn(async (args: { fromBlock: bigint; toBlock: bigint }) => {
      if (args.toBlock - args.fromBlock > 4n) throw tooMany()
      return inner(args)
    })
    const retries: number[] = []
    await backfillTrades(r, meta, 0n, 9n, 10, {
      sleep: async () => {}, shouldSplit: splittable,
      onRetry: ({ attempt }) => retries.push(attempt),
    })
    expect(retries).toEqual([])
  })

  it('gir opp når én enkelt blokk fortsatt gir for mange treff', async () => {
    const r = reader({})
    r.getLogs = vi.fn(async () => { throw tooMany() })
    await expect(
      backfillTrades(r, meta, 5n, 5n, 10, { sleep: async () => {}, shouldSplit: splittable }),
    ).rejects.toThrow('exceeds limit')
  })

  it('deler ikke når kalleren ikke har oppgitt shouldSplit', async () => {
    const r = reader({})
    r.getLogs = vi.fn(async () => { throw tooMany() })
    await expect(
      backfillTrades(r, meta, 0n, 9n, 10, { maxAttempts: 2, sleep: async () => {} }),
    ).rejects.toThrow('exceeds limit')
    expect(r.getLogs).toHaveBeenCalledTimes(2)
  })
})
