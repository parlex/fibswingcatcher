import { describe, expect, it } from 'vitest'
import { SetupStore, WatchlistStore } from '../../src/store/setups.js'
import { migrate, openDb } from '../../src/store/db.js'
import { createSetup } from '../../src/strategy/setups.js'
import type { Swing } from '../../src/domain/types.js'

const POOL = '0x1111111111111111111111111111111111111111' as const
const swing: Swing = { lowTs: 0, low: '100', highTs: 1000, high: '200', confirmedAtTs: 1000, provisional: false }
const FIB = { fibEntry: 0.886, fibZoneTop: 0.786, slBufferPct: 2, alertLevels: [0.5, 0.618, 0.786] }

function store() {
  const db = openDb(':memory:')
  migrate(db)
  return { setups: new SetupStore(db), watchlist: new WatchlistStore(db) }
}

describe('SetupStore', () => {
  it('lagrer og henter et oppsett med alle feltene intakt', () => {
    const { setups } = store()
    const s = createSetup(POOL, swing, FIB, 1000)
    setups.upsert(s)
    expect(setups.get(s.id)).toEqual(s)
  })

  it('oppdaterer i stedet for å duplisere ved samme id', () => {
    const { setups } = store()
    const s = createSetup(POOL, swing, FIB, 1000)
    setups.upsert(s)
    setups.upsert({ ...s, state: 'TRIGGERED' })
    expect(setups.get(s.id)!.state).toBe('TRIGGERED')
    expect(setups.allActive()).toHaveLength(1)
  })

  it('utelater terminale tilstander fra allActive', () => {
    const { setups } = store()
    const a = createSetup(POOL, swing, FIB, 1000)
    const b = { ...createSetup(POOL, { ...swing, lowTs: 5 }, FIB, 1000), state: 'EXPIRED' as const }
    setups.upsert(a); setups.upsert(b)
    expect(setups.allActive().map((s) => s.id)).toEqual([a.id])
  })

  it('husker sendte varsler over en runde til basen', () => {
    const { setups } = store()
    const s = createSetup(POOL, swing, FIB, 1000)
    setups.upsert(s)
    setups.recordAlert(s.id, 0.618)
    expect(setups.get(s.id)!.alertsSent).toEqual([0.618])
  })

  it('registrerer aldri samme varsel to ganger', () => {
    const { setups } = store()
    const s = createSetup(POOL, swing, FIB, 1000)
    setups.upsert(s)
    setups.recordAlert(s.id, 0.5)
    setups.recordAlert(s.id, 0.5)
    expect(setups.get(s.id)!.alertsSent).toEqual([0.5])
  })

  it('gir undefined for ukjent id', () => {
    expect(store().setups.get('finnes-ikke')).toBeUndefined()
  })

  it('utelater alle fire terminale tilstander fra allActive', () => {
    const { setups } = store()
    // Active setup (DETECTED)
    const active = createSetup(POOL, swing, FIB, 1000)
    // Terminal setups - each with a distinct swing to avoid ID collision
    const closed = { ...createSetup(POOL, { ...swing, lowTs: 1 }, FIB, 1000), state: 'CLOSED' as const }
    const invalidated = { ...createSetup(POOL, { ...swing, lowTs: 2 }, FIB, 1000), state: 'INVALIDATED' as const }
    const expired = { ...createSetup(POOL, { ...swing, lowTs: 3 }, FIB, 1000), state: 'EXPIRED' as const }
    const rejected = { ...createSetup(POOL, { ...swing, lowTs: 4 }, FIB, 1000), state: 'REJECTED' as const }

    setups.upsert(active)
    setups.upsert(closed)
    setups.upsert(invalidated)
    setups.upsert(expired)
    setups.upsert(rejected)

    const active_ids = setups.allActive().map((s) => s.id)
    expect(active_ids).toEqual([active.id])
    expect(active_ids).not.toContain(closed.id)
    expect(active_ids).not.toContain(invalidated.id)
    expect(active_ids).not.toContain(expired.id)
    expect(active_ids).not.toContain(rejected.id)
  })

  it('sorterer alerter i stigende rekkefølge', () => {
    const { setups } = store()
    const s = createSetup(POOL, swing, FIB, 1000)
    setups.upsert(s)
    // Record in non-ascending order: 0.786, then 0.5, then 0.618
    setups.recordAlert(s.id, 0.786)
    setups.recordAlert(s.id, 0.5)
    setups.recordAlert(s.id, 0.618)
    expect(setups.get(s.id)!.alertsSent).toEqual([0.5, 0.618, 0.786])
  })

  it('migrate er idempotent og bevarer skjema', () => {
    const { setups, watchlist } = store()
    // Call migrate again on the same database
    const db = openDb(':memory:')
    migrate(db)
    migrate(db) // Second call should not throw

    // Verify schema is intact by writing and reading data
    const setupStore = new SetupStore(db)
    const watchlistStore = new WatchlistStore(db)

    const s = createSetup(POOL, swing, FIB, 1000)
    setupStore.upsert(s)
    expect(setupStore.get(s.id)).toEqual(s)

    const e = { poolAddress: POOL, quoteToken: POOL, label: 'TEST/WETH', addedAtTs: 1 }
    watchlistStore.add(e)
    expect(watchlistStore.all()).toEqual([e])
  })
})

