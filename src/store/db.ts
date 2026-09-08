import Database from 'better-sqlite3'

export type Db = Database.Database

export function openDb(path: string): Db {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  return db
}

export function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS setups (
      id            TEXT PRIMARY KEY,
      pool_address  TEXT NOT NULL,
      state         TEXT NOT NULL,
      swing_json    TEXT NOT NULL,
      levels_json   TEXT NOT NULL,
      created_at_ts INTEGER NOT NULL,
      alerts_json   TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS setups_state ON setups(state);

    CREATE TABLE IF NOT EXISTS watchlist (
      pool_address TEXT PRIMARY KEY,
      quote_token  TEXT NOT NULL,
      label        TEXT NOT NULL,
      added_at_ts  INTEGER NOT NULL
    );
  `)
}
