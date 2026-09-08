import 'dotenv/config'
import pino from 'pino'
import { type PublicClient, createPublicClient, webSocket } from 'viem'
import { DEFAULT_CONFIG } from '../config/schema.js'
import { timeframeMs } from '../bars/aggregator.js'
import { robinhoodChain, publicClient } from '../chain/client.js'
import { type PoolMeta, loadPoolMeta } from '../data/pool.js'
import { LiveStream } from '../data/live.js'
import { backfillTrades } from '../data/backfill.js'
import { SWAP_EVENT, toBlockLog, viemLogReader } from '../data/viem.js'
import { migrate, openDb } from '../store/db.js'
import { SetupStore, WatchlistStore, type WatchlistEntry } from '../store/setups.js'
import { NullNotifier } from '../alerts/types.js'
import { TelegramNotifier, grammySender } from '../alerts/telegram.js'
import { Observer } from './observer.js'

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' })

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    log.error({ variabel: name }, 'mangler påkrevd miljøvariabel')
    process.exit(1)
  }
  return value
}

/**
 * Bevisst under den målte takten på ~10 blokker/sekund. Bommer målingen, skal
 * tilbakeblikket bli for *kort* — et for kort tilbakeblikk gir tynn struktur,
 * et for langt gir en kjedeskanning som aldri fullfører.
 */
const FALLBACK_BLOCKS_PER_MS = 1 / 1_000

/**
 * Tak: ingen kjede lager tusen blokker i sekundet. Uten taket kan en
 * degenerert måling — to blokker med samme eller nesten samme tidsstempel —
 * blåse tilbakeblikket forbi kjedehøyden, `fromBlock` faller til 0, og
 * oppstarten blir en full skanning av 57 millioner blokker.
 */
const MAX_BLOCKS_PER_MS = 1

/**
 * Tilbakeblikket er uttrykt i tid, ikke i blokker, og regnes om via en målt
 * blokktakt. Robinhood Chain lager en blokk hvert tiendedels sekund, så en
 * hardkodet «3600 blokker per time» ville bommet med en faktor ti — og den
 * ville dessuten vært feil for enhver annen strukturtidsramme enn 1h.
 */
async function blocksPerMs(client: PublicClient, latest: bigint): Promise<number> {
  const span = latest > 100_000n ? 100_000n : latest
  if (span === 0n) return FALLBACK_BLOCKS_PER_MS
  const [older, newest] = await Promise.all([
    client.getBlock({ blockNumber: latest - span }),
    client.getBlock({ blockNumber: latest }),
  ])
  const elapsedMs = (Number(newest.timestamp) - Number(older.timestamp)) * 1_000
  if (elapsedMs <= 0) {
    log.warn({ span, elapsedMs }, 'kunne ikke måle blokktakt — bruker forsiktig fallback')
    return FALLBACK_BLOCKS_PER_MS
  }
  const measured = Number(span) / elapsedMs
  if (measured > MAX_BLOCKS_PER_MS) {
    log.warn({ measured }, 'urimelig blokktakt målt — klamper ned')
    return MAX_BLOCKS_PER_MS
  }
  return measured
}

const httpUrl = requireEnv('RPC_HTTP_URL')
const wsUrl = requireEnv('RPC_WS_URL')

const http = publicClient(httpUrl)
const ws = createPublicClient({ chain: robinhoodChain, transport: webSocket(wsUrl) })

const db = openDb(process.env.DB_PATH ?? 'data/fibswingcatcher.db')
migrate(db)
const setups = new SetupStore(db)
const watchlist = new WatchlistStore(db)

const entries = watchlist.all()
if (entries.length === 0) {
  log.error({}, 'watchlisten er tom — legg til en pool før oppstart')
  process.exit(1)
}

const labels = new Map(entries.map((e) => [e.poolAddress.toLowerCase(), e.label]))
const notifier = process.env.TELEGRAM_BOT_TOKEN
  ? new TelegramNotifier({
      send: grammySender(process.env.TELEGRAM_BOT_TOKEN),
      chatId: requireEnv('TELEGRAM_CHAT_ID'),
      labelFor: (p) => labels.get(p.toLowerCase()) ?? p,
      onError: (e) => log.warn({ e }, 'telegram-sending feilet'),
    })
  : new NullNotifier()

if (notifier instanceof NullNotifier) {
  log.warn({}, 'TELEGRAM_BOT_TOKEN mangler — varsler går ingen steder')
}

const reader = viemLogReader(http)
const streams: LiveStream[] = []

// Registrert før backfillen, ikke etter. Oppstarten tar over to minutter, og
// en SIGTERM i det vinduet skal fortsatt logge og lukke basen ryddig.
let stopping = false
function stop(code: number): never {
  if (!stopping) {
    stopping = true
    log.info({}, 'stopper')
    for (const s of streams) s.stop()
    db.close()
  }
  process.exit(code)
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => stop(0))
}

