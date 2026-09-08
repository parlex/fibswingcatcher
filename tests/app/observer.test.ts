import { describe, expect, it } from 'vitest'
import { Observer } from '../../src/app/observer.js'
import { DEFAULT_CONFIG } from '../../src/config/schema.js'
import { NullNotifier } from '../../src/alerts/types.js'
import { SetupStore } from '../../src/store/setups.js'
import { migrate, openDb } from '../../src/store/db.js'
import type { PoolMeta } from '../../src/data/pool.js'
import type { Trade } from '../../src/domain/types.js'

const H = 3_600_000
const pool: PoolMeta = {
  address: '0x1111111111111111111111111111111111111111',
  token0: '0xaaaa000000000000000000000000000000000000',
  token1: '0xbbbb000000000000000000000000000000000000',
  decimals0: 18, decimals1: 18, baseIsToken0: true, feeBps: 30,
}

function observer(overrides: Partial<typeof DEFAULT_CONFIG.strategy> = {}) {
  const db = openDb(':memory:')
  migrate(db)
  const setups = new SetupStore(db)
  const notifier = new NullNotifier()
  const config = {
    ...DEFAULT_CONFIG,
    strategy: { ...DEFAULT_CONFIG.strategy, minSwingVolumeQuote: '0', minTradeSizeQuote: '0', ...overrides },
  }
  const obs = new Observer({
    pool, label: 'TEST/WETH', config, setups, notifier,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  })
  return { obs, setups, notifier }
}

let n = 0
const trade = (ts: number, price: number): Trade => ({
  ts, txHash: `0x${++n}`, logIndex: n, priceQuote: String(price),
  sizeQuote: 1_000_000n, sizeBase: 1n, side: 'buy',
})

/** Bygger et impulsbein fra 100 til 200 over ti timer, så et retracement. */
async function feedImpulse(obs: Observer) {
  for (let i = 1; i <= 10; i++) await obs.onTrade(trade(i * H, 100 + i * 10))
  // ny bar med lavere pris bekrefter beinet
  await obs.onTrade(trade(11 * H, 195))
}

describe('Observer', () => {
  it('lager ikke oppsett før et bein er bekreftet', async () => {
    const { obs, setups } = observer()
    await obs.onTrade(trade(H, 100))
    await obs.onTrade(trade(2 * H, 101))
    expect(setups.allActive()).toEqual([])
  })

  it('lager et oppsett når et bein er bekreftet', async () => {
    const { obs, setups } = observer()
    await feedImpulse(obs)
    expect(setups.allActive().length).toBe(1)
  })

  it('varsler ved 0.618 når prisen retracer', async () => {
    const { obs, notifier } = observer()
    await feedImpulse(obs)
    await obs.onTrade(trade(12 * H, 137))
    const levels = notifier.sent.filter((a) => a.kind === 'milestone').map((a) => a.level)
    expect(levels).toContain(0.5)
    expect(levels).toContain(0.618)
  })

  it('varsler ikke om samme nivå to ganger', async () => {
    const { obs, notifier } = observer()
    await feedImpulse(obs)
    await obs.onTrade(trade(12 * H, 137))
    await obs.onTrade(trade(12 * H + 1000, 136))
    const count = notifier.sent.filter((a) => a.kind === 'milestone' && a.level === 0.618).length
    expect(count).toBe(1)
  })

  it('fanger en berøring av sonen som varer én handel', async () => {
    const { obs, notifier } = observer()
    await feedImpulse(obs)
    await obs.onTrade(trade(12 * H, 137))
    await obs.onTrade(trade(12 * H + 1_000, 125))   // wick ned i sonen (120.26–129.26)
    await obs.onTrade(trade(12 * H + 11_000, 140))  // og ut igjen
    expect(notifier.sent.some((a) => a.kind === 'zone')).toBe(true)
  })

  it('ugyldiggjør oppsettet når prisen bryter under swing low', async () => {
    const { obs, setups, notifier } = observer()
    await feedImpulse(obs)
    await obs.onTrade(trade(12 * H, 95))
    expect(setups.allActive()).toEqual([])
    expect(notifier.sent.some((a) => a.kind === 'invalidated')).toBe(true)
  })

  it('varsler om degradert drift og igjen når den er tilbake', async () => {
    const { obs, notifier } = observer()
    await obs.onStale(45_000)
    await obs.onHealthy()
    expect(notifier.sent.map((a) => a.kind)).toEqual(['degraded', 'recovered'])
  })

  it('erstatter oppsettet når et provisorisk bein utvider toppen', async () => {
    const { obs, setups } = observer()
    await feedImpulse(obs)
    const first = setups.allActive()[0]!
    for (let i = 12; i <= 14; i++) await obs.onTrade(trade(i * H, 200 + i * 10))
    const active = setups.allActive()
    expect(active).toHaveLength(1)
    expect(active[0]!.id).not.toBe(first.id)
    expect(Number(active[0]!.swing.high)).toBeGreaterThan(Number(first.swing.high))
  })

  it('ignorerer handler under minTradeSizeQuote', async () => {
    const { obs, setups } = observer({ minTradeSizeQuote: '2000000' })
    await feedImpulse(obs)
    expect(setups.allActive()).toEqual([])
  })

  it('overlever omstart — oppsett og sendte varsler hentes fra basen', async () => {
    const { obs, setups, notifier } = observer()
    await feedImpulse(obs)
    await obs.onTrade(trade(12 * H, 137))
    const before = setups.allActive()[0]!
    expect(before.alertsSent).toContain(0.618)
    expect(notifier.sent.length).toBeGreaterThan(0)
  })
})
