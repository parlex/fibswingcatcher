import { describe, expect, it } from 'vitest'
import { SWAP_EVENT, SWAP_TOPIC0, isResultLimitError, toBlockLog, viemLogReader } from '../../src/data/viem.js'
import type { SwapLogClient } from '../../src/data/viem.js'
import type { Hex } from '../../src/domain/types.js'

const mined = {
  data: '0xdead' as Hex,
  topics: [SWAP_TOPIC0] as readonly Hex[],
  transactionHash: '0xaa' as Hex,
  logIndex: 3,
  blockNumber: 100n,
}

describe('toBlockLog', () => {
  it('slipper gjennom en minet Swap-logg', () => {
    expect(toBlockLog(mined)).toEqual({
      data: '0xdead', topics: [SWAP_TOPIC0], transactionHash: '0xaa', logIndex: 3, blockNumber: 100n,
    })
  })

  it('forkaster en ventende logg uten blokknummer', () => {
    expect(toBlockLog({ ...mined, blockNumber: null })).toBeUndefined()
  })

  it('forkaster en logg uten transaksjonshash eller logIndex', () => {
    expect(toBlockLog({ ...mined, transactionHash: null })).toBeUndefined()
    expect(toBlockLog({ ...mined, logIndex: null })).toBeUndefined()
  })

  it('forkaster logger som ikke er Swap — poolen sender også Mint og Collect', () => {
    expect(toBlockLog({ ...mined, topics: ['0xbeef' as Hex] })).toBeUndefined()
    expect(toBlockLog({ ...mined, topics: [] })).toBeUndefined()
  })
})

describe('viemLogReader', () => {
  it('ber RPC-en om bare Swap-logger og gir videre kun brukbare', async () => {
    const calls: unknown[] = []
    const client: SwapLogClient = {
      async getLogs(args) {
        calls.push(args)
        return [mined, { ...mined, blockNumber: null }]
      },
      async getBlock() {
        return { timestamp: 1_700_000_000n }
      },
    }

    const reader = viemLogReader(client)
    const logs = await reader.getLogs({ address: '0xpool', fromBlock: 1n, toBlock: 10n })

    expect(logs).toHaveLength(1)
    expect(logs[0]!.blockNumber).toBe(100n)
    expect(calls[0]).toMatchObject({ address: '0xpool', fromBlock: 1n, toBlock: 10n, event: SWAP_EVENT })
    expect(await reader.getBlock({ blockNumber: 100n })).toEqual({ timestamp: 1_700_000_000n })
  })
})

describe('isResultLimitError', () => {
  /**
   * Meldingen ordrett slik viem formaterer den fra Robinhood Chain. Fanget i
   * en ekte kjøring — backfill-testene brukte tidligere en håndkopiert regel,
   * så de verifiserte en kopi og lot originalen være fri til å ta feil.
   */
  const observed = new Error(
    [
      'RPC Request failed.',
      '',
      'URL: https://rpc.mainnet.chain.robinhood.com',
      'Request body: {"method":"eth_getLogs","params":[{"address":"0x52e6…"}]}',
      '',
      'Details: logs matched by query exceeds limit of 10000',
      'Version: viem@2.56.3',
    ].join('\n'),
  )

  it('kjenner igjen kjedens egen treffgrense-melding', () => {
    expect(isResultLimitError(observed)).toBe(true)
  })

  it('kjenner igjen formuleringene andre noder bruker', () => {
    expect(isResultLimitError(new Error('query returned more than 10000 results'))).toBe(true)
    expect(isResultLimitError(new Error('too many results'))).toBe(true)
    expect(isResultLimitError(new Error('EXCEEDS LIMIT of 500'))).toBe(true)
  })

  it('lar forbigående feil være i fred, slik at de prøves på nytt', () => {
    expect(isResultLimitError(new Error('Too Many Requests'))).toBe(false)
    expect(isResultLimitError(new Error('socket hang up'))).toBe(false)
    expect(isResultLimitError(new Error('block range too large'))).toBe(false)
  })

  it('tåler noe som ikke er en Error', () => {
    expect(isResultLimitError('exceeds limit of 10000')).toBe(true)
    expect(isResultLimitError(undefined)).toBe(false)
    expect(isResultLimitError(null)).toBe(false)
  })
})
