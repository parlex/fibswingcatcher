import 'dotenv/config'
import { migrate, openDb } from '../src/store/db.js'
import { WatchlistStore } from '../src/store/setups.js'

const [pool, quote, label] = process.argv.slice(2)
if (!pool || !quote || !label) {
  throw new Error('bruk: npm run watchlist:add -- <pool> <quote-token> <etikett>')
}

const db = openDb(process.env.DB_PATH ?? 'data/fibswingcatcher.db')
migrate(db)
new WatchlistStore(db).add({
  poolAddress: pool as `0x${string}`,
  quoteToken: quote as `0x${string}`,
  label,
  addedAtTs: Date.now(),
})
console.log(`lagt til ${label}`)
