import { describe, expect, it } from 'vitest'
import { MutableNotifier } from '../../src/alerts/mute.js'
import { NullNotifier } from '../../src/alerts/types.js'

const degraded = { kind: 'degraded', sinceMs: 1 } as const

describe('MutableNotifier', () => {
  it('slipper gjennom når den ikke er dempet', async () => {
    const inner = new NullNotifier()
    await new MutableNotifier(inner).send(degraded)
    expect(inner.sent).toEqual([degraded])
  })

  it('svelger varsler når den er dempet', async () => {
    const inner = new NullNotifier()
    await new MutableNotifier(inner, true).send(degraded)
    expect(inner.sent).toEqual([])
  })

  it('kan dempes og slippes løs igjen', async () => {
    const inner = new NullNotifier()
    const n = new MutableNotifier(inner)
    n.mute()
    await n.send(degraded)
    expect(inner.sent).toEqual([])
    n.unmute()
    await n.send(degraded)
    expect(inner.sent).toEqual([degraded])
  })
})