process.on('unhandledRejection', (reason) => {
  log.error({ err: reason }, 'ubehandlet promise-avvisning — avslutter')
  stop(1)
})
process.on('uncaughtException', (err) => {
  log.error({ err }, 'ufanget unntak — avslutter')
  stop(1)
})

async function start(): Promise<void> {
  const latest = await http.getBlockNumber()
  const perMs = await blocksPerMs(http, latest)
  const lookbackBars = DEFAULT_CONFIG.data.backfillLookbackBars
  const lookbackMs = lookbackBars * timeframeMs(DEFAULT_CONFIG.strategy.structureTimeframe)
  const lookbackBlocks = BigInt(Math.ceil(lookbackMs * perMs))
  const fromBlock = latest > lookbackBlocks ? latest - lookbackBlocks : 0n
  log.info(
    { latest, fromBlock, bars: lookbackBars, blokkerPerSekund: Math.round(perMs * 1_000) },
    'tilbakeblikk beregnet',
  )

  type Wired = { entry: WatchlistEntry; meta: PoolMeta; observer: Observer }
  const wired: Wired[] = []

  for (const entry of entries) {
    const meta = await loadPoolMeta(http, entry.poolAddress, entry.quoteToken)
    const observer = new Observer({
      pool: meta, label: entry.label, config: DEFAULT_CONFIG, setups, notifier, log,
    })

    // Backfill nok historikk til at swing-deteksjonen har noe å jobbe med
    const history = await backfillTrades(
      reader, meta, fromBlock, latest, DEFAULT_CONFIG.data.backfillBlockRange,
      {
        onRetry: ({ attempt, delayMs, error }) =>
          log.warn({ pool: entry.label, attempt, delayMs, err: error }, 'RPC-kall feilet — prøver igjen'),
      },
    )
    log.info({ pool: entry.label, trades: history.length }, 'backfill ferdig')

    // replay(), ikke onTrade(): historikken skal gi struktur, ikke trigge.
    for (const t of history) await observer.replay(t)

    log.info(
      { pool: entry.label, buffertHandler: observer.bufferedTrades, vinduBars: DEFAULT_CONFIG.data.backfillLookbackBars },
      'replay ferdig',
    )

    wired.push({ entry, meta, observer })
  }

  // Replayen varsler ikke, så dette er det eneste stedet oppstartstilstanden er
  // synlig. Et oppsett som alt står i sonen står her som DETECTED, og trigges av
  // den første levende handelen i sonen.
  for (const setup of setups.allActive()) {
    log.info(
      {
        id: setup.id, state: setup.state,
        sone: [setup.levels.zoneBottom, setup.levels.zoneTop],
        varslet: setup.alertsSent,
      },
      'aktivt oppsett etter replay',
    )
  }

  for (const { entry, meta, observer } of wired) {
    const stream = new LiveStream({
      subscribe: (onLog, onError) =>
        ws.watchEvent({
          address: meta.address,
          event: SWAP_EVENT,
          onLogs: (logs) => {
            for (const raw of logs) {
              const blockLog = toBlockLog(raw)
              if (blockLog) onLog(blockLog)
              else log.warn({ pool: entry.label }, 'hopper over ventende eller ukjent logg')
            }
          },
          // LiveStream sin egen onError kaster argumentet — uten dette loggpunktet
          // står en dagelang kjøring uten spor av hvorfor den koblet til på nytt.
          onError: (e) => {
            log.warn({ pool: entry.label, err: e }, 'strømfeil — planlegger reconnect')
            onError(e)
          },
        }),
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      maxStalenessMs: DEFAULT_CONFIG.data.maxDataStalenessMs,
      meta,
      reorgDepthBlocks: DEFAULT_CONFIG.data.reorgDepthBlocks,
      blockTs: async (bn) => Number((await http.getBlock({ blockNumber: bn })).timestamp) * 1000,
    })

    // Én kjede per observatør. viem leverer flere logger i samme batch, og et
    // bart `void observer.onTrade(...)` ville kjørt dem samtidig — `newAlerts`
    // beregnes før første `await`, så samme milepæl kunne blitt sendt to
    // ganger. `void` gjorde dessuten enhver feil inne i observatøren til en
    // unhandled rejection som feller prosessen uten en eneste pino-linje.
    let queue: Promise<void> = Promise.resolve()
    const serialize = (work: () => Promise<void>) => {
      queue = queue.then(work).catch((err) => {
        log.error({ pool: entry.label, err }, 'observatøren feilet på en hendelse')
      })
    }

    stream.on((e) => {
      if (e.kind === 'trade') serialize(() => observer.onTrade(e.trade))
      else if (e.kind === 'stale') serialize(() => observer.onStale(e.sinceMs))
      else serialize(() => observer.onHealthy())
    })
    stream.start()
    streams.push(stream)
    log.info({ pool: entry.label }, 'observerer')
  }
}

try {
  await start()
} catch (err) {
  // Uten dette dør oppstarten med et rått stakksport på stderr og ingen
  // pino-linje — og basen blir stående åpen.
  log.error({ err }, 'oppstart feilet')
  stop(1)
}
