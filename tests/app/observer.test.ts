import { describe, expect, it } from 'vitest'
import { Observer } from '../../src/app/observer.js'
import { DEFAULT_CONFIG } from '../../src/config/schema.js'
import { NullNotifier } from '../../src/alerts/types.js'
import type { Notifier } from '../../src/alerts/types.js'
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
  extra: { spotPrice?: () => Promise<string> } = {},
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
  const logs = { info: [] as object[], warn: [] as object[], error: [] as object[] }
  const obs = new Observer({
    pool, label: 'TEST/WETH', config, setups, notifier,
    log: {
      info: (o) => { logs.info.push(o) },
      warn: (o) => { logs.warn.push(o) },
      error: (o) => { logs.error.push(o) },
    },
    ...extra,
  })
  return { obs, setups, notifier, db, config, logs }
}

/** Som `observer()`, men med standardkonfigurasjonen ordrett — ingen nullede
 *  terskler. Brukes til å vise at spec 6.7 faktisk holder som levert. */
function observerWithDefaults() {
  const db = openDb(':memory:')
  migrate(db)
  const setups = new SetupStore(db)
  const notifier = new NullNotifier()
  const obs = new Observer({
    pool, label: 'TEST/WETH', config: DEFAULT_CONFIG, setups, notifier,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  })
  return { obs, setups, notifier, db }
}

const ONE = 10n ** 18n   // én hel quote-token, siden fixture-poolen har 18 desimaler

let n = 0
const trade = (ts: number, price: number, sizeQuote = ONE): Trade => {
  n += 1
  return {
    ts,
    txHash: `0x${n.toString(16).padStart(8, '0')}`,
    // Bevisst en annen formel enn txHash: felt som er like skjuler en
    // ombytting av dem, og det har dukket opp fem ganger i denne grenen.
    logIndex: (n * 3 + 1) % 97,
    priceQuote: String(price),
    sizeQuote,
    sizeBase: ONE,
    side: 'buy',
    liquidity: 1_000_000n * ONE,
  }
}

/**
 * Bygger en bar av flere handler der toppen kommer *sist*.
 *
 * Dette er regimet en ekte pool alltid er i, og det er nettopp det ingen
 * fixture i denne grenen hadde: alle matet én handel per bar, så en bar hvis
 * topp stiger etter første handel fantes ikke i noen test. Deteksjonen kjørte
 * derfor på en bar som holdt én pris, og fib-nivåene ble tegnet fra den.
 */
async function feedBar(obs: Observer, barIndex: number, prices: number[]) {
  const step = Math.floor(H / (prices.length + 1))
  for (const [i, price] of prices.entries()) {
    await obs.onTrade(trade(barIndex * H + i * step, price))
  }
}

/**
 * Bygger et impulsbein 110 → 200, med bunnen som en *indre* pivot.
 *
 * Bar 1 ligger høyere enn bunnen på bar 2 med vilje: deteksjonen nekter å
 * forankre et oppsett på den eldste beholdte baren, siden en vinduskant ikke
 * er en pivot. Bar 12 finnes for å lukke bar 11 — strukturklokken ser bare
 * lukkede bars.
 */
async function feedImpulse(obs: Observer, size = ONE) {
  await obs.onTrade(trade(1 * H, 130, size))
  await obs.onTrade(trade(2 * H, 110, size))
  for (let i = 3; i <= 11; i++) await obs.onTrade(trade(i * H, 110 + (i - 2) * 10, size))
  await obs.onTrade(trade(12 * H, 195, size))
}

