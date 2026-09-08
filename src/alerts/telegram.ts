import { Bot } from 'grammy'
import type { Hex } from '../domain/types.js'
import { formatAlert } from './format.js'
import type { Alert, Notifier } from './types.js'

export type TelegramDeps = {
  send(chatId: string, text: string): Promise<void>
  chatId: string
  labelFor(pool: Hex): string
  onError?(e: unknown): void
}

export class TelegramNotifier implements Notifier {
  constructor(private deps: TelegramDeps) {}

  async send(a: Alert): Promise<void> {
    const pool = 'setup' in a ? a.setup.poolAddress : undefined
    const label = pool ? this.deps.labelFor(pool) : ''
    try {
      await this.deps.send(this.deps.chatId, formatAlert(a, label))
    } catch (e) {
      this.deps.onError?.(e)
    }
  }
}

export function grammySender(token: string): (chatId: string, text: string) => Promise<void> {
  const bot = new Bot(token)
  return async (chatId, text) => {
    await bot.api.sendMessage(chatId, text)
  }
}
