import type { Hex, SetupState } from '../domain/types.js'
import type { Setup } from '../strategy/setups.js'
import type { Db } from './db.js'

const TERMINAL: SetupState[] = ['CLOSED', 'INVALIDATED', 'EXPIRED', 'REJECTED']

type Row = {
  id: string; pool_address: string; state: string
  swing_json: string; levels_json: string
  created_at_ts: number; alerts_json: string
}

const toSetup = (r: Row): Setup => ({
  id: r.id,
  poolAddress: r.pool_address as Hex,
  state: r.state as SetupState,
  swing: JSON.parse(r.swing_json),
  levels: JSON.parse(r.levels_json),
  createdAtTs: r.created_at_ts,
  alertsSent: JSON.parse(r.alerts_json),
})

export class SetupStore {
  constructor(private db: Db) {}

  /**
   * Skriver raden slik den er gitt — alle kolonner, ikke bare noen.
   *
   * Den forrige versjonen oppdaterte `state`, `levels_json` og `alerts_json`
   * men ikke `swing_json`, `pool_address` eller `created_at_ts`. Det ga en rad
   * som kunne bære to forskjellige beina samtidig: et `swing` fra første
   * skriving ved siden av `levels` regnet fra et annet. Alle kallere sender et
   * fullstendig `Setup` (`upsert({ ...s, state })`, `upsert({ ...s,
   * alertsSent })`, `upsert(setup)`), så full erstatning er det de allerede
   * mener — og den fjerner fellen.
   */
  upsert(s: Setup): void {
    this.db.prepare(`
      INSERT INTO setups (id, pool_address, state, swing_json, levels_json, created_at_ts, alerts_json)
      VALUES (@id, @pool, @state, @swing, @levels, @created, @alerts)
      ON CONFLICT(id) DO UPDATE SET
        pool_address = excluded.pool_address,
        state = excluded.state,
        swing_json = excluded.swing_json,
        levels_json = excluded.levels_json,
        created_at_ts = excluded.created_at_ts,
        alerts_json = excluded.alerts_json
    `).run({
      id: s.id, pool: s.poolAddress, state: s.state,
      swing: JSON.stringify(s.swing), levels: JSON.stringify(s.levels),
      created: s.createdAtTs, alerts: JSON.stringify(s.alertsSent),
    })
  }

  get(id: string): Setup | undefined {
    const row = this.db.prepare('SELECT * FROM setups WHERE id = ?').get(id) as Row | undefined
    return row ? toSetup(row) : undefined
  }

  allActive(): Setup[] {
    const placeholders = TERMINAL.map(() => '?').join(',')
    const rows = this.db
      .prepare(`SELECT * FROM setups WHERE state NOT IN (${placeholders}) ORDER BY created_at_ts`)
      .all(...TERMINAL) as Row[]
    return rows.map(toSetup)
  }

  /**
   * Aktive oppsett for én pool.
   *
   * Finnes fordi flere observatører deler én base — én per pool i
   * watchlisten. `allActive()` filtrerer bare på tilstand, så en observatør
   * som brukte den ville evaluert *alle* poolers oppsett mot sin egen pris,
   * på en helt annen prisskala. Begrensningen hører i spørringen, ikke hos
   * kalleren.
   *
   * `COLLATE NOCASE` fordi adresser skrives både med og uten sjekksum-store
   * bokstaver, og en pool er den samme poolen uansett.
   */
  activeForPool(poolAddress: Hex): Setup[] {
    const placeholders = TERMINAL.map(() => '?').join(',')
    const rows = this.db
      .prepare(`
        SELECT * FROM setups
        WHERE pool_address = ? COLLATE NOCASE AND state NOT IN (${placeholders})
        ORDER BY created_at_ts
      `)
      .all(poolAddress, ...TERMINAL) as Row[]
    return rows.map(toSetup)
  }

  /**
   * Registrerer at et fib-nivå er varslet.
   *
   * Returnerer `true` bare når nivået faktisk ble lagt til. Kalleren skal sende
   * varselet kun da: better-sqlite3 er synkron, så to samtidige
   * `onTrade`-kall som beregnet samme `newAlerts` før første `await` kan ikke
   * begge få `true` her. Det gjør dobbeltvarsling umulig uavhengig av
   * serialiseringen i `main.ts`.
   */
  recordAlert(id: string, level: number): boolean {
    const s = this.get(id)
    if (!s || s.alertsSent.includes(level)) return false
    this.upsert({ ...s, alertsSent: [...s.alertsSent, level].sort((a, b) => a - b) })
    return true
  }
}

export type WatchlistEntry = {
  poolAddress: Hex
  quoteToken: Hex
  label: string
  addedAtTs: number
}

export class WatchlistStore {
  constructor(private db: Db) {}

  add(e: WatchlistEntry): void {
    this.db.prepare(`
      INSERT INTO watchlist (pool_address, quote_token, label, added_at_ts)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(pool_address) DO UPDATE SET
        quote_token = excluded.quote_token,
        label = excluded.label,
        added_at_ts = excluded.added_at_ts
    `).run(e.poolAddress, e.quoteToken, e.label, e.addedAtTs)
  }

  all(): WatchlistEntry[] {
    const rows = this.db.prepare('SELECT * FROM watchlist ORDER BY added_at_ts').all() as {
      pool_address: string; quote_token: string; label: string; added_at_ts: number
    }[]
    return rows.map((r) => ({
      poolAddress: r.pool_address as Hex,
      quoteToken: r.quote_token as Hex,
      label: r.label,
      addedAtTs: r.added_at_ts,
    }))
  }
}
