import type { Trade } from '../domain/types.js'
import { type RawLog, decodeSwapLog } from './decode.js'
import type { PoolMeta } from './pool.js'

export type StreamEvent =
  | { kind: 'trade'; trade: Trade }
  | { kind: 'stale'; sinceMs: number }
  | { kind: 'healthy' }

type BlockLog = RawLog & { blockNumber: bigint }

export type LiveDeps = {
  subscribe(onLog: (l: BlockLog) => void, onError: (e: Error) => void): () => void
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(t: unknown): void
  maxStalenessMs: number
  meta: PoolMeta
  reorgDepthBlocks: number
  blockTs(bn: bigint): Promise<number>
  /**
   * Kalles når en logg ikke kunne behandles.
   *
   * Påkrevd, ikke valgfri. `handleLog` awaiter `blockTs`, og et enkelt 429 fra
   * RPC-en pleide å bli en unhandled rejection som felte hele prosessen — i en
   * daemon som skal stå i dagevis mot et endepunkt vi selv har dokumentert som
   * hardt rate-limitet. Loggen slippes, strømmen lever videre, og kalleren får
   * vite hvorfor.
   */
  onLogError(e: unknown, log: BlockLog): void
}

const RECONNECT_MS = 1_000
const MAX_RECONNECT_MS = 30_000

export class LiveStream {
  private listeners: ((e: StreamEvent) => void)[] = []
  private unsubscribe: (() => void) | undefined = undefined
  private staleTimer?: unknown
  private reconnectTimer?: unknown
  private running = false
  private stale = false
  private lastEventAt = 0
  private backoff = RECONNECT_MS
  private seen = new Map<string, bigint>()
  /**
   * Blokk-tidsstempler, cachet innenfor reorg-vinduet.
   *
   * Flere swaps i samme blokk er normalen, ikke unntaket, og hver av dem kostet
   * tidligere sitt eget `eth_getBlock`. Backfillen har alltid cachet dette; den
   * levende veien gjorde det ikke.
   */
  private blockTimes = new Map<bigint, Promise<number>>()
  private generation = 0

  constructor(private deps: LiveDeps) {}

  on(fn: (e: StreamEvent) => void): void {
    this.listeners.push(fn)
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.stale = false
    this.lastEventAt = this.deps.now()
    this.connect()
    this.armStaleTimer()
  }

  stop(): void {
    this.running = false
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.blockTimes.clear()
    if (this.staleTimer !== undefined) this.deps.clearTimer(this.staleTimer)
    this.staleTimer = undefined
    if (this.reconnectTimer !== undefined) this.deps.clearTimer(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.seen.clear()
  }

  private emit(e: StreamEvent): void {
    for (const fn of this.listeners) fn(e)
  }

  private connect(): void {
    if (!this.running) return
    const gen = ++this.generation
    this.unsubscribe = this.deps.subscribe(
      (log) => {
        if (gen !== this.generation) return // spøkelse fra en forlatt sokkel
        void this.handleLog(log).catch((e) => {
          // Uten denne blir et hikk i `blockTs` en unhandled rejection som
          // feller prosessen. Loggen mistes; strømmen står.
          this.seen.delete(`${log.transactionHash}-${log.logIndex}`)
          this.deps.onLogError(e, log)
        })
      },
      () => {
        if (gen !== this.generation) return // spøkelse fra en forlatt sokkel
        this.unsubscribe?.()
        this.unsubscribe = undefined
        if (!this.running) return
        if (this.reconnectTimer !== undefined) return // reconnect allerede planlagt — ignorer duplikatfeilen
        this.reconnectTimer = this.deps.setTimer(() => {
          this.reconnectTimer = undefined
          this.connect()
        }, this.backoff)
        this.backoff = Math.min(this.backoff * 2, MAX_RECONNECT_MS)
      },
    )
  }

  private armStaleTimer(): void {
    if (!this.running) return
    this.staleTimer = this.deps.setTimer(() => {
      const since = this.deps.now() - this.lastEventAt
      if (since >= this.deps.maxStalenessMs && !this.stale) {
        this.stale = true
        this.emit({ kind: 'stale', sinceMs: since })
      }
      this.armStaleTimer()
    }, this.deps.maxStalenessMs)
  }

  /** Fjerner dedupe-nøkler eldre enn reorg-vinduet, slik at `seen` ikke vokser ubegrenset. */
  private evictOldSeen(latestBlock: bigint): void {
    const cutoff = latestBlock - BigInt(this.deps.reorgDepthBlocks)
    for (const [key, blockNumber] of this.seen) {
      if (blockNumber < cutoff) this.seen.delete(key)
    }
    for (const blockNumber of this.blockTimes.keys()) {
      if (blockNumber < cutoff) this.blockTimes.delete(blockNumber)
    }
  }

  /**
   * Tidsstempelet for en blokk, hentet én gang per blokk i reorg-vinduet.
   *
   * Cacher *promisen*, ikke verdien. viem leverer flere logger fra samme
   * blokk i samme batch, og de starter derfor samtidig — en verdicache ville
   * hver av dem bommet før den første rakk å fylle den, og vi hadde betalt
   * ett `eth_getBlock` per swap likevel.
   */
  private blockTsCached(bn: bigint): Promise<number> {
    const hit = this.blockTimes.get(bn)
    if (hit !== undefined) return hit

    const pending = this.deps.blockTs(bn)
    this.blockTimes.set(bn, pending)
    // En feilet henting skal ikke ligge igjen som et permanent svar.
    void pending.catch(() => this.blockTimes.delete(bn))
    return pending
  }

  private async handleLog(log: BlockLog): Promise<void> {
    if (!this.running) return // sent levert etter stop() — ignorer

    const key = `${log.transactionHash}-${log.logIndex}`
    if (this.seen.has(key)) return
    this.seen.set(key, log.blockNumber)
    this.evictOldSeen(log.blockNumber)

    this.lastEventAt = this.deps.now()
    this.backoff = RECONNECT_MS
    if (this.stale) { this.stale = false; this.emit({ kind: 'healthy' }) }

    const ts = await this.blockTsCached(log.blockNumber)
    if (!this.running) return // stoppet mens blockTs var i flukt — ikke send en handel etter avslutning

    this.emit({ kind: 'trade', trade: decodeSwapLog(log, this.deps.meta, ts) })
  }
}
