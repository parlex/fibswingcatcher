import type { PublicClient } from 'viem'
import { priceFromSqrtX96 } from './decode.js'
import type { PoolMeta } from './pool.js'

const SLOT0_ABI = [
  {
    name: 'slot0', type: 'function', stateMutability: 'view', inputs: [],
    outputs: [
      { type: 'uint160' }, { type: 'int24' }, { type: 'uint16' }, { type: 'uint16' },
      { type: 'uint16' }, { type: 'uint8' }, { type: 'bool' },
    ],
  },
] as const

/**
 * Poolens nåværende pris, lest direkte fra `slot0`.
 *
 * Dette er spec 6.7 mottiltak 2, og det er en *uavhengig* observasjon: den
 * kommer fra kjedens tilstand nå, ikke fra eventen som ba oss se.
 *
 * Hvorfor det trengs, i motsetning til hva planen påsto: `sqrtPriceX96` i et
 * V3 Swap-event er poolens pris *etter* swappen, og prispåvirkning i V3 er
 * omvendt proporsjonal med aktiv likviditet — som er selve definisjonen av en
 * tynn pool. En liten swap der flytter prisen langt, og eventen rapporterer
 * den manipulerte verdien helt korrekt. Å lese `sqrtPriceX96` framfor
 * `amount1/amount0` fjerner en *annen* skjevhet (gebyrer og delvise fills),
 * men den lyver like villig om nivået.
 *
 * En sandwich reverserer prisen i samme blokk, så et oppslag etterpå ser den
 * ekte prisen — og det er forskjellen vi kan måle.
 */
export async function readSpotPrice(client: PublicClient, meta: PoolMeta): Promise<string> {
  const slot0 = await client.readContract({
    address: meta.address, abi: SLOT0_ABI, functionName: 'slot0',
  })
  return priceFromSqrtX96(slot0[0], meta)
}
