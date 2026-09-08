import { describe, expect, it, vi } from 'vitest'
import { TelegramNotifier } from '../../src/alerts/telegram.js'
import { createSetup } from '../../src/strategy/setups.js'
import type { Swing } from '../../src/domain/types.js'

const POOL = '0x1111111111111111111111111111111111111111' as const
const swing: Swing = { lowTs: 0, low: '100', highTs: 1000, high: '200', confirmedAtTs: 1000, provisional: false }
const FIB = { fibEntry: 0.886, fibZoneTop: 0.786, slBufferPct: 2, alertLevels: [0.5] }
const s = createSetup(POOL, swing, FIB, 1000)

describe('TelegramNotifier', () => {
  it('sender formatert tekst til riktig chat', async () => {
    const send = vi.fn(async () => {})
    const n = new TelegramNotifier({ send, chatId: '42', labelFor: () => 'X/WETH' })
    await n.send({ kind: 'milestone', setup: s, level: 0.5, price: 150 })
    expect(send).toHaveBeenCalledWith('42', expect.stringContaining('X/WETH'))
  })

  it('svelger sendefeil så en nede Telegram ikke stopper boten', async () => {
    const send = vi.fn(async () => { throw new Error('429 Too Many Requests') })
    const n = new TelegramNotifier({ send, chatId: '42', labelFor: () => 'X' })
    await expect(n.send({ kind: 'recovered' })).resolves.toBeUndefined()
  })

  it('slår opp etikett per pool', async () => {
    const send = vi.fn(async () => {})
    const labelFor = vi.fn(() => 'PEPE/WETH')
    const n = new TelegramNotifier({ send, chatId: '1', labelFor })
    await n.send({ kind: 'zone', setup: s, price: 115 })
    expect(labelFor).toHaveBeenCalledWith(POOL)
  })
})
