import type { Setup } from '../strategy/setups.js'

export type Alert =
  | { kind: 'milestone'; setup: Setup; level: number; price: number }
  | { kind: 'zone'; setup: Setup; price: number }
  | { kind: 'invalidated'; setup: Setup; reason: string }
  | { kind: 'expired'; setup: Setup; reason: string }
  | { kind: 'degraded'; sinceMs: number }
  | { kind: 'recovered' }

export interface Notifier {
  send(a: Alert): Promise<void>
}

export class NullNotifier implements Notifier {
  public readonly sent: Alert[] = []
  async send(a: Alert): Promise<void> {
    this.sent.push(a)
  }
}
