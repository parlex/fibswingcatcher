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
  private seen = new Set<string>()

  constructor(private deps: LiveDeps) {}

  on(fn: (e: StreamEvent) => void): void {
    this.listeners.push(fn)
  }

  start(): void {
    this.running = true
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
  }

  private emit(e: StreamEvent): void {
    for (const fn of this.listeners) fn(e)
  }

  private connect(): void {
    if (!this.running) return
    this.unsubscribe = this.deps.subscribe(
      (log) => { void this.handleLog(log) },
      () => {
        this.unsubscribe?.()
        this.unsubscribe = undefined
        if (!this.running) return
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

  private async handleLog(log: BlockLog): Promise<void> {
    const key = `${log.transactionHash}-${log.logIndex}`
    if (this.seen.has(key)) return
    this.seen.add(key)

    this.lastEventAt = this.deps.now()
    this.backoff = RECONNECT_MS
    if (this.stale) { this.stale = false; this.emit({ kind: 'healthy' }) }

    const ts = await this.deps.blockTs(log.blockNumber)
    this.emit({ kind: 'trade', trade: decodeSwapLog(log, this.deps.meta, ts) })
  }
}