describe('WatchlistStore', () => {
  it('lagrer og henter oppføringer', () => {
    const { watchlist } = store()
    const e = { poolAddress: POOL, quoteToken: POOL, label: 'TEST/WETH', addedAtTs: 1 }
    watchlist.add(e)
    expect(watchlist.all()).toEqual([e])
  })

  it('erstatter ved samme pooladresse', () => {
    const { watchlist } = store()
    watchlist.add({ poolAddress: POOL, quoteToken: POOL, label: 'gammel', addedAtTs: 1 })
    watchlist.add({ poolAddress: POOL, quoteToken: POOL, label: 'ny', addedAtTs: 2 })
    expect(watchlist.all()).toHaveLength(1)
    expect(watchlist.all()[0]!.label).toBe('ny')
  })
})

describe('SetupStore per pool', () => {
  const OTHER = '0x2222222222222222222222222222222222222222' as const

  it('activeForPool gir bare den poolens oppsett', () => {
    const { setups } = store()
    const a = createSetup(POOL, swing, FIB, 1000)
    const b = createSetup(OTHER, swing, FIB, 1000)
    setups.upsert(a); setups.upsert(b)
    expect(setups.activeForPool(POOL).map((s) => s.id)).toEqual([a.id])
    expect(setups.activeForPool(OTHER).map((s) => s.id)).toEqual([b.id])
  })

  it('activeForPool utelater avsluttede oppsett', () => {
    const { setups } = store()
    const a = createSetup(POOL, swing, FIB, 1000)
    const b = { ...createSetup(POOL, { ...swing, lowTs: 5 }, FIB, 1000), state: 'INVALIDATED' as const }
    setups.upsert(a); setups.upsert(b)
    expect(setups.activeForPool(POOL).map((s) => s.id)).toEqual([a.id])
  })

  it('activeForPool bryr seg ikke om store og små bokstaver i adressen', () => {
    const { setups } = store()
    setups.upsert(createSetup(POOL, swing, FIB, 1000))
    expect(setups.activeForPool(POOL.toUpperCase() as typeof POOL)).toHaveLength(1)
  })

  it('recordAlert sier om nivået faktisk ble lagt til', () => {
    const { setups } = store()
    const a = createSetup(POOL, swing, FIB, 1000)
    setups.upsert(a)
    expect(setups.recordAlert(a.id, 0.618)).toBe(true)
    expect(setups.recordAlert(a.id, 0.618)).toBe(false)
    expect(setups.recordAlert('finnes-ikke', 0.618)).toBe(false)
  })
})
