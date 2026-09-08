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

function observer(
  overrides: Partial<typeof DEFAULT_CONFIG.strategy> = {},
  dataOverrides: Partial<typeof DEFAULT_CONFIG.data> = {},
) {
  const db = openDb(':memory:')
  migrate(db)
  const setups = new SetupStore(db)
  const notifier = new NullNotifier()
  const config = {
    ...DEFAULT_CONFIG,
    strategy: { ...DEFAULT_CONFIG.strategy, minSwingVolumeQuote: '0', minTradeSizeQuote: '0', ...overrides },
    data: { ...DEFAULT_CONFIG.data, ...dataOverrides },
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

  it('en replayet handel i sonen rører ikke tilstanden og varsler ikke', async () => {
    const { obs, setups, notifier } = observer()
    await feedImpulse(obs)
    await obs.replay(trade(12 * H, 125))   // midt i sonen 120.26–129.26
    expect(setups.allActive()[0]!.state).toBe('DETECTED')
    expect(notifier.sent).toEqual([])
  })

  it('en levende handel i sonen etter replay gir TRIGGERED og et varsel', async () => {
    const { obs, setups, notifier } = observer()
    await feedImpulse(obs)
    await obs.replay(trade(12 * H, 125))
    await obs.onTrade(trade(12 * H + 1_000, 125))
    expect(setups.allActive()[0]!.state).toBe('TRIGGERED')
    expect(notifier.sent.some((a) => a.kind === 'zone')).toBe(true)
  })

  it('replay primer alertsSent uten å sende noe — og hindrer dobbeltvarsel etterpå', async () => {
    const { obs, setups, notifier } = observer()
    await feedImpulse(obs)
    await obs.replay(trade(12 * H, 137))
    expect(setups.allActive()[0]!.alertsSent).toEqual([0.5, 0.618])
    expect(notifier.sent).toEqual([])
    await obs.onTrade(trade(12 * H + 1_000, 137))
    expect(notifier.sent.filter((a) => a.kind === 'milestone')).toEqual([])
  })

  it('replay bygger struktur — oppsettet oppstår av replayede handler alene', async () => {
    const { obs, setups } = observer()
    for (let i = 1; i <= 10; i++) await obs.replay(trade(i * H, 100 + i * 10))
    await obs.replay(trade(11 * H, 195))
    expect(setups.allActive()).toHaveLength(1)
  })

  it('handelsbufferet stabiliserer seg i stedet for å vokse uten tak', async () => {
    const { obs } = observer()
    // To handler per bar, én på barstart og én midt i baren. Vinduet er
    // backfillLookbackBars (24) bars og kanten justeres ned til en barstart,
    // så 25 hele bars × 2 handler = 50 beholdes.
    const feed = async (from: number, to: number) => {
      for (let i = from; i <= to; i++) {
        await obs.onTrade(trade(i * H, 100 + (i % 5)))
        await obs.onTrade(trade(i * H + H / 2, 100 + (i % 5)))
      }
    }
    await feed(1, 200)
    const steady = obs.bufferedTrades
    expect(steady).toBe(50)
    await feed(201, 400)
    expect(obs.bufferedTrades).toBe(steady)
  })

  it('forkaster en handel eldre enn vinduet — verken husket eller evaluert', async () => {
    const { obs, setups, notifier } = observer()
    // Samme impulsbein som feedImpulse, men forskjøvet til bar 100 slik at det
    // finnes plass til noe som er «eldre enn vinduet» uten negativ tid.
    for (let i = 100; i <= 110; i++) await obs.onTrade(trade(i * H, 100 + (i - 100) * 10))
    await obs.onTrade(trade(111 * H, 195))

    const setupsBefore = setups.allActive()
    const buffered = obs.bufferedTrades
    expect(setupsBefore).toHaveLength(1)

    // 61 bars tilbake, langt utenfor 24-bars vinduet, til en pris godt under
    // swing low — den ville ugyldiggjort oppsettet om den ble evaluert.
    await obs.onTrade(trade(50 * H, 10))

    expect(obs.bufferedTrades).toBe(buffered)
    expect(setups.allActive()).toEqual(setupsBefore)
    expect(notifier.sent).toEqual([])
  })

  it('klipping endrer ingenting for en sekvens som passer i vinduet', async () => {
    const seq: Trade[] = []
    for (let i = 1; i <= 10; i++) seq.push(trade(i * H, 100 + i * 10))
    seq.push(trade(11 * H, 195))
    seq.push(trade(12 * H, 137))
    seq.push(trade(12 * H + 1_000, 125))
    seq.push(trade(12 * H + 11_000, 140))

    const bounded = observer()
    const unbounded = observer({}, { backfillLookbackBars: 100_000 })
    for (const t of seq) {
      await bounded.obs.onTrade(t)
      await unbounded.obs.onTrade(t)
    }

    // Sekvensen er 13 bars; ingenting skal ha blitt klippet bort
    expect(bounded.obs.bufferedTrades).toBe(seq.length)
    expect(bounded.setups.allActive()).toEqual(unbounded.setups.allActive())
    expect(bounded.notifier.sent).toEqual(unbounded.notifier.sent)
    expect(bounded.notifier.sent.length).toBeGreaterThan(0)
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
