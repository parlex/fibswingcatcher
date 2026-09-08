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
import { MutableNotifier } from '../alerts/mute.js'
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
 * Tilbakeblikket er uttrykt i tid, ikke i blokker, og regnes om via en målt
 * blokktakt. Robinhood Chain lager en blokk hvert tiendedels sekund, så en
 * hardkodet «3600 blokker per time» ville bommet med en faktor ti — og den
 * ville dessuten vært feil for enhver annen strukturtidsramme enn 1h.
 */
async function blocksPerMs(client: PublicClient, latest: bigint): Promise<number> {
  const span = latest > 100_000n ? 100_000n : latest
  if (span === 0n) return 1 / 1_000
  const [older, newest] = await Promise.all([
    client.getBlock({ blockNumber: latest - span }),
    client.getBlock({ blockNumber: latest }),
  ])
  const elapsedMs = (Number(newest.timestamp) - Number(older.timestamp)) * 1_000
  if (elapsedMs <= 0) return 1 / 1_000
  return Number(span) / elapsedMs
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
const sink = process.env.TELEGRAM_BOT_TOKEN
  ? new TelegramNotifier({
      send: grammySender(process.env.TELEGRAM_BOT_TOKEN),
      chatId: requireEnv('TELEGRAM_CHAT_ID'),
      labelFor: (p) => labels.get(p.toLowerCase()) ?? p,
      onError: (e) => log.warn({ e }, 'telegram-sending feilet'),
    })
  : new NullNotifier()

if (sink instanceof NullNotifier) {
  log.warn({}, 'TELEGRAM_BOT_TOKEN mangler — varsler går ingen steder')
}

// Dempet gjennom replayen av historikk, sluppet løs når strømmene starter.
// Replayen gjenskaper hele hendelsesforløpet på nytt, og uten dempingen ville
// hver omstart sendt en byge av varsler for kurs som beveget seg for timer
// siden. Nivåene registreres i basen uansett, så ingenting varsles dobbelt
// senere.
const notifier = new MutableNotifier(sink, true)

const reader = viemLogReader(http)

const latest = await http.getBlockNumber()
const perMs = await blocksPerMs(http, latest)
const lookbackBars = Number(process.env.BACKFILL_BARS ?? DEFAULT_CONFIG.strategy.maxSetupAgeBars * 4)
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
  )
  log.info({ pool: entry.label, trades: history.length }, 'backfill ferdig')
  for (const t of history) await observer.onTrade(t)

  wired.push({ entry, meta, observer })
}

// Det ene dempingen koster, er at et oppsett som *alt* står i sonen ved
// oppstart ikke pushes. Derfor logges tilstanden, slik at operatøren ser den.
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

notifier.unmute()

const streams: LiveStream[] = []

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

  stream.on((e) => {
    if (e.kind === 'trade') void observer.onTrade(e.trade)
    else if (e.kind === 'stale') void observer.onStale(e.sinceMs)
    else void observer.onHealthy()
  })
  stream.start()
  streams.push(stream)
  log.info({ pool: entry.label }, 'observerer')
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info({}, 'stopper')
    for (const s of streams) s.stop()
    db.close()
    process.exit(0)
  })
}