/** Første bar etter at `feedImpulse` har lukket beinet. */
const AFTER = 13 * H

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
    await obs.onTrade(trade(AFTER, 137))
    const levels = notifier.sent.filter((a) => a.kind === 'milestone').map((a) => a.level)
    expect(levels).toContain(0.5)
    expect(levels).toContain(0.618)
  })

  it('varsler ikke om samme nivå to ganger', async () => {
    const { obs, notifier } = observer()
    await feedImpulse(obs)
    await obs.onTrade(trade(AFTER, 137))
    await obs.onTrade(trade(AFTER + 1000, 136))
    const count = notifier.sent.filter((a) => a.kind === 'milestone' && a.level === 0.618).length
    expect(count).toBe(1)
  })

  it('fanger en berøring av sonen som varer én handel', async () => {
    const { obs, notifier } = observer()
    await feedImpulse(obs)
    await obs.onTrade(trade(AFTER, 137))
    await obs.onTrade(trade(AFTER + 1_000, 125))   // wick ned i sonen (120.26–129.26)
    await obs.onTrade(trade(AFTER + 11_000, 140))  // og ut igjen
    expect(notifier.sent.some((a) => a.kind === 'zone')).toBe(true)
  })

  it('ugyldiggjør oppsettet når en bar lukker under swing low', async () => {
    const { obs, setups, notifier } = observer()
    await feedImpulse(obs)
    await obs.onTrade(trade(AFTER, 95))
    // Baren har ikke lukket ennå — oppsettet står
    expect(setups.allActive()).toHaveLength(1)
    expect(notifier.sent.some((a) => a.kind === 'invalidated')).toBe(false)

    await obs.onTrade(trade(AFTER + H, 96))   // lukker baren på 95
    expect(setups.allActive()).toEqual([])
    expect(notifier.sent.some((a) => a.kind === 'invalidated')).toBe(true)
  })

  it('ett wick under swing low ødelegger ikke oppsettet', async () => {
    // Spec 2.4, og tredje ben i støvhandel-angrepet: prisen må *lukke* under
    // bunnen. Wicket ned og opp igjen innenfor samme bar teller ikke.
    const { obs, setups, notifier } = observer()
    await feedImpulse(obs)
    await obs.onTrade(trade(AFTER, 1))              // absurd wick
    await obs.onTrade(trade(AFTER + 1_000, 140))    // og ut igjen
    await obs.onTrade(trade(AFTER + H, 140))        // baren lukker på 140
    expect(setups.allActive()).toHaveLength(1)
    expect(notifier.sent.some((a) => a.kind === 'invalidated')).toBe(false)
  })

  it('tegner nivåene fra barens ekte topp, ikke fra første handel i den', async () => {
    // C3: deteksjonen kjørte på en bar som holdt én pris. Satte den handelen en
    // ny topp, ble beinets `high` det ene printet — og siden oppsett-id-en er
    // `pool-lowTs-highTs` ga en senere deteksjon samme id, så nivåene ble
    // aldri regnet om. Her stiger toppen *etter* første handel i baren.
    const { obs, setups } = observer()
    await feedBar(obs, 1, [130])
    await feedBar(obs, 2, [110])
    for (let i = 3; i <= 10; i++) await feedBar(obs, i, [110 + (i - 2) * 10])
    // Bar 11 åpner på 150 og topper på 200 — første handel er ikke toppen
    await feedBar(obs, 11, [150, 170, 200, 185])
    await feedBar(obs, 12, [195])

    const setup = setups.allActive()[0]!
    expect(setup.swing.high).toBe('200')
    // Sonen skal være regnet fra 200, ikke fra 150
    expect(setup.levels.zoneTop).toBeCloseTo(200 - 0.786 * 90, 6)
    expect(setup.levels.zoneBottom).toBeCloseTo(200 - 0.886 * 90, 6)
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
    for (let i = 13; i <= 16; i++) await obs.onTrade(trade(i * H, 200 + i * 10))
    const active = setups.allActive()
    expect(active).toHaveLength(1)
    expect(active[0]!.id).not.toBe(first.id)
    expect(Number(active[0]!.swing.high)).toBeGreaterThan(Number(first.swing.high))
  })

  it('ignorerer handler under minTradeSizeQuote', async () => {
    const { obs, setups } = observer({ minTradeSizeQuote: '2' })
    await feedImpulse(obs)
    expect(setups.allActive()).toEqual([])
  })

  it('en replayet handel i sonen rører ikke tilstanden og varsler ikke', async () => {
    const { obs, setups, notifier } = observer()
    await feedImpulse(obs)
    await obs.replay(trade(AFTER, 125))   // midt i sonen 120.26–129.26
    expect(setups.allActive()[0]!.state).toBe('DETECTED')
    expect(notifier.sent).toEqual([])
  })

  it('replay setter strukturelle sluttilstander, men annonserer dem ikke', async () => {
    // I12: et strukturbrudd fra før oppstart er et faktum om historikken,
    // like mye som superseder-EXPIRED vi alt tillater. Nektet vi det,
    // overlevde det døde oppsettet replayen og sendte «oppsett ugyldig» til
    // låseskjermen på første levende handel.
    const { obs, setups, notifier } = observer()
    await feedImpulse(obs)
    const id = setups.allActive()[0]!.id

    await obs.replay(trade(AFTER, 95))
    await obs.replay(trade(AFTER + H, 96))   // lukker baren under swing low

    expect(setups.get(id)!.state).toBe('INVALIDATED')
    expect(setups.allActive()).toEqual([])
    expect(notifier.sent).toEqual([])

    // Og ingenting lekker ut på første levende handel etterpå
    await obs.onTrade(trade(AFTER + 2 * H, 97))
    expect(notifier.sent).toEqual([])
  })

  it('en levende handel i sonen etter replay gir TRIGGERED og et varsel', async () => {
    const { obs, setups, notifier } = observer()
    await feedImpulse(obs)
    await obs.replay(trade(AFTER, 125))
    await obs.onTrade(trade(AFTER + 1_000, 125))
    expect(setups.allActive()[0]!.state).toBe('TRIGGERED')
    expect(notifier.sent.some((a) => a.kind === 'zone')).toBe(true)
  })

  it('replay primer alertsSent uten å sende noe — og hindrer dobbeltvarsel etterpå', async () => {
    const { obs, setups, notifier } = observer()
    await feedImpulse(obs)
    await obs.replay(trade(AFTER, 137))
    expect(setups.allActive()[0]!.alertsSent).toEqual([0.5, 0.618])
    expect(notifier.sent).toEqual([])
    await obs.onTrade(trade(AFTER + 1_000, 137))
    expect(notifier.sent.filter((a) => a.kind === 'milestone')).toEqual([])
  })

  it('replay bygger struktur — oppsettet oppstår av replayede handler alene', async () => {
    const { obs, setups } = observer()
    await obs.replay(trade(1 * H, 130))
    await obs.replay(trade(2 * H, 110))
    for (let i = 3; i <= 11; i++) await obs.replay(trade(i * H, 110 + (i - 2) * 10))
    await obs.replay(trade(12 * H, 195))
    expect(setups.allActive()).toHaveLength(1)
  })

  it('minnet stabiliserer seg på bars, ikke på handler', async () => {
    const { obs } = observer()
    // Rå handler beholdes ikke i det hele tatt: `detectSwings` tar bars og
    // `evaluateSetup` tar en pris. Det bundne er derfor antall bars — 24 i
    // vinduet pluss den kanten justeres ned til, altså 25 — uansett hvor
    // travel poolen er.
    const feed = async (from: number, to: number) => {
      for (let i = from; i <= to; i++) {
        for (let k = 0; k < 20; k++) {
          await obs.onTrade(trade(i * H + k * 90_000, 100 + (i % 5)))
        }
      }
    }
    await feed(1, 100)
    expect(obs.retainedBars).toBe(25)
    const acceptedAfterFirst = obs.accepted

    await feed(101, 200)
    // Bundet selv om dobbelt så mange handler har passert gjennom.
    expect(obs.retainedBars).toBe(25)
    expect(obs.accepted).toBe(acceptedAfterFirst * 2)
  })

  it('forkaster en handel eldre enn vinduet — verken husket eller evaluert', async () => {
    const { obs, setups, notifier } = observer()
    // Samme impulsbein som feedImpulse, men forskjøvet til bar 100 slik at det
    // finnes plass til noe som er «eldre enn vinduet» uten negativ tid.
    await obs.onTrade(trade(100 * H, 130))
    await obs.onTrade(trade(101 * H, 110))
    for (let i = 102; i <= 110; i++) await obs.onTrade(trade(i * H, 110 + (i - 101) * 10))
    await obs.onTrade(trade(111 * H, 195))

    const setupsBefore = setups.allActive()
    const acceptedBefore = obs.accepted
    expect(setupsBefore).toHaveLength(1)

    // 61 bars tilbake, langt utenfor 24-bars vinduet, til en pris godt under
    // swing low — den ville ugyldiggjort oppsettet om den ble evaluert.
    await obs.onTrade(trade(50 * H, 10))

    expect(obs.accepted).toBe(acceptedBefore)
    expect(obs.droppedOld).toBe(1)
    expect(setups.allActive()).toEqual(setupsBefore)
    expect(notifier.sent).toEqual([])
  })

  it('klipping endrer ingenting for en sekvens som passer i vinduet', async () => {
    const seq: Trade[] = [trade(1 * H, 130), trade(2 * H, 110)]
    for (let i = 3; i <= 11; i++) seq.push(trade(i * H, 110 + (i - 2) * 10))
    seq.push(trade(12 * H, 195))
    seq.push(trade(AFTER, 137))
    seq.push(trade(AFTER + 1_000, 125))
    seq.push(trade(AFTER + 11_000, 140))

    const bounded = observer()
    const unbounded = observer({}, { backfillLookbackBars: 100_000 })
    for (const t of seq) {
      await bounded.obs.onTrade(t)
      await unbounded.obs.onTrade(t)
    }

    // Sekvensen er 13 bars; ingenting skal ha blitt klippet bort. `accepted`
    // vitner om inngangsguarden, `retainedBars` om klippingen — begge trengs.
    expect(bounded.obs.accepted).toBe(seq.length)
    expect(bounded.obs.retainedBars).toBe(13)
    expect(bounded.setups.allActive()).toEqual(unbounded.setups.allActive())
    expect(bounded.notifier.sent).toEqual(unbounded.notifier.sent)
    expect(bounded.notifier.sent.length).toBeGreaterThan(0)
  })

  it('overlever omstart — en ny observatør over samme base varsler ikke på nytt', async () => {
    const first = observer()
    await feedImpulse(first.obs)
    await first.obs.onTrade(trade(AFTER, 137))
    const before = first.setups.allActive()[0]!
    expect(before.alertsSent).toEqual([0.5, 0.618])
    expect(first.notifier.sent.filter((a) => a.kind === 'milestone')).toHaveLength(2)

    // Omstart: ny SetupStore og ny Observer over samme basehåndtak
    const setups = new SetupStore(first.db)
    const notifier = new NullNotifier()
    const restarted = new Observer({
      pool, label: 'TEST/WETH', config: first.config, setups, notifier,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    })
    expect(setups.allActive()[0]!.alertsSent).toEqual([0.5, 0.618])

    // Slik main.ts starter opp: historikken gjennom replay(), så levende
    await restarted.replay(trade(1 * H, 130))
    await restarted.replay(trade(2 * H, 110))
    for (let i = 3; i <= 11; i++) await restarted.replay(trade(i * H, 110 + (i - 2) * 10))
    await restarted.replay(trade(12 * H, 195))
    await restarted.replay(trade(AFTER, 137))
    expect(notifier.sent).toEqual([])

    await restarted.onTrade(trade(AFTER + 1_000, 137))
    expect(notifier.sent.filter((a) => a.kind === 'milestone')).toEqual([])
  })

  it('nekter å forankre på vinduskanten, også ved kaldstart', async () => {
    // Monotont stigende bein fra første bar: kandidatbunnen er alltid
    // `bars[0]`, som er en vinduskant. Ved kaldstart er det et blokknummer
    // valgt av et takt-anslag, altså det mest vilkårlige punktet som finnes —
    // ikke det minst. Da lages ingen oppsett, og det er riktig.
    const { obs, setups } = observer()
    for (let i = 1; i <= 60; i++) await obs.onTrade(trade(i * H, 100 + i * 5))
    expect(setups.allActive()).toEqual([])
  })

  it('beholder oppsettet når bunnen glir ut av vinduet, uten å re-forankre', async () => {
    // Bunnen er en indre pivot på bar 2 og har for lengst forlatt 24-bars
    // vinduet. Uten avvisningen av kantforankring ville detectSwings satt en
    // ny kandidatbunn på bars[0] for hver bar, og hvert steg blitt et oppsett.
    const { obs, setups } = observer()
    await obs.onTrade(trade(1 * H, 200))
    await obs.onTrade(trade(2 * H, 100))
    for (let i = 3; i <= 60; i++) await obs.onTrade(trade(i * H, 100 + (i - 2) * 5))

    const active = setups.allActive()
    expect(active).toHaveLength(1)
    const windowEdgeTs = 60 * H - 24 * H
    expect(active[0]!.swing.lowTs).toBeLessThan(windowEdgeTs)
  })

  it('samler ikke opp oppsett når vinduet glir forbi et ekte bein', async () => {
    // Ekte bunn på bar 3, ekte topp på bar 15, så 35 bars sidelengs over
    // sonen. Sekvensen er lengre enn 24-bars vinduet, så bars[0] glir.
    const { obs, setups, notifier } = observer()
    const price = (i: number) => {
      if (i === 1) return 140                    // høyere start, så bunnen blir en indre pivot
      if (i <= 3) return 100                     // ekte bunn
      if (i <= 15) return 100 + (i - 3) * 8.5    // 100 -> 202
      return 190                                 // sidelengs, godt over sonen
    }
    for (let i = 1; i <= 50; i++) await obs.onTrade(trade(i * H, price(i)))

    expect(setups.allActive()).toHaveLength(1)
    expect(notifier.sent.filter((a) => a.kind === 'milestone')).toEqual([])
  })

  it('et treg bein etterfulgt av retracement gir ett oppsett, ikke atten', async () => {
    const { obs, setups, notifier } = observer()
    await obs.onTrade(trade(1 * H, 140))   // høyere start, så bunnen blir en indre pivot
    for (let i = 2; i <= 41; i++) await obs.onTrade(trade(i * H, 100 + (i - 2) * 2.5)) // 100 -> 197.5
    for (let i = 42; i <= 46; i++) await obs.onTrade(trade(i * H, 180))
    expect(setups.allActive()).toHaveLength(1)
    expect(notifier.sent.filter((a) => a.kind === 'milestone')).toEqual([])
  })

  it('to bunner på én ekte topp gir ett oppsett, ikke søsken', async () => {
    // Bunn A på bar 2 forsvinner ut av vinduet. Bunn B på bar 11 er en *indre*
    // pivot, ikke en vinduskant, så det nye oppsettet slipper gjennom
    // kantsjekken — men det er tegnet fra samme ekte topp på bar 21. Uten at
    // superseder-regelen også nøkler på topp-tidspunktet, står de som søsken.
    const { obs, setups } = observer()
    const price = (i: number) => {
      if (i === 1) return 200
      if (i === 2) return 100      // bunn A
      if (i <= 10) return 150
      if (i === 11) return 130     // bunn B, indre pivot — for grunn til å bekrefte beinet
      if (i <= 20) return 150
      if (i === 21) return 400     // den ene ekte toppen
      return 380
    }
    for (let i = 1; i <= 50; i++) await obs.onTrade(trade(i * H, price(i)))

    const active = setups.allActive()
    expect(active).toHaveLength(1)
    expect(active[0]!.swing.highTs).toBe(21 * H)
    expect(active[0]!.swing.lowTs).toBe(11 * H)   // den nyere, strammere bunnen vant
  })

  it('en annen pools handel rører ikke dette oppsettet', async () => {
    // Nøyaktig slik main.ts kobler det: én SetupStore, én Observer per pool.
    const shared = observer()
    const poolB: PoolMeta = { ...pool, address: '0x2222222222222222222222222222222222222222' }
    const obsB = new Observer({
      pool: poolB, label: 'ANNEN/WETH', config: shared.config,
      setups: shared.setups, notifier: shared.notifier,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    })

    await feedImpulse(shared.obs)
    const before = shared.setups.allActive()
    expect(before).toHaveLength(1)
    expect(shared.notifier.sent).toEqual([])

    // Pool B handler på en helt annen prisskala — under pool A sin swing low
    await obsB.onTrade(trade(AFTER, 0.0001))

    expect(shared.setups.activeForPool(pool.address)).toEqual(before)
    expect(shared.notifier.sent.filter((a) => 'setup' in a && a.setup.poolAddress === pool.address))
      .toEqual([])
  })

  it('en annen pools stale-strøm disarmerer ikke dette oppsettet', async () => {
    const shared = observer()
    const poolB: PoolMeta = { ...pool, address: '0x2222222222222222222222222222222222222222' }
    const obsB = new Observer({
      pool: poolB, label: 'ANNEN/WETH', config: shared.config,
      setups: shared.setups, notifier: shared.notifier,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    })

    await feedImpulse(shared.obs)
    const s = shared.setups.allActive()[0]!
    shared.setups.upsert({ ...s, state: 'ARMED' })

    await obsB.onStale(45_000)

    expect(shared.setups.get(s.id)!.state).toBe('ARMED')
  })

  it('disarmerer et ARMED oppsett når strømmen blir stale', async () => {
    const { obs, setups, notifier } = observer()
    await feedImpulse(obs)
    const s = setups.allActive()[0]!
    setups.upsert({ ...s, state: 'ARMED' })
    expect(setups.get(s.id)!.state).toBe('ARMED')

    await obs.onStale(45_000)

    expect(setups.get(s.id)!.state).toBe('DETECTED')
    expect(notifier.sent.map((a) => a.kind)).toEqual(['degraded'])
  })

  it('en støvhandel under terskelen ødelegger ikke et gyldig oppsett', async () => {
    // Spec 6.7 mottiltak 1, med standardkonfigurasjonen ordrett. Tersklene er
    // skrevet i quote-token, og skaleres med tokenets desimaler før de
    // sammenlignes med rå kjede-enheter. Uten skaleringen er '50' femti wei,
    // og da slipper denne handelen gjennom og river oppsettet.
    const { obs, setups, notifier } = observerWithDefaults()
    // 2 000 quote-token per handel, så beinet passerer minSwingVolumeQuote
    // (10 000) og hver handel passerer minTradeSizeQuote (50)
    await feedImpulse(obs, 2_000n * ONE)
    expect(setups.allActive()).toHaveLength(1)

    // 100 wei, som printer prisen 1 — nøyaktig angrepet
    await obs.onTrade(trade(AFTER, 1, 100n))
    await obs.onTrade(trade(AFTER + H, 1, 100n))

    expect(setups.allActive()).toHaveLength(1)
    expect(notifier.sent).toEqual([])
  })

  it('skalerer tersklene med quote-tokenets desimaler', async () => {
    // 6 desimaler (USDC-aktig) og 18 (WETH-aktig) må gi samme *mening*
    for (const [decimals, oneToken] of [[6, 10n ** 6n], [18, 10n ** 18n]] as const) {
      const db = openDb(':memory:')
      migrate(db)
      const setups = new SetupStore(db)
      const quotePool: PoolMeta = { ...pool, decimals0: decimals, decimals1: decimals }
      const obs = new Observer({
        pool: quotePool, label: 'T', config: DEFAULT_CONFIG, setups,
        notifier: new NullNotifier(),
        log: { info: () => {}, warn: () => {}, error: () => {} },
      })
      // minTradeSizeQuote er '0.015': 0,014 skal falle, 0,016 skal telle
      await obs.onTrade(trade(1 * H, 130, 14n * oneToken / 1_000n))
      expect(obs.accepted, `${decimals} desimaler`).toBe(0)
      await obs.onTrade(trade(1 * H, 130, 16n * oneToken / 1_000n))
      expect(obs.accepted, `${decimals} desimaler`).toBe(1)
    }
  })

  it('nekter en tilstandsendring når spotprisen spriker fra handelsprisen', async () => {
    // Spec 6.7 mottiltak 2: én uavhengig lesning av poolens egen pris, bare
    // ved tilstandsendringer.
    const { obs, setups, notifier } = observer({}, {}, { spotPrice: async () => '190' })
    await feedImpulse(obs)
    await obs.onTrade(trade(AFTER, 125))   // midt i sonen, men spot sier 190

    expect(setups.allActive()[0]!.state).toBe('DETECTED')
    expect(notifier.sent.some((a) => a.kind === 'zone')).toBe(false)
  })

  it('slipper gjennom når spotprisen bekrefter handelsprisen', async () => {
    const { obs, setups, notifier } = observer({}, {}, { spotPrice: async () => '124.5' })
    await feedImpulse(obs)
    await obs.onTrade(trade(AFTER, 125))

    expect(setups.allActive()[0]!.state).toBe('TRIGGERED')
    expect(notifier.sent.some((a) => a.kind === 'zone')).toBe(true)
  })

  it('stoler på handelsprisen når spotoppslaget feiler', async () => {
    const { obs, setups } = observer({}, {}, {
      spotPrice: async () => { throw new Error('RPC nede') },
    })
    await feedImpulse(obs)
    await obs.onTrade(trade(AFTER, 125))
    expect(setups.allActive()[0]!.state).toBe('TRIGGERED')
  })

  it('leser ikke spotprisen for et milepælsvarsel', async () => {
    let reads = 0
    const { obs } = observer({}, {}, {
      spotPrice: async () => { reads += 1; return '137' },
    })
    await feedImpulse(obs)
    await obs.onTrade(trade(AFTER, 137))   // krysser 0.5 og 0.618, ingen overgang
    expect(reads).toBe(0)
  })

  it('logger når spotoppslaget gir en ubrukelig pris i stedet for å tie', async () => {
    // Eneste stien der mottiltaket slår seg av uten spor: en ikke-positiv
    // eller uparsbar spotpris ga `return true` uten en eneste logglinje.
    const { obs, setups, logs } = observer({}, {}, { spotPrice: async () => '0' })
    await feedImpulse(obs)
    await obs.onTrade(trade(AFTER, 125))

    expect(setups.allActive()[0]!.state).toBe('TRIGGERED')   // feiler fortsatt åpent
    expect(logs.warn).toContainEqual(
      expect.objectContaining({ spot: 0 }),                  // men ikke i stillhet
    )
  })

  it('logger også når spotoppslaget gir noe som ikke er et tall', async () => {
    const { obs, logs } = observer({}, {}, { spotPrice: async () => 'abc' })
    await feedImpulse(obs)
    await obs.onTrade(trade(AFTER, 125))
    expect(logs.warn).toContainEqual(expect.objectContaining({ spot: NaN }))
  })

  it('et ekte strukturbrudd ugyldiggjør selv når prisen har hentet seg inn igjen', async () => {
    // Spot-sjekken hører ikke på denne stien. Den validerer at en pris *nå*
    // stemmer med poolen *nå*; en barlukking er et historisk faktum, og ingen
    // nåtidslesning kan bekrefte den. Da barlukkingen ble sendt inn i
    // toleransesjekken, ble et ekte brudd avvist fordi prisen hadde hentet seg
    // inn — og oppsettet sendte senere et `zone`-varsel på et brutt bein.
    const { obs, setups, notifier } = observer({}, {}, { spotPrice: async () => '140' })
    await feedImpulse(obs)

    await feedBar(obs, 13, [130, 105])     // lukker på 105, under swing low 110
    await obs.onTrade(trade(14 * H, 140))  // prisen er tilbake på 140

    expect(setups.allActive()).toHaveLength(0)
    expect(notifier.sent.some((a) => a.kind === 'invalidated')).toBe(true)
  })

  it('en avvist overgang kan ikke gjøre et oppsett udødelig', async () => {
    // Ugyldiggjøring sjekkes før alder, så en avvisning der maskerte utløpet.
    const { obs, setups } = observer({}, {}, { spotPrice: async () => '1' })
    await feedImpulse(obs)
    expect(setups.allActive()).toHaveLength(1)

    // Hver bar lukker under swing low (110), så ugyldiggjøring forsøkes hver
    // gang — og med spot på 1 ville den blitt avvist hver gang.
    for (let b = 14; b <= 70; b++) await obs.onTrade(trade(b * H, 105 - (b - 14)))
    expect(setups.allActive()).toHaveLength(0)
  })

  it('utløper selv om spotprisen spriker — utløp er aldersdrevet, ikke prisdrevet', async () => {
    // En sprikende spot skal ikke kunne holde et gammelt oppsett i live.
    // Uten dette blokkerer en angriper som styrer spriket alle utløp, og
    // aktive oppsett hoper seg opp for alltid.
    const { obs, setups, notifier } = observer({}, {}, { spotPrice: async () => '1' })
    await feedImpulse(obs)
    expect(setups.allActive()).toHaveLength(1)

    await obs.onTrade(trade(61 * H, 140))   // godt forbi maxSetupAgeBars (48)

    expect(setups.allActive()).toHaveLength(0)
    // Entydig: det var utløp, ikke ugyldiggjøring, som avsluttet oppsettet.
    expect(notifier.sent.some((a) => a.kind === 'expired')).toBe(true)
  })

  it('ugyldiggjør fortsatt når barlukkingen selv bekreftes av spotprisen', async () => {
    // Kontrollen: at spot-sjekken er tatt av denne stien betyr ikke at
    // ugyldiggjøring er skrudd av. Denne viser at et brudd med spot enig
    // fortsatt dreper oppsettet.
    const { obs, setups, notifier } = observer({}, {}, { spotPrice: async () => '100' })
    await feedImpulse(obs)

    await feedBar(obs, 13, [105, 100])     // ekte sammenbrudd, spot er enig
    await obs.onTrade(trade(14 * H, 101))

    expect(setups.allActive()).toHaveLength(0)
    expect(notifier.sent.some((a) => a.kind === 'invalidated')).toBe(true)
  })

  it('en støvhandel i sonen trigger ingenting', async () => {
    const { obs, setups, notifier } = observer({ minTradeSizeQuote: '1' })
    await feedImpulse(obs)
    expect(setups.allActive()).toHaveLength(1)

    // Midt i sonen 120.26–129.26, men under minTradeSizeQuote
    await obs.onTrade(trade(AFTER, 125, ONE - 1n))

    expect(setups.allActive()[0]!.state).toBe('DETECTED')
    expect(notifier.sent).toEqual([])
  })

  it('varsler ikke samme nivå to ganger når to handler behandles samtidig', async () => {
    // main.ts sender flere handler fra samme viem-batch uten å avvente hver,
    // og `newAlerts` beregnes før første await. Uten at recordAlert sier om
    // nivået faktisk ble lagt til, sender to samtidige kall samme milepæl.
    const db = openDb(':memory:')
    migrate(db)
    const setups = new SetupStore(db)
    const config = {
      ...DEFAULT_CONFIG,
      strategy: { ...DEFAULT_CONFIG.strategy, minSwingVolumeQuote: '0', minTradeSizeQuote: '0' },
    }
    const sent: string[] = []
    const slow: Notifier = {
      async send(a) {
        await new Promise((r) => setTimeout(r, 20))
        sent.push(a.kind === 'milestone' ? `milestone${a.level}` : a.kind)
      },
    }
    const obs = new Observer({
      pool, label: 'TEST/WETH', config, setups, notifier: slow,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    })

    await feedImpulse(obs)
    expect(setups.allActive()[0]!.alertsSent).toEqual([])

    // To uavventede kall til samme pris, kjørt samtidig
    await Promise.all([obs.onTrade(trade(AFTER, 137)), obs.onTrade(trade(AFTER, 137))])

    expect(sent.filter((k) => k === 'milestone0.618')).toHaveLength(1)
    expect(sent.filter((k) => k === 'milestone0.5')).toHaveLength(1)
  })
})
