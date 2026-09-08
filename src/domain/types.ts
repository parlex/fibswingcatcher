export type Hex = `0x${string}`

export type Trade = {
  ts: number
  txHash: Hex
  logIndex: number
  priceQuote: string
  sizeQuote: bigint
  sizeBase: bigint
  side: 'buy' | 'sell'
  /**
   * Poolens aktive likviditet etter handelen, rett fra Swap-eventen.
   *
   * Det billigste signalet vi har på «er denne poolen tynn akkurat nå», og
   * dermed på hvor lett prisen kan flyttes. Ingenting konsumerer den i plan 1;
   * den bæres videre fordi eventen alt inneholder den og fordi
   * risikomotoren i plan 3 ikke kan vurdere en inngang uten den.
   */
  liquidity: bigint
}

export type Bar = {
  openTs: number
  open: string
  high: string
  low: string
  close: string
  volumeQuote: bigint
  tradeCount: number
}

export type Swing = {
  lowTs: number
  low: string
  highTs: number
  high: string
  confirmedAtTs: number
  provisional: boolean
}

export type SetupState =
  | 'DETECTED' | 'ARMED' | 'TRIGGERED' | 'OPEN'
  | 'CLOSED' | 'INVALIDATED' | 'EXPIRED' | 'REJECTED'
