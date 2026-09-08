export type Hex = `0x${string}`

export type Trade = {
  ts: number
  txHash: Hex
  logIndex: number
  priceQuote: string
  sizeQuote: bigint
  sizeBase: bigint
  side: 'buy' | 'sell'
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
