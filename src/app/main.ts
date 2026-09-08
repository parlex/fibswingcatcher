import 'dotenv/config'
import pino from 'pino'
import { createPublicClient, webSocket } from 'viem'
import { ConfigSchema, DEFAULT_CONFIG } from '../config/schema.js'
import { timeframeMs } from '../bars/aggregator.js'
import { robinhoodChain, publicClient } from '../chain/client.js'
import { type PoolMeta, loadPoolMeta } from '../data/pool.js'
import { LiveStream } from '../data/live.js'
import { backfillTrades } from '../data/backfill.js'
import { SWAP_EVENT, isResultLimitError, toBlockLog, viemLogReader } from '../data/viem.js'
import { lookbackFrom, measureBlocksPerMs } from '../data/lookback.js'
import { readSpotPrice } from '../data/spot.js'
import { withRetry } from '../data/retry.js'
import { migrate, openDb } from '../store/db.js'
import { SetupStore, WatchlistStore, type WatchlistEntry } from '../store/setups.js'
import { NullNotifier } from '../alerts/types.js'
import { TelegramNotifier, grammySender } from '../alerts/telegram.js'
import { Observer } from './observer.js'

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' })

/**
 * Konfigurasjonen går gjennom skjemaet, den blir ikke bare antatt å passe.
 *
 * `main.ts` sendte tidligere `DEFAULT_CONFIG`-literalen rett videre, så
 * `min(4)`-gulvet, `fibZoneTop < fibEntry`-refinementet og `.strict()` var død
 * kode i drift — validering som bare kjørte i sin egen test.
 */
const config = ConfigSchema.parse(DEFAULT_CONFIG)

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    log.error({ variabel: name }, 'mangler påkrevd miljøvariabel')
    process.exit(1)
  }
  return value
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
  const lookbackBars = config.data.backfillLookbackBars
  const lookbackMs = lookbackBars * timeframeMs(config.strategy.structureTimeframe)
  const lookback = lookbackFrom(latest, await measureBlocksPerMs(http, latest), lookbackMs)
  const { fromBlock } = lookback

  if (lookback.rateSource !== 'measured') {
    // Fallbacken gir 86 400 blokker, altså ~2 bars på denne kjeden — under
    // skjemaets eget gulv på 4, som er der deteksjonen blir «lydløst død».
    // Med kantregelen alltid på produserer et så tynt vindu ingen oppsett i
    // det hele tatt. En bot som starter og tier er verre enn en som nekter.
    log.error(
      {
        maalt: lookback.measuredBlocksPerMs,
        villeBrukt: lookback.lookbackBlocks,
        gulvBars: config.data.backfillLookbackBars,
        latest,
        guarded: lookback.guarded,
      },
      'kunne ikke måle blokktakten pålitelig — nekter å starte med et tilbakeblikk under gulvet',
    )
    stop(1)
  }

  log.info(
    {
      latest, fromBlock,
      lookbackBlocks: lookback.lookbackBlocks,
      bars: lookbackBars,
      blokkerPerSekund: Math.round(lookback.blocksPerMs * 1_000),
      kilde: lookback.rateSource,
    },
    'tilbakeblikk beregnet',
  )

  type Wired = { entry: WatchlistEntry; meta: PoolMeta; observer: Observer }
  const wired: Wired[] = []

  for (const entry of entries) {
    const meta = await loadPoolMeta(http, entry.poolAddress, entry.quoteToken)
    const observer = new Observer({
      pool: meta, label: entry.label, config, setups, notifier, log,
      // Spec 6.7 mottiltak 2. Ett kall, bare ved tilstandsendringer.
      spotPrice: () => withRetry(() => readSpotPrice(http, meta), {
        onRetry: ({ attempt, delayMs }) =>
          log.warn({ pool: entry.label, attempt, delayMs }, 'slot0-oppslag feilet — prøver igjen'),
      }),
    })

    // Backfill nok historikk til at swing-deteksjonen har noe å jobbe med
    const history = await backfillTrades(
      reader, meta, fromBlock, latest, config.data.backfillBlockRange,
      {
        onRetry: ({ attempt, delayMs, error }) =>
          log.warn({ pool: entry.label, attempt, delayMs, err: error }, 'RPC-kall feilet — prøver igjen'),
        shouldSplit: isResultLimitError,
        onSplit: ({ from, to }) =>
          log.info({ pool: entry.label, from, to }, 'for mange treff — deler blokkvinduet'),
      },
    )
    log.info({ pool: entry.label, trades: history.length }, 'backfill ferdig')

    // replay(), ikke onTrade(): historikken skal gi struktur, ikke trigge.
    for (const t of history) await observer.replay(t)

    log.info(
      { pool: entry.label, buffertHandler: observer.bufferedTrades, vinduBars: config.data.backfillLookbackBars },
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
      maxStalenessMs: config.data.maxDataStalenessMs,
      meta,
      reorgDepthBlocks: config.data.reorgDepthBlocks,
      // Retry her, cache inne i LiveStream. Ett 429 fra dette kallet felte
      // tidligere hele prosessen gjennom `unhandledRejection`.
      blockTs: async (bn) => {
        const block = await withRetry(() => http.getBlock({ blockNumber: bn }), {
          onRetry: ({ attempt, delayMs }) =>
            log.warn({ pool: entry.label, bn, attempt, delayMs }, 'blokkoppslag feilet — prøver igjen'),
        })
        return Number(block.timestamp) * 1000
      },
      onLogError: (err, raw) =>
        log.error(
          { pool: entry.label, tx: raw.transactionHash, logIndex: raw.logIndex, err },
          'kunne ikke behandle en swap-logg — hoppet over, strømmen står',
        ),
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
