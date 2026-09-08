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
        void this.handleLog(log)
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

    const ts = await this.deps.blockTs(log.blockNumber)
    if (!this.running) return // stoppet mens blockTs var i flukt — ikke send en handel etter avslutning

    this.emit({ kind: 'trade', trade: decodeSwapLog(log, this.deps.meta, ts) })
  }
}
