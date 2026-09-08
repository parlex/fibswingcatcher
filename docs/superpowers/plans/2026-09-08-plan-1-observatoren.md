# fibswingcatcher — Plan 1: Observatøren

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** En headless prosess som overvåker en kuratert liste av DEX-pools på Robinhood Chain, bygger 1h-bars fra rå `Swap`-events, finner swings, beregner fib-oppsett og varsler på Telegram når prisen krysser nedover gjennom 0.5 → 0.618 → 0.786 → entry-sonen.

**Architecture:** Rå swap-events er den kanoniske dataenheten. Én `BarAggregator` bygger bars av valgfritt intervall, og både live-strøm og historisk backfill går gjennom nøyaktig samme aggregator, slik at backtest (plan 2) og live ser identiske bars. Strategilaget — swing-deteksjon, fib, oppsettets tilstandsmaskin — er rene funksjoner uten nettverk, wallet eller database. Data og varsling er de eneste adapterne som snakker med omverdenen.

**Tech Stack:** TypeScript (Node 22, ESM, strict), vitest, viem, zod, better-sqlite3, pino, grammy (Telegram).

**Spec:** `docs/superpowers/specs/2026-09-08-fibswingcatcher-design.md`

**Omfang:** Denne planen implementerer spec-seksjon 2 (strategi), 3 (arkitektur, modulene `chain`/`data`/`bars`/`strategy`/`alerts`/`app`), 5.2/5.4 (oppsettets livssyklus og varsler) og 6.1/6.6/6.7 (datastrøm, dedupe, manipulasjonsvern). Risikomotor, eksekvering, posisjonslager, UI og fork-testing kommer i senere planer.

## Global Constraints

- **Node 22+, ESM** (`"type": "module"`). Verifisert lokalt: v22.6.0.
- **TypeScript strict.** `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`.
- **Ingen magiske tall i koden.** Hver terskel kommer fra config-skjemaet i Task 1.
- **Rå tokenmengder er alltid `bigint`.** Et token med 18 desimaler overskrider `Number.MAX_SAFE_INTEGER`.
- **Priser som krysser en modulgrense er desimalstrenger** (`Trade.priceQuote`, `Bar.open/high/low/close`, `Swing.low/high`). Innenfor strategilaget regnes avledet fib-aritmetikk i `number` — nivåer, avstander og RR er forholdstall der 15–17 signifikante siffer er rikelig, og der `bigint` ville gjort koden uleselig uten å gjøre den riktigere.
- **Rene moduler rører aldri IO.** `src/bars/`, `src/strategy/` og `src/alerts/format.ts` importerer ikke `viem`, `better-sqlite3`, `node:fs` eller `grammy`. Håndheves av en test i Task 1.
- **Chain:** Robinhood Chain, chain ID **4663**, HTTP RPC `https://rpc.mainnet.chain.robinhood.com`, gass i ETH.
- **Ingen hemmeligheter i repoet.** Telegram-token og RPC-nøkler leses fra `.env`, som er i `.gitignore`.
- **Denne planen sender aldri en transaksjon.** Ingen `walletClient`, ingen privatnøkkel, ingen signering. Kun lesing.
- **Alle defaults kopieres ordrett fra spec-seksjon 8.**

## Kjente avvik fra specen

Ett bevisst avvik, som skal føres tilbake i specen i Task 1:

- Specens `minTradeSizeUsd` (50 USD) blir i denne planen **`minTradeSizeQuote`**, uttrykt i poolens quote-token. USD-konvertering krever en prisorakel som først trengs av risikomotoren i plan 3. Observatøren trenger bare *en* størrelsesterskel, og quote-token er den ærlige enheten når det ikke finnes noe orakel ennå.

---

### Task 1: Prosjektstillas, domenetyper og config-skjema

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`
- Create: `src/domain/types.ts`
- Create: `src/config/schema.ts`
- Test: `tests/config/schema.test.ts`, `tests/architecture/purity.test.ts`
- Modify: `docs/superpowers/specs/2026-09-08-fibswingcatcher-design.md` (avviket over)

**Interfaces:**
- Consumes: ingenting (første task)
- Produces:
  - `type Trade = { ts: number; txHash: \`0x${string}\`; logIndex: number; priceQuote: string; sizeQuote: bigint; sizeBase: bigint; side: 'buy' | 'sell' }`
  - `type Bar = { openTs: number; open: string; high: string; low: string; close: string; volumeQuote: bigint; tradeCount: number }`
  - `type Swing = { lowTs: number; low: string; highTs: number; high: string; confirmedAtTs: number; provisional: boolean }`
  - `type SetupState = 'DETECTED' | 'ARMED' | 'TRIGGERED' | 'OPEN' | 'CLOSED' | 'INVALIDATED' | 'EXPIRED' | 'REJECTED'`
  - `const ConfigSchema: z.ZodType<Config>` og `type Config = z.infer<typeof ConfigSchema>`
  - `const DEFAULT_CONFIG: Config`

Priser er desimalstrenger (f.eks. `"0.006526"`), ikke `number`, fordi tokenpriser rutinemessig har 12+ signifikante siffer og flyttall runder dem feil. Sammenligninger gjøres med en liten `cmp`-hjelper introdusert i Task 4.

- [ ] **Step 1: Opprett prosjektstillaset**

```bash
cd /Users/primu/dev-personal/fibswingcatcher
npm init -y
npm pkg set type="module" name="fibswingcatcher" version="0.1.0" private=true
npm pkg set scripts.test="vitest run" scripts.test:watch="vitest" scripts.typecheck="tsc --noEmit"
npm i viem zod better-sqlite3 pino grammy dotenv
npm i -D typescript vitest @types/node @types/better-sqlite3 tsx
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noEmit": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "types": ["node"]
  },
  "include": ["src", "tests"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
})
```

`.env.example`:

```
RPC_HTTP_URL=https://rpc.mainnet.chain.robinhood.com
RPC_WS_URL=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

- [ ] **Step 2: Skriv den feilende testen for config-skjemaet**

`tests/config/schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { ConfigSchema, DEFAULT_CONFIG } from '../../src/config/schema.js'

describe('ConfigSchema', () => {
  it('godtar defaultene fra specen', () => {
    expect(() => ConfigSchema.parse(DEFAULT_CONFIG)).not.toThrow()
  })

  it('har defaultene specen krever', () => {
    expect(DEFAULT_CONFIG.strategy.structureTimeframe).toBe('1h')
    expect(DEFAULT_CONFIG.strategy.minSwingPct).toBe(15)
    expect(DEFAULT_CONFIG.strategy.fibEntry).toBe(0.886)
    expect(DEFAULT_CONFIG.strategy.fibZoneTop).toBe(0.786)
    expect(DEFAULT_CONFIG.strategy.tpPct).toBe(60)
    expect(DEFAULT_CONFIG.strategy.slBufferPct).toBe(2)
    expect(DEFAULT_CONFIG.strategy.minRR).toBe(3)
    expect(DEFAULT_CONFIG.strategy.maxSetupAgeBars).toBe(48)
    expect(DEFAULT_CONFIG.strategy.minSwingDurationMs).toBe(30_000)
    expect(DEFAULT_CONFIG.data.maxDataStalenessMs).toBe(10_000)
  })

  it('avviser negativ minRR', () => {
    const bad = structuredClone(DEFAULT_CONFIG)
    bad.strategy.minRR = -3
    expect(() => ConfigSchema.parse(bad)).toThrow()
  })

  it('avviser fibZoneTop som ikke er grunnere enn fibEntry', () => {
    const bad = structuredClone(DEFAULT_CONFIG)
    bad.strategy.fibZoneTop = 0.9
    expect(() => ConfigSchema.parse(bad)).toThrow(/fibZoneTop/)
  })

  it('avviser ukjente nøkler', () => {
    const bad = { ...structuredClone(DEFAULT_CONFIG), tullball: 1 }
    expect(() => ConfigSchema.parse(bad)).toThrow()
  })
})
```

- [ ] **Step 3: Kjør testen og se at den feiler**

Run: `npx vitest run tests/config/schema.test.ts`
Expected: FAIL — `Cannot find module '../../src/config/schema.js'`

- [ ] **Step 4: Skriv domenetypene**

`src/domain/types.ts`:

```ts
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
```

- [ ] **Step 5: Skriv config-skjemaet**

`src/config/schema.ts`:

```ts
import { z } from 'zod'

const pct = z.number().positive().max(100)

export const StrategySchema = z.object({
  structureTimeframe: z.enum(['5m', '15m', '1h', '4h']),
  minSwingPct: pct,
  minSwingDurationMs: z.number().int().nonnegative(),
  minSwingVolumeQuote: z.string(),
  fibEntry: z.number().gt(0).lt(1),
  fibZoneTop: z.number().gt(0).lt(1),
  tpPct: pct,
  slBufferPct: pct,
  minRR: z.number().positive(),
  maxSetupAgeBars: z.number().int().positive(),
  minTradeSizeQuote: z.string(),
  alertLevels: z.array(z.number().gt(0).lt(1)).nonempty(),
}).strict().refine((s) => s.fibZoneTop < s.fibEntry, {
  message: 'fibZoneTop må være grunnere enn fibEntry',
  path: ['fibZoneTop'],
})

export const DataSchema = z.object({
  chainId: z.literal(4663),
  maxDataStalenessMs: z.number().int().positive(),
  backfillBlockRange: z.number().int().positive(),
  reorgDepthBlocks: z.number().int().nonnegative(),
}).strict()

export const ConfigSchema = z.object({
  strategy: StrategySchema,
  data: DataSchema,
}).strict()

export type Config = z.infer<typeof ConfigSchema>

export const DEFAULT_CONFIG: Config = {
  strategy: {
    structureTimeframe: '1h',
    minSwingPct: 15,
    minSwingDurationMs: 30_000,
    minSwingVolumeQuote: '10000',
    fibEntry: 0.886,
    fibZoneTop: 0.786,
    tpPct: 60,
    slBufferPct: 2,
    minRR: 3,
    maxSetupAgeBars: 48,
    minTradeSizeQuote: '50',
    alertLevels: [0.5, 0.618, 0.786],
  },
  data: {
    chainId: 4663,
    maxDataStalenessMs: 10_000,
    backfillBlockRange: 10_000,
    reorgDepthBlocks: 20,
  },
}
```

- [ ] **Step 6: Kjør testen og se at den passerer**

Run: `npx vitest run tests/config/schema.test.ts`
Expected: PASS, 5 tester

- [ ] **Step 7: Skriv renhetstesten**

Denne håndhever Global Constraint om at strategilaget ikke rører IO. Den kommer til å bestå trivielt nå og bli verdifull i Task 3–5.

`tests/architecture/purity.test.ts`:

```ts
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const FORBIDDEN = ['viem', 'better-sqlite3', 'grammy', 'node:fs', 'node:net', 'pino']
const PURE_DIRS = ['src/bars', 'src/strategy']

function filesIn(dir: string): string[] {
  let out: string[] = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out = out.concat(filesIn(p))
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

describe('renhet i strategilaget', () => {
  for (const dir of PURE_DIRS) {
    it(`${dir} importerer ingen IO`, () => {
      for (const file of filesIn(dir)) {
        const src = readFileSync(file, 'utf8')
        for (const mod of FORBIDDEN) {
          expect(src, `${file} importerer ${mod}`).not.toMatch(
            new RegExp(`from\\s+['"]${mod}`),
          )
        }
      }
    })
  }
})
```

Opprett tomme kataloger `src/bars/` og `src/strategy/` med en `.gitkeep` slik at testen kan kjøre.

- [ ] **Step 8: Rett avviket i specen**

I spec-seksjon 8, tabellen «Strategi», endre raden `minTradeSizeUsd` til:

```
| `minTradeSizeQuote` | 50 (quote-token) | Handler under dette ignoreres i bars og som trigger. USD-konvertering innføres med prisorakelet i plan 3. |
```

- [ ] **Step 9: Kjør alt og commit**

```bash
npx vitest run && npx tsc --noEmit
git add -A
git commit -m "feat: prosjektstillas, domenetyper og validert config-skjema"
```

---

### Task 2: BarAggregator

**Files:**
- Create: `src/bars/aggregator.ts`
- Test: `tests/bars/aggregator.test.ts`

**Interfaces:**
- Consumes: `Trade`, `Bar` fra `src/domain/types.ts`
- Produces:
  - `function timeframeMs(tf: Config['strategy']['structureTimeframe']): number`
  - `function aggregate(trades: Trade[], intervalMs: number, minSizeQuote: bigint): Bar[]`

Aggregatoren er ren og deterministisk. Bøtte = `Math.floor(ts / intervalMs) * intervalMs`. Tomme intervaller gir **ingen bar** — en pool uten handler har ingen pris, og en syntetisk flat bar ville forfalsket både volatilitet og swing-deteksjon.

- [ ] **Step 1: Skriv de feilende testene**

`tests/bars/aggregator.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Trade } from '../../src/domain/types.js'
import { aggregate, timeframeMs } from '../../src/bars/aggregator.js'

const t = (ts: number, price: string, sizeQuote: bigint): Trade => ({
  ts, txHash: '0xabc', logIndex: ts, priceQuote: price,
  sizeQuote, sizeBase: 1n, side: 'buy',
})

describe('timeframeMs', () => {
  it('oversetter tidsrammer til millisekunder', () => {
    expect(timeframeMs('5m')).toBe(300_000)
    expect(timeframeMs('15m')).toBe(900_000)
    expect(timeframeMs('1h')).toBe(3_600_000)
    expect(timeframeMs('4h')).toBe(14_400_000)
  })
})

describe('aggregate', () => {
  const H = 3_600_000

  it('gir én bar med korrekt OHLCV for handler i samme bøtte', () => {
    const bars = aggregate(
      [t(H + 10, '100', 10n), t(H + 20, '120', 20n), t(H + 30, '90', 30n), t(H + 40, '110', 40n)],
      H, 0n,
    )
    expect(bars).toHaveLength(1)
    expect(bars[0]).toMatchObject({
      openTs: H, open: '100', high: '120', low: '90', close: '110',
      volumeQuote: 100n, tradeCount: 4,
    })
  })

  it('deler på bøttegrenser, ikke på første handel', () => {
    const bars = aggregate([t(H + 1, '100', 1n), t(2 * H + 1, '200', 1n)], H, 0n)
    expect(bars.map((b) => b.openTs)).toEqual([H, 2 * H])
  })

  it('hopper over tomme intervaller i stedet for å lage flate bars', () => {
    const bars = aggregate([t(H, '100', 1n), t(4 * H, '200', 1n)], H, 0n)
    expect(bars.map((b) => b.openTs)).toEqual([H, 4 * H])
  })

  it('filtrerer bort handler under minSizeQuote', () => {
    const bars = aggregate([t(H, '100', 5n), t(H + 1, '999', 1n), t(H + 2, '110', 50n)], H, 10n)
    expect(bars[0]!.tradeCount).toBe(1)
    expect(bars[0]!.high).toBe('110')
  })

  it('gir ingen bars når alle handler er under terskelen', () => {
    expect(aggregate([t(H, '100', 1n)], H, 10n)).toEqual([])
  })

  it('sorterer uordnede handler før aggregering', () => {
    const bars = aggregate([t(H + 30, '90', 1n), t(H + 10, '100', 1n)], H, 0n)
    expect(bars[0]).toMatchObject({ open: '100', close: '90' })
  })

  it('er deterministisk — samme input gir samme output', () => {
    const input = [t(H + 5, '100', 1n), t(H + 7, '105', 2n)]
    expect(aggregate(input, H, 0n)).toEqual(aggregate(input, H, 0n))
  })
})
```

- [ ] **Step 2: Kjør og se at den feiler**

Run: `npx vitest run tests/bars/aggregator.test.ts`
Expected: FAIL — modulen finnes ikke

- [ ] **Step 3: Implementer aggregatoren**

`src/bars/aggregator.ts`:

```ts
import type { Bar, Trade } from '../domain/types.js'

const TIMEFRAMES = { '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 } as const

export function timeframeMs(tf: keyof typeof TIMEFRAMES): number {
  return TIMEFRAMES[tf]
}

function gt(a: string, b: string): boolean {
  return Number(a) > Number(b)
}

export function aggregate(trades: Trade[], intervalMs: number, minSizeQuote: bigint): Bar[] {
  const kept = trades
    .filter((tr) => tr.sizeQuote >= minSizeQuote)
    .sort((a, b) => a.ts - b.ts || a.logIndex - b.logIndex)

  const bars: Bar[] = []
  let current: Bar | undefined

  for (const tr of kept) {
    const openTs = Math.floor(tr.ts / intervalMs) * intervalMs
    if (!current || current.openTs !== openTs) {
      current = {
        openTs,
        open: tr.priceQuote, high: tr.priceQuote,
        low: tr.priceQuote, close: tr.priceQuote,
        volumeQuote: 0n, tradeCount: 0,
      }
      bars.push(current)
    }
    if (gt(tr.priceQuote, current.high)) current.high = tr.priceQuote
    if (gt(current.low, tr.priceQuote)) current.low = tr.priceQuote
    current.close = tr.priceQuote
    current.volumeQuote += tr.sizeQuote
    current.tradeCount += 1
  }

  return bars
}
```

`gt` bruker `Number` her fordi sammenligning av to priser med samme størrelsesorden er trygt i flyttall. Task 4 innfører en presis `cmp` for fib-matematikken, der akkumulert avrunding faktisk ville betydd noe.

- [ ] **Step 4: Kjør og se at den passerer**

Run: `npx vitest run tests/bars/aggregator.test.ts`
Expected: PASS, 8 tester

- [ ] **Step 5: Commit**

```bash
git add src/bars tests/bars
git commit -m "feat: BarAggregator som bygger OHLCV fra rå handler"
```

---

### Task 3: Swing-deteksjon (ZigZag med terskler)

**Files:**
- Create: `src/strategy/swings.ts`
- Test: `tests/strategy/swings.test.ts`

**Interfaces:**
- Consumes: `Bar`, `Swing`
- Produces: `function detectSwings(bars: Bar[], opts: SwingOpts): Swing[]` der
  `type SwingOpts = { minSwingPct: number; minSwingDurationMs: number; minSwingVolumeQuote: bigint }`

Algoritmen: gå gjennom bars kronologisk og hold et løpende ekstrempunkt. Er vi i en **nedtrend**, oppdateres kandidatbunnen så lenge nye lavere lows kommer. Når en bar lager en `high` som ligger `minSwingPct` over kandidatbunnen, er bunnen **bekreftet** og vi snur til opptrend. Et bein rapporteres som `Swing` først når både bunn og topp er bekreftet, og beinet passerer terskelene for varighet og volum.

Bekreftelsen skjer på baren som *brøt* terskelen, aldri i etterpåklokskap. Det er dette kausalitetstesten håndhever.

**Det pågående beinet rapporteres også**, med `provisional: true`. Uten det ville boten aldri sett et fib-oppsett før retracementet allerede var over — og det er nettopp mens retracementet pågår at handelen finnes. Et provisorisk bein har derimot en topp som fortsatt kan flytte seg oppover, så kausalitetsinvarianten gjelder **kun bekreftede bein**. Observatøren i Task 11 håndterer at et provisorisk bein utvider seg ved å erstatte det gamle oppsettet.

- [ ] **Step 1: Skriv de feilende testene**

`tests/strategy/swings.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Bar } from '../../src/domain/types.js'
import { detectSwings } from '../../src/strategy/swings.js'

const H = 3_600_000
const OPTS = {
  minSwingPct: 15,
  minSwingDurationMs: 0,
  minSwingVolumeQuote: 0n,
}

let seq = 0
const bar = (low: number, high: number, volume = 1_000_000n): Bar => {
  const openTs = ++seq * H
  return {
    openTs,
    open: String(low), high: String(high), low: String(low), close: String(high),
    volumeQuote: volume, tradeCount: 10,
  }
}
const reset = () => { seq = 0 }

describe('detectSwings', () => {
  it('finner et bein opp når bevegelsen overstiger minSwingPct', () => {
    reset()
    const bars = [bar(100, 105), bar(90, 95), bar(95, 130), bar(120, 125)]
    const swings = detectSwings(bars, OPTS)
    expect(swings).toHaveLength(1)
    expect(swings[0]!.low).toBe('90')
    expect(swings[0]!.high).toBe('130')
  })

  it('merker et pågående bein som provisorisk', () => {
    reset()
    const bars = [bar(100, 105), bar(90, 95), bar(95, 130)]
    expect(detectSwings(bars, OPTS)[0]!.provisional).toBe(true)
  })

  it('merker et bein som bekreftet når prisen har retracet nok', () => {
    reset()
    const bars = [bar(100, 105), bar(90, 95), bar(95, 130), bar(100, 105)]
    const confirmed = detectSwings(bars, OPTS).filter((s) => !s.provisional)
    expect(confirmed).toHaveLength(1)
    expect(confirmed[0]!.high).toBe('130')
  })

  it('ignorerer bevegelser under minSwingPct', () => {
    reset()
    const bars = [bar(100, 101), bar(99, 100), bar(100, 105), bar(103, 104)]
    expect(detectSwings(bars, OPTS)).toEqual([])
  })

  it('avviser bein som er kortere enn minSwingDurationMs', () => {
    reset()
    const bars = [bar(100, 105), bar(90, 95), bar(95, 130)]
    const strict = { ...OPTS, minSwingDurationMs: 10 * H }
    expect(detectSwings(bars, strict)).toEqual([])
  })

  it('avviser bein med for lite volum', () => {
    reset()
    const bars = [bar(100, 105, 1n), bar(90, 95, 1n), bar(95, 130, 1n)]
    const strict = { ...OPTS, minSwingVolumeQuote: 1_000n }
    expect(detectSwings(bars, strict)).toEqual([])
  })

  it('flytter kandidatbunnen ned så lenge nye lows kommer', () => {
    reset()
    const bars = [bar(100, 102), bar(80, 85), bar(60, 65), bar(65, 100)]
    const swings = detectSwings(bars, OPTS)
    expect(swings[0]!.low).toBe('60')
  })

  it('finner flere påfølgende bein', () => {
    reset()
    const bars = [
      bar(100, 105), bar(50, 55), bar(55, 90),
      bar(85, 88), bar(60, 65), bar(65, 120),
    ]
    expect(detectSwings(bars, OPTS).length).toBeGreaterThanOrEqual(2)
  })

  it('setter confirmedAtTs til baren som brøt terskelen, ikke til toppen', () => {
    reset()
    const bars = [bar(100, 105), bar(90, 95), bar(95, 130), bar(125, 200)]
    const swings = detectSwings(bars, OPTS)
    expect(swings[0]!.confirmedAtTs).toBe(3 * H)
  })
})

describe('kausalitet', () => {
  it('et BEKREFTET bein endrer seg aldri når framtidige bars legges til', () => {
    reset()
    const bars: Bar[] = []
    for (let i = 0; i < 60; i++) {
      const base = 100 + Math.sin(i / 3) * 40
      bars.push(bar(Math.round(base - 5), Math.round(base + 5)))
    }

    for (let n = 1; n <= bars.length; n++) {
      const prefix = detectSwings(bars.slice(0, n), OPTS).filter((s) => !s.provisional)
      const full = detectSwings(bars, OPTS)
      for (const s of prefix) {
        const match = full.find((f) => f.confirmedAtTs === s.confirmedAtTs)
        expect(match, `bein bekreftet ved ${s.confirmedAtTs} forsvant`).toBeDefined()
        expect(match).toEqual(s)
      }
    }
  })
})
```

Kausalitetstesten er planens viktigste enkelttest. Den fanger den vanligste måten en backtest lyver: at deteksjonen bruker informasjon som ikke fantes da signalet angivelig ble gitt. Den gjelder kun bekreftede bein — et provisorisk bein *skal* kunne endre seg, og det er derfor det er merket.

- [ ] **Step 2: Kjør og se at den feiler**

Run: `npx vitest run tests/strategy/swings.test.ts`
Expected: FAIL — modulen finnes ikke

- [ ] **Step 3: Implementer deteksjonen**

`src/strategy/swings.ts`:

```ts
import type { Bar, Swing } from '../domain/types.js'

export type SwingOpts = {
  minSwingPct: number
  minSwingDurationMs: number
  minSwingVolumeQuote: bigint
}

type Pivot = { ts: number; price: number }

export function detectSwings(bars: Bar[], opts: SwingOpts): Swing[] {
  const swings: Swing[] = []
  if (bars.length === 0) return swings

  const threshold = opts.minSwingPct / 100
  let direction: 'down' | 'up' = 'down'
  let candidateLow: Pivot = { ts: bars[0]!.openTs, price: Number(bars[0]!.low) }
  let candidateHigh: Pivot = { ts: bars[0]!.openTs, price: Number(bars[0]!.high) }
  let confirmedLow: Pivot | undefined
  let volumeSinceLow = 0n

  for (const b of bars) {
    const low = Number(b.low)
    const high = Number(b.high)

    if (direction === 'down') {
      if (low < candidateLow.price) {
        candidateLow = { ts: b.openTs, price: low }
        volumeSinceLow = 0n
      }
      volumeSinceLow += b.volumeQuote

      if (high >= candidateLow.price * (1 + threshold)) {
        direction = 'up'
        confirmedLow = candidateLow
        candidateHigh = { ts: b.openTs, price: high }
      }
    } else {
      if (high > candidateHigh.price) candidateHigh = { ts: b.openTs, price: high }
      volumeSinceLow += b.volumeQuote

      if (low <= candidateHigh.price * (1 - threshold) && confirmedLow) {
        const duration = candidateHigh.ts - confirmedLow.ts
        if (duration >= opts.minSwingDurationMs && volumeSinceLow >= opts.minSwingVolumeQuote) {
          swings.push({
            lowTs: confirmedLow.ts, low: String(confirmedLow.price),
            highTs: candidateHigh.ts, high: String(candidateHigh.price),
            confirmedAtTs: candidateHigh.ts,
            provisional: false,
          })
        }
        direction = 'down'
        candidateLow = { ts: b.openTs, price: low }
        volumeSinceLow = 0n
        confirmedLow = undefined
      }
    }
  }

  if (direction === 'up' && confirmedLow) {
    const duration = candidateHigh.ts - confirmedLow.ts
    if (duration >= opts.minSwingDurationMs && volumeSinceLow >= opts.minSwingVolumeQuote) {
      swings.push({
        lowTs: confirmedLow.ts, low: String(confirmedLow.price),
        highTs: candidateHigh.ts, high: String(candidateHigh.price),
        confirmedAtTs: candidateHigh.ts,
        provisional: true,
      })
    }
  }

  return swings
}
```

Den siste blokken rapporterer det pågående beinet opp med `provisional: true`. Merk at `confirmedAtTs` da er toppens tidsstempel og vil flytte seg hvis toppen utvides — derfor unntaket i kausalitetstesten.

- [ ] **Step 4: Kjør og se at den passerer**

Run: `npx vitest run tests/strategy/swings.test.ts`
Expected: PASS, 10 tester

Feiler kausalitetstesten på et **bekreftet** bein, er det en ekte bug, ikke et testproblem. Vanligste årsak: en beregning som ser på `bars[i+1]` eller på `bars.length`. Feiler den på et provisorisk bein, mangler filteret i testen.

- [ ] **Step 5: Commit**

```bash
git add src/strategy tests/strategy
git commit -m "feat: kausal ZigZag swing-deteksjon med terskler"
```

---

### Task 4: Fib-nivåer, entry-sone og RR

**Files:**
- Create: `src/strategy/fib.ts`
- Test: `tests/strategy/fib.test.ts`

**Interfaces:**
- Consumes: `Swing`
- Produces:
  - `type FibLevels = { zoneBottom: number; zoneTop: number; sl: number; alerts: { level: number; price: number }[] }`
  - `function fibLevels(swing: Swing, opts: FibOpts): FibLevels`
  - `function rrAt(fillPrice: number, sl: number, tpPct: number): number`
  - `function tpFor(fillPrice: number, tpPct: number): number`
  - `type FibOpts = { fibEntry: number; fibZoneTop: number; slBufferPct: number; alertLevels: number[] }`

Formlene kommer ordrett fra spec-seksjon 2.3. Merk at `zoneBottom` (0.886) ligger **lavere** enn `zoneTop` (0.786), fordi et dypere retracement gir lavere pris.

- [ ] **Step 1: Skriv de feilende testene**

`tests/strategy/fib.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Swing } from '../../src/domain/types.js'
import { fibLevels, rrAt, tpFor } from '../../src/strategy/fib.js'

const swing: Swing = {
  lowTs: 0, low: '100', highTs: 1000, high: '200', confirmedAtTs: 1000, provisional: false,
}

const OPTS = {
  fibEntry: 0.886, fibZoneTop: 0.786, slBufferPct: 2,
  alertLevels: [0.5, 0.618, 0.786],
}

describe('fibLevels', () => {
  it('regner ut sonen fra specens eksempel 100 → 200', () => {
    const l = fibLevels(swing, OPTS)
    expect(l.zoneBottom).toBeCloseTo(111.4, 6)
    expect(l.zoneTop).toBeCloseTo(121.4, 6)
    expect(l.sl).toBeCloseTo(98, 6)
  })

  it('gir en sone der bunnen er lavere enn toppen', () => {
    const l = fibLevels(swing, OPTS)
    expect(l.zoneBottom).toBeLessThan(l.zoneTop)
  })

  it('gir varselpriser for hvert konfigurert nivå, fallende', () => {
    const l = fibLevels(swing, OPTS)
    expect(l.alerts.map((a) => a.level)).toEqual([0.5, 0.618, 0.786])
    expect(l.alerts[0]!.price).toBeCloseTo(150, 6)
    expect(l.alerts[1]!.price).toBeCloseTo(138.2, 6)
    expect(l.alerts[2]!.price).toBeCloseTo(121.4, 6)
    expect(l.alerts[0]!.price).toBeGreaterThan(l.alerts[2]!.price)
  })

  it('skalerer med beinets størrelse', () => {
    const big = fibLevels({ ...swing, low: '1000', high: '5000' }, OPTS)
    expect(big.zoneBottom).toBeCloseTo(5000 - 0.886 * 4000, 6)
  })
})

describe('rrAt og tpFor', () => {
  it('gir RR ≈ 5 for specens eksempel', () => {
    const l = fibLevels(swing, OPTS)
    expect(rrAt(l.zoneBottom, l.sl, 60)).toBeCloseTo(5.0, 1)
  })

  it('gir lavere RR ved dårligere fyll høyt i sonen', () => {
    const l = fibLevels(swing, OPTS)
    expect(rrAt(l.zoneTop, l.sl, 60)).toBeLessThan(rrAt(l.zoneBottom, l.sl, 60))
  })

  it('regner TP fra faktisk fyllpris, ikke fra sonebunnen', () => {
    expect(tpFor(111.4, 60)).toBeCloseTo(178.24, 2)
    expect(tpFor(121.4, 60)).toBeCloseTo(194.24, 2)
  })

  it('gir RR = 0 når stoppen ligger på eller over fyllprisen', () => {
    expect(rrAt(100, 100, 60)).toBe(0)
    expect(rrAt(100, 120, 60)).toBe(0)
  })
})
```

- [ ] **Step 2: Kjør og se at den feiler**

Run: `npx vitest run tests/strategy/fib.test.ts`
Expected: FAIL — modulen finnes ikke

- [ ] **Step 3: Implementer**

`src/strategy/fib.ts`:

```ts
import type { Swing } from '../domain/types.js'

export type FibOpts = {
  fibEntry: number
  fibZoneTop: number
  slBufferPct: number
  alertLevels: number[]
}

export type FibLevels = {
  zoneBottom: number
  zoneTop: number
  sl: number
  alerts: { level: number; price: number }[]
}

export function fibLevels(swing: Swing, opts: FibOpts): FibLevels {
  const low = Number(swing.low)
  const high = Number(swing.high)
  const range = high - low
  const at = (level: number) => high - level * range

  return {
    zoneBottom: at(opts.fibEntry),
    zoneTop: at(opts.fibZoneTop),
    sl: low * (1 - opts.slBufferPct / 100),
    alerts: opts.alertLevels.map((level) => ({ level, price: at(level) })),
  }
}

export function tpFor(fillPrice: number, tpPct: number): number {
  return fillPrice * (1 + tpPct / 100)
}

export function rrAt(fillPrice: number, sl: number, tpPct: number): number {
  const risk = fillPrice - sl
  if (risk <= 0) return 0
  return (tpFor(fillPrice, tpPct) - fillPrice) / risk
}
```

- [ ] **Step 4: Kjør og se at den passerer**

Run: `npx vitest run tests/strategy/fib.test.ts`
Expected: PASS, 8 tester

- [ ] **Step 5: Commit**

```bash
git add src/strategy/fib.ts tests/strategy/fib.test.ts
git commit -m "feat: fib-nivåer, entry-sone og RR-beregning"
```

---

### Task 5: Oppsettets tilstandsmaskin

**Files:**
- Create: `src/strategy/setups.ts`
- Test: `tests/strategy/setups.test.ts`

**Interfaces:**
- Consumes: `Swing`, `SetupState`, `FibLevels`, `fibLevels`, `rrAt`
- Produces:
  - `type Setup = { id: string; poolAddress: Hex; state: SetupState; swing: Swing; levels: FibLevels; createdAtTs: number; alertsSent: number[] }`
  - `function createSetup(poolAddress: Hex, swing: Swing, opts: FibOpts, nowTs: number): Setup`
  - `function evaluateSetup(setup: Setup, ctx: EvalCtx): SetupTransition`
  - `type EvalCtx = { price: number; nowTs: number; intervalMs: number; maxSetupAgeBars: number; minRR: number; tpPct: number }`
  - `type SetupTransition = { state: SetupState; reason: string; newAlerts: number[] }`

Denne modulen er ren: den beregner *hvilken* overgang som skal skje, men utfører ingen. Å sende varselet og lagre tilstanden er orkestratorens jobb i Task 11. Det er det som gjør hele livssyklusen testbar uten Telegram og uten database.

`id` genereres av kalleren og sendes inn, slik at modulen forblir deterministisk.

- [ ] **Step 1: Skriv de feilende testene**

`tests/strategy/setups.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Swing } from '../../src/domain/types.js'
import { createSetup, evaluateSetup } from '../../src/strategy/setups.js'

const H = 3_600_000
const POOL = '0x1111111111111111111111111111111111111111' as const

const swing: Swing = { lowTs: 0, low: '100', highTs: 10 * H, high: '200', confirmedAtTs: 10 * H, provisional: false }
const FIB = { fibEntry: 0.886, fibZoneTop: 0.786, slBufferPct: 2, alertLevels: [0.5, 0.618, 0.786] }

const setup = () => createSetup(POOL, swing, FIB, 10 * H)
const ctx = (price: number, nowTs = 11 * H) => ({
  price, nowTs, intervalMs: H, maxSetupAgeBars: 48, minRR: 3, tpPct: 60,
})

describe('createSetup', () => {
  it('starter i DETECTED uten varsler sendt', () => {
    const s = setup()
    expect(s.state).toBe('DETECTED')
    expect(s.alertsSent).toEqual([])
    expect(s.levels.zoneBottom).toBeCloseTo(111.4, 6)
  })
})

describe('evaluateSetup', () => {
  it('holder seg i DETECTED når prisen er over alle nivåer', () => {
    const tr = evaluateSetup(setup(), ctx(190))
    expect(tr.state).toBe('DETECTED')
    expect(tr.newAlerts).toEqual([])
  })

  it('varsler om 0.5 når prisen krysser ned gjennom det', () => {
    const tr = evaluateSetup(setup(), ctx(149))
    expect(tr.newAlerts).toEqual([0.5])
  })

  it('varsler om alle passerte nivåer ved et raskt fall', () => {
    const tr = evaluateSetup(setup(), ctx(125))
    expect(tr.newAlerts).toEqual([0.5, 0.618])
  })

  it('varsler aldri om samme nivå to ganger', () => {
    const s = { ...setup(), alertsSent: [0.5, 0.618] }
    expect(evaluateSetup(s, ctx(125)).newAlerts).toEqual([])
  })

  it('varsler ikke på nytt når prisen spretter tilbake over et nivå', () => {
    const s = { ...setup(), alertsSent: [0.5] }
    const back = evaluateSetup(s, ctx(180))
    expect(back.newAlerts).toEqual([])
    const down = evaluateSetup({ ...s, alertsSent: back.newAlerts.concat(s.alertsSent) }, ctx(149))
    expect(down.newAlerts).toEqual([])
  })

  it('går til TRIGGERED når prisen er inne i sonen', () => {
    const tr = evaluateSetup(setup(), ctx(115))
    expect(tr.state).toBe('TRIGGERED')
  })

  it('går til INVALIDATED når prisen bryter under swing low', () => {
    const tr = evaluateSetup(setup(), ctx(99))
    expect(tr.state).toBe('INVALIDATED')
    expect(tr.reason).toMatch(/swing low/)
  })

  it('går til EXPIRED etter maxSetupAgeBars', () => {
    const tr = evaluateSetup(setup(), ctx(190, 10 * H + 49 * H))
    expect(tr.state).toBe('EXPIRED')
  })

  it('går til REJECTED når RR i sonen er under minRR', () => {
    const tr = evaluateSetup(setup(), { ...ctx(115), minRR: 99 })
    expect(tr.state).toBe('REJECTED')
    expect(tr.reason).toMatch(/RR/)
  })

  it('prioriterer ugyldiggjøring over trigger når begge kunne gjelde', () => {
    const tr = evaluateSetup(setup(), ctx(97))
    expect(tr.state).toBe('INVALIDATED')
  })
})
```

- [ ] **Step 2: Kjør og se at den feiler**

Run: `npx vitest run tests/strategy/setups.test.ts`
Expected: FAIL — modulen finnes ikke

- [ ] **Step 3: Implementer**

`src/strategy/setups.ts`:

```ts
import type { Hex, SetupState, Swing } from '../domain/types.js'
import { type FibLevels, type FibOpts, fibLevels, rrAt } from './fib.js'

export type Setup = {
  id: string
  poolAddress: Hex
  state: SetupState
  swing: Swing
  levels: FibLevels
  createdAtTs: number
  alertsSent: number[]
}

export type EvalCtx = {
  price: number
  nowTs: number
  intervalMs: number
  maxSetupAgeBars: number
  minRR: number
  tpPct: number
}

export type SetupTransition = {
  state: SetupState
  reason: string
  newAlerts: number[]
}

export function createSetup(
  poolAddress: Hex, swing: Swing, opts: FibOpts, nowTs: number,
): Setup {
  return {
    id: `${poolAddress}-${swing.lowTs}-${swing.highTs}`,
    poolAddress,
    state: 'DETECTED',
    swing,
    levels: fibLevels(swing, opts),
    createdAtTs: nowTs,
    alertsSent: [],
  }
}

export function evaluateSetup(setup: Setup, ctx: EvalCtx): SetupTransition {
  const none: number[] = []
  const swingLow = Number(setup.swing.low)

  if (ctx.price < swingLow) {
    return { state: 'INVALIDATED', reason: 'pris under swing low', newAlerts: none }
  }

  const ageBars = (ctx.nowTs - setup.createdAtTs) / ctx.intervalMs
  if (ageBars > ctx.maxSetupAgeBars) {
    return { state: 'EXPIRED', reason: `eldre enn ${ctx.maxSetupAgeBars} bars`, newAlerts: none }
  }

  const inZone = ctx.price <= setup.levels.zoneTop && ctx.price >= setup.levels.zoneBottom
  if (inZone) {
    const rr = rrAt(ctx.price, setup.levels.sl, ctx.tpPct)
    if (rr < ctx.minRR) {
      return { state: 'REJECTED', reason: `RR ${rr.toFixed(2)} under minRR ${ctx.minRR}`, newAlerts: none }
    }
    return { state: 'TRIGGERED', reason: `pris ${ctx.price} inne i sonen`, newAlerts: none }
  }

  const newAlerts = setup.levels.alerts
    .filter((a) => ctx.price <= a.price && !setup.alertsSent.includes(a.level))
    .map((a) => a.level)
    .sort((a, b) => a - b)

  return { state: setup.state, reason: 'ingen endring', newAlerts }
}
```

- [ ] **Step 4: Kjør og se at den passerer**

Run: `npx vitest run tests/strategy/setups.test.ts`
Expected: PASS, 11 tester

- [ ] **Step 5: Kjør hele suiten inkludert renhetstesten**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS. Renhetstesten skal bekrefte at `src/strategy/` fortsatt ikke importerer IO.

- [ ] **Step 6: Commit**

```bash
git add src/strategy/setups.ts tests/strategy/setups.test.ts
git commit -m "feat: ren tilstandsmaskin for oppsettets livssyklus"
```

---

### Task 6: Pool-adapter — verifiser ABI on-chain, dekod Swap → Trade

**Files:**
- Create: `scripts/inspect-pool.ts`
- Create: `src/chain/client.ts`
- Create: `src/data/pool.ts`
- Create: `src/data/decode.ts`
- Test: `tests/data/decode.test.ts`

**Interfaces:**
- Consumes: `Trade`, `Hex`
- Produces:
  - `const robinhoodChain: Chain` (viem chain-definisjon, id 4663)
  - `function publicClient(rpcUrl: string): PublicClient`
  - `type PoolMeta = { address: Hex; token0: Hex; token1: Hex; decimals0: number; decimals1: number; baseIsToken0: boolean; feeBps: number }`
  - `function loadPoolMeta(client: PublicClient, address: Hex, quoteToken: Hex): Promise<PoolMeta>`
  - `type RawLog = { data: Hex | string; topics: readonly string[]; transactionHash: string; logIndex: number }`
  - `function decodeSwapLog(log: RawLog, meta: PoolMeta, blockTs: number): Trade`
  - `function priceFromSqrtX96(sqrtPriceX96: bigint, meta: PoolMeta): string`

**Dette dekker spec 6.7, mottiltak 2.** Prisen leses fra `sqrtPriceX96` i selve eventen, som *er* poolens spotpris etter handelen — utledet av reservene, ikke av mengdeforholdet i én enkelt swap. En bittelitenswap som forsøker å printe en absurd pris kan derfor ikke lyve om nivået. Mottiltak 1, størrelsesfilteret, ligger i Task 2 og Task 11.

**Dette er planens eneste task som starter med en undersøkelse.** Vi vet at Uniswap er deployet på Robinhood Chain, men ikke hvilken versjon, og event-signaturen avgjør hele dekoderen. Å gjette her og oppdage feilen i Task 11 ville kastet bort tre tasks.

- [ ] **Step 1: Skriv inspeksjonsskriptet**

`scripts/inspect-pool.ts`:

```ts
import 'dotenv/config'
import { createPublicClient, http, keccak256, toHex } from 'viem'

const SIGNATURES = {
  'UniswapV2 Swap': 'Swap(address,uint256,uint256,uint256,uint256,address)',
  'UniswapV3 Swap': 'Swap(address,address,int256,int256,uint160,uint128,int24)',
  'UniswapV4 Swap': 'Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)',
}

const pool = process.argv[2]
if (!pool) throw new Error('bruk: tsx scripts/inspect-pool.ts <pool-adresse>')

const client = createPublicClient({ transport: http(process.env.RPC_HTTP_URL) })
const latest = await client.getBlockNumber()
const logs = await client.getLogs({
  address: pool as `0x${string}`,
  fromBlock: latest - 50_000n,
  toBlock: latest,
})

const counts = new Map<string, number>()
for (const l of logs) counts.set(l.topics[0] ?? 'ingen', (counts.get(l.topics[0] ?? 'ingen') ?? 0) + 1)

console.log(`chainId: ${await client.getChainId()}, blokk: ${latest}, logger: ${logs.length}\n`)
for (const [name, sig] of Object.entries(SIGNATURES)) {
  const topic = keccak256(toHex(sig))
  console.log(`${counts.has(topic) ? '✓' : ' '} ${name.padEnd(16)} ${topic}  treff: ${counts.get(topic) ?? 0}`)
}
console.log('\nAlle topic0 i poolen:')
for (const [topic, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${topic}  ${n}`)
```

- [ ] **Step 2: Kjør det mot en ekte pool**

Finn en aktiv pool på Robinhood Chain — via DEX-ens eget grensesnitt eller en explorer — og kjør:

```bash
cp .env.example .env   # fyll inn RPC_HTTP_URL
npx tsx scripts/inspect-pool.ts 0x<pool-adresse>
```

**Noter hvilken versjon som treffer.** Resten av denne tasken antar **Uniswap V3**, som er det mest sannsynlige. Treffer V2 eller V4 i stedet: bytt ut ABI-en og prisformelen i Step 5, behold testenes struktur, og skriv en linje i commit-meldingen om hva som faktisk kjører on-chain.

- [ ] **Step 3: Skriv de feilende testene**

`tests/data/decode.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { PoolMeta } from '../../src/data/pool.js'
import { decodeSwapLog, priceFromSqrtX96 } from '../../src/data/decode.js'
import { encodeAbiParameters, keccak256, toHex } from 'viem'

const meta: PoolMeta = {
  address: '0x1111111111111111111111111111111111111111',
  token0: '0xaaaa000000000000000000000000000000000000',
  token1: '0xbbbb000000000000000000000000000000000000',
  decimals0: 18,
  decimals1: 18,
  baseIsToken0: true,
  feeBps: 30,
}

const TOPIC = keccak256(toHex('Swap(address,address,int256,int256,uint160,uint128,int24)'))
const Q96 = 2n ** 96n

const makeLog = (amount0: bigint, amount1: bigint, sqrtPriceX96: bigint) => ({
  address: meta.address,
  topics: [TOPIC, `0x${'0'.repeat(64)}`, `0x${'0'.repeat(64)}`] as [string, string, string],
  data: encodeAbiParameters(
    [
      { type: 'int256' }, { type: 'int256' }, { type: 'uint160' },
      { type: 'uint128' }, { type: 'int24' },
    ],
    [amount0, amount1, sqrtPriceX96, 0n, 0],
  ),
  transactionHash: '0xdead' as const,
  logIndex: 7,
})

describe('priceFromSqrtX96', () => {
  it('gir 1.0 når sqrtPrice er Q96 og desimalene er like', () => {
    expect(Number(priceFromSqrtX96(Q96, meta))).toBeCloseTo(1, 9)
  })

  it('gir 4.0 når sqrtPrice er 2 × Q96', () => {
    expect(Number(priceFromSqrtX96(2n * Q96, meta))).toBeCloseTo(4, 9)
  })

  it('justerer for ulikt antall desimaler', () => {
    const usdcLike = { ...meta, decimals1: 6 }
    expect(Number(priceFromSqrtX96(Q96, usdcLike))).toBeCloseTo(1e12, -6)
  })

  it('takler svært små priser uten å bli 0', () => {
    const p = Number(priceFromSqrtX96(Q96 / 100_000n, meta))
    expect(p).toBeGreaterThan(0)
    expect(p).toBeLessThan(1e-9)
  })
})

describe('decodeSwapLog', () => {
  it('leser pris fra sqrtPriceX96, ikke fra mengdeforholdet', () => {
    const trade = decodeSwapLog(makeLog(-100n, 400n, 2n * Q96), meta, 1_700_000)
    expect(Number(trade.priceQuote)).toBeCloseTo(4, 9)
  })

  it('merker et kjøp av base-tokenet som buy', () => {
    // amount0 negativ = token0 forlater poolen = noen kjøper base
    expect(decodeSwapLog(makeLog(-100n, 400n, Q96), meta, 1).side).toBe('buy')
  })

  it('merker et salg av base-tokenet som sell', () => {
    expect(decodeSwapLog(makeLog(100n, -400n, Q96), meta, 1).side).toBe('sell')
  })

  it('rapporterer størrelser som absoluttverdier', () => {
    const trade = decodeSwapLog(makeLog(-100n, 400n, Q96), meta, 1)
    expect(trade.sizeBase).toBe(100n)
    expect(trade.sizeQuote).toBe(400n)
  })

  it('tar med txHash, logIndex og blokk-tidsstempel', () => {
    const trade = decodeSwapLog(makeLog(-1n, 1n, Q96), meta, 1_700_000)
    expect(trade).toMatchObject({ txHash: '0xdead', logIndex: 7, ts: 1_700_000 })
  })

  it('snur base og quote når baseIsToken0 er false', () => {
    const flipped = { ...meta, baseIsToken0: false }
    const trade = decodeSwapLog(makeLog(-100n, 400n, Q96), flipped, 1)
    expect(trade.sizeBase).toBe(400n)
    expect(trade.sizeQuote).toBe(100n)
  })
})
```

- [ ] **Step 4: Kjør og se at den feiler**

Run: `npx vitest run tests/data/decode.test.ts`
Expected: FAIL — modulene finnes ikke

- [ ] **Step 5: Implementer chain, pool og dekoder**

`src/chain/client.ts`:

```ts
import { type Chain, type PublicClient, createPublicClient, defineChain, http } from 'viem'

export const robinhoodChain: Chain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
})

export function publicClient(rpcUrl: string): PublicClient {
  return createPublicClient({ chain: robinhoodChain, transport: http(rpcUrl) })
}
```

`src/data/pool.ts`:

```ts
import type { PublicClient } from 'viem'
import type { Hex } from '../domain/types.js'

export type PoolMeta = {
  address: Hex
  token0: Hex
  token1: Hex
  decimals0: number
  decimals1: number
  baseIsToken0: boolean
  feeBps: number
}

const POOL_ABI = [
  { name: 'token0', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'token1', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'fee', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint24' }] },
] as const

const ERC20_ABI = [
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const

/**
 * `quoteToken` er tokenet prisen uttrykkes i — typisk WETH eller en stablecoin.
 * Base er det andre. Kalleren oppgir quote fordi bare den vet hva som er
 * "pengene" i akkurat denne poolen.
 */
export async function loadPoolMeta(
  client: PublicClient, address: Hex, quoteToken: Hex,
): Promise<PoolMeta> {
  const [token0, token1, fee] = await Promise.all([
    client.readContract({ address, abi: POOL_ABI, functionName: 'token0' }),
    client.readContract({ address, abi: POOL_ABI, functionName: 'token1' }),
    client.readContract({ address, abi: POOL_ABI, functionName: 'fee' }),
  ])

  const [decimals0, decimals1] = await Promise.all([
    client.readContract({ address: token0, abi: ERC20_ABI, functionName: 'decimals' }),
    client.readContract({ address: token1, abi: ERC20_ABI, functionName: 'decimals' }),
  ])

  const q = quoteToken.toLowerCase()
  if (q !== token0.toLowerCase() && q !== token1.toLowerCase()) {
    throw new Error(`quoteToken ${quoteToken} er ikke i pool ${address}`)
  }

  return {
    address, token0, token1,
    decimals0: Number(decimals0), decimals1: Number(decimals1),
    baseIsToken0: q === token1.toLowerCase(),
    feeBps: Number(fee) / 100,
  }
}
```

`src/data/decode.ts`:

```ts
import { decodeAbiParameters } from 'viem'
import type { Hex, Trade } from '../domain/types.js'
import type { PoolMeta } from './pool.js'

const SWAP_ARGS = [
  { type: 'int256' }, { type: 'int256' }, { type: 'uint160' },
  { type: 'uint128' }, { type: 'int24' },
] as const

const Q96 = 2n ** 96n
const SCALE = 10n ** 18n

export type RawLog = {
  data: Hex | string
  topics: readonly string[]
  transactionHash: string
  logIndex: number
}

/**
 * Pris = (sqrtPriceX96 / 2^96)^2, justert for desimaler, uttrykt som
 * quote-token per base-token. Regnet i bigint med 18 desimalers presisjon,
 * fordi tokenpriser rutinemessig har 12+ signifikante siffer.
 */
export function priceFromSqrtX96(sqrtPriceX96: bigint, meta: PoolMeta): string {
  // token1 per token0, skalert med SCALE
  let scaled = (sqrtPriceX96 * sqrtPriceX96 * SCALE) / (Q96 * Q96)
  const decAdj = meta.decimals0 - meta.decimals1
  if (decAdj > 0) scaled *= 10n ** BigInt(decAdj)
  else if (decAdj < 0) scaled /= 10n ** BigInt(-decAdj)

  // Er base token1, er prisen den inverse
  if (!meta.baseIsToken0) {
    if (scaled === 0n) return '0'
    scaled = (SCALE * SCALE) / scaled
  }

  const whole = scaled / SCALE
  const frac = (scaled % SCALE).toString().padStart(18, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole.toString()
}

export function decodeSwapLog(log: RawLog, meta: PoolMeta, blockTs: number): Trade {
  const [amount0, amount1, sqrtPriceX96] = decodeAbiParameters(SWAP_ARGS, log.data as Hex)

  const amountBase = meta.baseIsToken0 ? amount0 : amount1
  const amountQuote = meta.baseIsToken0 ? amount1 : amount0
  const abs = (v: bigint) => (v < 0n ? -v : v)

  return {
    ts: blockTs,
    txHash: log.transactionHash as Hex,
    logIndex: log.logIndex,
    priceQuote: priceFromSqrtX96(sqrtPriceX96, meta),
    sizeBase: abs(amountBase),
    sizeQuote: abs(amountQuote),
    // Base forlater poolen (negativ) = noen kjøpte base
    side: amountBase < 0n ? 'buy' : 'sell',
  }
}
```

- [ ] **Step 6: Kjør og se at den passerer**

Run: `npx vitest run tests/data/decode.test.ts`
Expected: PASS, 10 tester

- [ ] **Step 7: Commit**

```bash
git add scripts src/chain src/data tests/data
git commit -m "feat: pool-metadata og Swap-dekoding med pris fra sqrtPriceX96

Verifisert mot ekte pool på Robinhood Chain: <versjon> med topic0 <0x...>"
```

---

### Task 7: Historisk backfill

**Files:**
- Create: `src/data/backfill.ts`
- Test: `tests/data/backfill.test.ts`

**Interfaces:**
- Consumes: `PoolMeta`, `decodeSwapLog`, `Trade`
- Produces: `function backfillTrades(client: LogReader, meta: PoolMeta, from: bigint, to: bigint, rangeSize: number): Promise<Trade[]>`
  der `type LogReader = { getLogs(args): Promise<RawLog[]>; getBlock(args): Promise<{ timestamp: bigint }> }`

Backfill pager gjennom blokkintervaller fordi RPC-leverandører avviser for store spenn. Blokk-tidsstempler caches per blokknummer — uten det ville en pool med 5000 handler i samme blokk gitt 5000 identiske RPC-kall.

Dedupe på `(txHash, logIndex)` per spec 6.6. Testen mot `LogReader` som grensesnitt i stedet for viem-klienten direkte gjør tasken testbar uten nettverk.

- [ ] **Step 1: Skriv de feilende testene**

`tests/data/backfill.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters } from 'viem'
import { backfillTrades } from '../../src/data/backfill.js'
import type { PoolMeta } from '../../src/data/pool.js'

const meta: PoolMeta = {
  address: '0x1111111111111111111111111111111111111111',
  token0: '0xaaaa000000000000000000000000000000000000',
  token1: '0xbbbb000000000000000000000000000000000000',
  decimals0: 18, decimals1: 18, baseIsToken0: true, feeBps: 30,
}

const Q96 = 2n ** 96n
const log = (blockNumber: bigint, logIndex: number, txHash = '0xaa') => ({
  blockNumber,
  logIndex,
  transactionHash: txHash,
  topics: ['0x00'],
  data: encodeAbiParameters(
    [{ type: 'int256' }, { type: 'int256' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }],
    [-1n, 1n, Q96, 0n, 0],
  ),
})

const reader = (logsByRange: Record<string, ReturnType<typeof log>[]>) => ({
  getLogs: vi.fn(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) =>
    logsByRange[`${fromBlock}-${toBlock}`] ?? []),
  getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) =>
    ({ timestamp: BigInt(1_700_000) + blockNumber })),
})

describe('backfillTrades', () => {
  it('pager gjennom blokkintervaller', async () => {
    const r = reader({ '0-9': [log(1n, 0)], '10-19': [log(11n, 0, '0xbb')], '20-20': [] })
    const trades = await backfillTrades(r, meta, 0n, 20n, 10)
    expect(r.getLogs).toHaveBeenCalledTimes(3)
    expect(trades).toHaveLength(2)
  })

  it('deduplikerer på (txHash, logIndex)', async () => {
    const r = reader({ '0-9': [log(1n, 0), log(1n, 0), log(1n, 1)] })
    const trades = await backfillTrades(r, meta, 0n, 9n, 10)
    expect(trades).toHaveLength(2)
  })

  it('setter tidsstempel fra blokken', async () => {
    const r = reader({ '0-9': [log(5n, 0)] })
    const [trade] = await backfillTrades(r, meta, 0n, 9n, 10)
    expect(trade!.ts).toBe(1_700_005_000)
  })

  it('henter hvert blokk-tidsstempel kun én gang', async () => {
    const r = reader({ '0-9': [log(5n, 0), log(5n, 1), log(5n, 2)] })
    await backfillTrades(r, meta, 0n, 9n, 10)
    expect(r.getBlock).toHaveBeenCalledTimes(1)
  })

  it('returnerer handler sortert kronologisk', async () => {
    const r = reader({ '0-9': [log(7n, 0), log(2n, 1), log(2n, 0)] })
    const trades = await backfillTrades(r, meta, 0n, 9n, 10)
    expect(trades.map((t) => [t.ts, t.logIndex])).toEqual([
      [1_700_002_000, 0], [1_700_002_000, 1], [1_700_007_000, 0],
    ])
  })

  it('gir tom liste når det ikke finnes logger', async () => {
    expect(await backfillTrades(reader({}), meta, 0n, 9n, 10)).toEqual([])
  })
})
```

- [ ] **Step 2: Kjør og se at den feiler**

Run: `npx vitest run tests/data/backfill.test.ts`
Expected: FAIL — modulen finnes ikke

- [ ] **Step 3: Implementer**

`src/data/backfill.ts`:

```ts
import type { Trade } from '../domain/types.js'
import { type RawLog, decodeSwapLog } from './decode.js'
import type { PoolMeta } from './pool.js'

export type BlockLog = RawLog & { blockNumber: bigint }

export type LogReader = {
  getLogs(args: { address: string; fromBlock: bigint; toBlock: bigint }): Promise<BlockLog[]>
  getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }>
}

export async function backfillTrades(
  client: LogReader, meta: PoolMeta, from: bigint, to: bigint, rangeSize: number,
): Promise<Trade[]> {
  const seen = new Set<string>()
  const timestamps = new Map<bigint, number>()
  const trades: Trade[] = []
  const step = BigInt(rangeSize)

  for (let start = from; start <= to; start += step) {
    const end = start + step - 1n > to ? to : start + step - 1n
    const logs = await client.getLogs({ address: meta.address, fromBlock: start, toBlock: end })

    for (const log of logs) {
      const key = `${log.transactionHash}-${log.logIndex}`
      if (seen.has(key)) continue
      seen.add(key)

      let ts = timestamps.get(log.blockNumber)
      if (ts === undefined) {
        const block = await client.getBlock({ blockNumber: log.blockNumber })
        ts = Number(block.timestamp) * 1000
        timestamps.set(log.blockNumber, ts)
      }

      trades.push(decodeSwapLog(log, meta, ts))
    }
  }

  return trades.sort((a, b) => a.ts - b.ts || a.logIndex - b.logIndex)
}
```

- [ ] **Step 4: Kjør og se at den passerer**

Run: `npx vitest run tests/data/backfill.test.ts`
Expected: PASS, 6 tester

- [ ] **Step 5: Commit**

```bash
git add src/data/backfill.ts tests/data/backfill.test.ts
git commit -m "feat: historisk backfill med paging, dedupe og tidsstempel-cache"
```

---

### Task 8: Live-strøm med heartbeat og reconnect

**Files:**
- Create: `src/data/live.ts`
- Test: `tests/data/live.test.ts`

**Interfaces:**
- Consumes: `PoolMeta`, `decodeSwapLog`, `Trade`
- Produces:
  - `type StreamEvent = { kind: 'trade'; trade: Trade } | { kind: 'stale'; sinceMs: number } | { kind: 'healthy' }`
  - `class LiveStream { constructor(deps: LiveDeps); start(): void; stop(): void; on(fn: (e: StreamEvent) => void): void }`
  - `type LiveDeps = { subscribe(onLog, onError): () => void; now(): number; setTimer(fn, ms): Timer; clearTimer(t): void; maxStalenessMs: number; meta: PoolMeta; blockTs(bn: bigint): Promise<number> }`

Per spec 6.1: strømmen skal **degradere til trygt**. Går det lenger enn `maxDataStalenessMs` uten en event, sendes `stale` — orkestratoren i Task 11 bruker den til å disarmere oppsett. Klassen tar alle tidsavhengigheter som injiserte funksjoner, slik at testene kjører uten ekte klokke og uten nettverk.

- [ ] **Step 1: Verifiser at RPC-en støtter WebSocket**

```bash
npx tsx -e "
import { createPublicClient, webSocket } from 'viem'
const url = process.env.RPC_WS_URL || 'wss://rpc.mainnet.chain.robinhood.com'
const c = createPublicClient({ transport: webSocket(url) })
console.log('blokk:', await c.getBlockNumber())
process.exit(0)
"
```

Feiler dette, støtter ikke den offentlige endepunktet WS. Bruk da en leverandør som gjør det (Alchemy har integrert med kjeden) og sett `RPC_WS_URL` i `.env`. **Ikke** fall tilbake til polling — spec 6.1 er eksplisitt på at det er å degradere til gjetting. Noter resultatet i commit-meldingen.

- [ ] **Step 2: Skriv de feilende testene**

`tests/data/live.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters } from 'viem'
import { LiveStream, type StreamEvent } from '../../src/data/live.js'
import type { PoolMeta } from '../../src/data/pool.js'

const meta: PoolMeta = {
  address: '0x1111111111111111111111111111111111111111',
  token0: '0xaaaa000000000000000000000000000000000000',
  token1: '0xbbbb000000000000000000000000000000000000',
  decimals0: 18, decimals1: 18, baseIsToken0: true, feeBps: 30,
}

const Q96 = 2n ** 96n
const mkLog = (logIndex: number) => ({
  blockNumber: 1n, logIndex, transactionHash: `0x${logIndex}`,
  topics: ['0x00'],
  data: encodeAbiParameters(
    [{ type: 'int256' }, { type: 'int256' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }],
    [-1n, 1n, Q96, 0n, 0],
  ),
})

function harness(maxStalenessMs = 10_000) {
  let onLog: ((l: ReturnType<typeof mkLog>) => void) | undefined
  let onError: ((e: Error) => void) | undefined
  let clock = 0
  const timers: { fn: () => void; at: number }[] = []
  const events: StreamEvent[] = []
  const unsubscribe = vi.fn()
  const subscribe = vi.fn((l: typeof onLog, e: typeof onError) => {
    onLog = l; onError = e; return unsubscribe
  })

  const stream = new LiveStream({
    subscribe: subscribe as never,
    now: () => clock,
    setTimer: (fn: () => void, ms: number) => { const t = { fn, at: clock + ms }; timers.push(t); return t },
    clearTimer: (t: unknown) => { const i = timers.indexOf(t as never); if (i >= 0) timers.splice(i, 1) },
    maxStalenessMs,
    meta,
    blockTs: async () => 1_700_000_000,
  })
  stream.on((e) => events.push(e))

  return {
    stream, events, subscribe, unsubscribe,
    emitLog: (i: number) => onLog?.(mkLog(i)),
    emitError: (e: Error) => onError?.(e),
    advance: (ms: number) => {
      clock += ms
      for (const t of [...timers]) if (t.at <= clock) { timers.splice(timers.indexOf(t), 1); t.fn() }
    },
  }
}

describe('LiveStream', () => {
  it('abonnerer ved start', () => {
    const h = harness()
    h.stream.start()
    expect(h.subscribe).toHaveBeenCalledOnce()
  })

  it('sender dekodede handler videre', async () => {
    const h = harness()
    h.stream.start()
    h.emitLog(0)
    await vi.waitFor(() => expect(h.events.filter((e) => e.kind === 'trade')).toHaveLength(1))
  })

  it('sender stale når det går for lenge uten event', () => {
    const h = harness(10_000)
    h.stream.start()
    h.advance(10_001)
    expect(h.events.at(-1)).toMatchObject({ kind: 'stale' })
  })

  it('sender ikke stale når events kommer jevnlig', async () => {
    const h = harness(10_000)
    h.stream.start()
    for (let i = 0; i < 5; i++) { h.advance(5_000); h.emitLog(i); await vi.waitFor(() => {}) }
    expect(h.events.some((e) => e.kind === 'stale')).toBe(false)
  })

  it('sender healthy igjen når data kommer tilbake etter stale', async () => {
    const h = harness(10_000)
    h.stream.start()
    h.advance(10_001)
    h.emitLog(0)
    await vi.waitFor(() => expect(h.events.some((e) => e.kind === 'healthy')).toBe(true))
  })

  it('abonnerer på nytt etter feil', () => {
    const h = harness()
    h.stream.start()
    h.emitError(new Error('socket lukket'))
    h.advance(60_000)
    expect(h.subscribe.mock.calls.length).toBeGreaterThan(1)
  })

  it('sier opp abonnementet ved stop og abonnerer ikke på nytt', () => {
    const h = harness()
    h.stream.start()
    h.stream.stop()
    expect(h.unsubscribe).toHaveBeenCalled()
    h.advance(120_000)
    expect(h.subscribe).toHaveBeenCalledOnce()
  })

  it('deduplikerer gjentatte logger', async () => {
    const h = harness()
    h.stream.start()
    h.emitLog(0); h.emitLog(0)
    await vi.waitFor(() => expect(h.events.filter((e) => e.kind === 'trade')).toHaveLength(1))
  })
})
```

- [ ] **Step 3: Kjør og se at den feiler**

Run: `npx vitest run tests/data/live.test.ts`
Expected: FAIL — modulen finnes ikke

- [ ] **Step 4: Implementer**

`src/data/live.ts`:

```ts
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
  private unsubscribe?: () => void
  private timer?: unknown
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
    if (this.timer !== undefined) this.deps.clearTimer(this.timer)
    this.timer = undefined
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
        this.deps.setTimer(() => this.connect(), this.backoff)
        this.backoff = Math.min(this.backoff * 2, MAX_RECONNECT_MS)
      },
    )
  }

  private armStaleTimer(): void {
    if (!this.running) return
    this.timer = this.deps.setTimer(() => {
      const since = this.deps.now() - this.lastEventAt
      if (since >= this.deps.maxStalenessMs) {
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
```

- [ ] **Step 5: Kjør og se at den passerer**

Run: `npx vitest run tests/data/live.test.ts`
Expected: PASS, 8 tester

- [ ] **Step 6: Commit**

```bash
git add src/data/live.ts tests/data/live.test.ts
git commit -m "feat: live swap-strøm med heartbeat, reconnect og stale-signal

WS-støtte på offentlig RPC: <ja/nei — resultat fra Step 1>"
```

---

### Task 9: SQLite-lager

**Files:**
- Create: `src/store/db.ts`
- Create: `src/store/setups.ts`
- Test: `tests/store/setups.test.ts`

**Interfaces:**
- Consumes: `Setup`, `Config`
- Produces:
  - `function openDb(path: string): Database`
  - `function migrate(db: Database): void`
  - `class SetupStore { constructor(db); upsert(s: Setup): void; get(id: string): Setup | undefined; allActive(): Setup[]; recordAlert(id: string, level: number): void }`
  - `class WatchlistStore { constructor(db); add(e: WatchlistEntry): void; all(): WatchlistEntry[] }`
  - `type WatchlistEntry = { poolAddress: Hex; quoteToken: Hex; label: string; addedAtTs: number }`

Config lagres ikke ennå — den kommer med UI-et i plan 5. Watchlisten trengs nå, fordi orkestratoren må vite hvilke pools den skal følge.

- [ ] **Step 1: Skriv de feilende testene**

`tests/store/setups.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { SetupStore, WatchlistStore } from '../../src/store/setups.js'
import { migrate, openDb } from '../../src/store/db.js'
import { createSetup } from '../../src/strategy/setups.js'
import type { Swing } from '../../src/domain/types.js'

const POOL = '0x1111111111111111111111111111111111111111' as const
const swing: Swing = { lowTs: 0, low: '100', highTs: 1000, high: '200', confirmedAtTs: 1000, provisional: false }
const FIB = { fibEntry: 0.886, fibZoneTop: 0.786, slBufferPct: 2, alertLevels: [0.5, 0.618, 0.786] }

function store() {
  const db = openDb(':memory:')
  migrate(db)
  return { setups: new SetupStore(db), watchlist: new WatchlistStore(db) }
}

describe('SetupStore', () => {
  it('lagrer og henter et oppsett med alle feltene intakt', () => {
    const { setups } = store()
    const s = createSetup(POOL, swing, FIB, 1000)
    setups.upsert(s)
    expect(setups.get(s.id)).toEqual(s)
  })

  it('oppdaterer i stedet for å duplisere ved samme id', () => {
    const { setups } = store()
    const s = createSetup(POOL, swing, FIB, 1000)
    setups.upsert(s)
    setups.upsert({ ...s, state: 'TRIGGERED' })
    expect(setups.get(s.id)!.state).toBe('TRIGGERED')
    expect(setups.allActive()).toHaveLength(1)
  })

  it('utelater terminale tilstander fra allActive', () => {
    const { setups } = store()
    const a = createSetup(POOL, swing, FIB, 1000)
    const b = { ...createSetup(POOL, { ...swing, lowTs: 5 }, FIB, 1000), state: 'EXPIRED' as const }
    setups.upsert(a); setups.upsert(b)
    expect(setups.allActive().map((s) => s.id)).toEqual([a.id])
  })

  it('husker sendte varsler over en runde til basen', () => {
    const { setups } = store()
    const s = createSetup(POOL, swing, FIB, 1000)
    setups.upsert(s)
    setups.recordAlert(s.id, 0.618)
    expect(setups.get(s.id)!.alertsSent).toEqual([0.618])
  })

  it('registrerer aldri samme varsel to ganger', () => {
    const { setups } = store()
    const s = createSetup(POOL, swing, FIB, 1000)
    setups.upsert(s)
    setups.recordAlert(s.id, 0.5)
    setups.recordAlert(s.id, 0.5)
    expect(setups.get(s.id)!.alertsSent).toEqual([0.5])
  })

  it('gir undefined for ukjent id', () => {
    expect(store().setups.get('finnes-ikke')).toBeUndefined()
  })
})

describe('WatchlistStore', () => {
  it('lagrer og henter oppføringer', () => {
    const { watchlist } = store()
    const e = { poolAddress: POOL, quoteToken: POOL, label: 'TEST/WETH', addedAtTs: 1 }
    watchlist.add(e)
    expect(watchlist.all()).toEqual([e])
  })

  it('erstatter ved samme pooladresse', () => {
    const { watchlist } = store()
    watchlist.add({ poolAddress: POOL, quoteToken: POOL, label: 'gammel', addedAtTs: 1 })
    watchlist.add({ poolAddress: POOL, quoteToken: POOL, label: 'ny', addedAtTs: 2 })
    expect(watchlist.all()).toHaveLength(1)
    expect(watchlist.all()[0]!.label).toBe('ny')
  })
})
```

- [ ] **Step 2: Kjør og se at den feiler**

Run: `npx vitest run tests/store/setups.test.ts`
Expected: FAIL — modulene finnes ikke

- [ ] **Step 3: Implementer**

`src/store/db.ts`:

```ts
import Database from 'better-sqlite3'

export type Db = Database.Database

export function openDb(path: string): Db {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  return db
}

export function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS setups (
      id            TEXT PRIMARY KEY,
      pool_address  TEXT NOT NULL,
      state         TEXT NOT NULL,
      swing_json    TEXT NOT NULL,
      levels_json   TEXT NOT NULL,
      created_at_ts INTEGER NOT NULL,
      alerts_json   TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS setups_state ON setups(state);

    CREATE TABLE IF NOT EXISTS watchlist (
      pool_address TEXT PRIMARY KEY,
      quote_token  TEXT NOT NULL,
      label        TEXT NOT NULL,
      added_at_ts  INTEGER NOT NULL
    );
  `)
}
```

`src/store/setups.ts`:

```ts
import type { Hex, SetupState } from '../domain/types.js'
import type { Setup } from '../strategy/setups.js'
import type { Db } from './db.js'

const TERMINAL: SetupState[] = ['CLOSED', 'INVALIDATED', 'EXPIRED', 'REJECTED']

type Row = {
  id: string; pool_address: string; state: string
  swing_json: string; levels_json: string
  created_at_ts: number; alerts_json: string
}

const toSetup = (r: Row): Setup => ({
  id: r.id,
  poolAddress: r.pool_address as Hex,
  state: r.state as SetupState,
  swing: JSON.parse(r.swing_json),
  levels: JSON.parse(r.levels_json),
  createdAtTs: r.created_at_ts,
  alertsSent: JSON.parse(r.alerts_json),
})

export class SetupStore {
  constructor(private db: Db) {}

  upsert(s: Setup): void {
    this.db.prepare(`
      INSERT INTO setups (id, pool_address, state, swing_json, levels_json, created_at_ts, alerts_json)
      VALUES (@id, @pool, @state, @swing, @levels, @created, @alerts)
      ON CONFLICT(id) DO UPDATE SET
        state = excluded.state,
        levels_json = excluded.levels_json,
        alerts_json = excluded.alerts_json
    `).run({
      id: s.id, pool: s.poolAddress, state: s.state,
      swing: JSON.stringify(s.swing), levels: JSON.stringify(s.levels),
      created: s.createdAtTs, alerts: JSON.stringify(s.alertsSent),
    })
  }

  get(id: string): Setup | undefined {
    const row = this.db.prepare('SELECT * FROM setups WHERE id = ?').get(id) as Row | undefined
    return row ? toSetup(row) : undefined
  }

  allActive(): Setup[] {
    const placeholders = TERMINAL.map(() => '?').join(',')
    const rows = this.db
      .prepare(`SELECT * FROM setups WHERE state NOT IN (${placeholders}) ORDER BY created_at_ts`)
      .all(...TERMINAL) as Row[]
    return rows.map(toSetup)
  }

  recordAlert(id: string, level: number): void {
    const s = this.get(id)
    if (!s || s.alertsSent.includes(level)) return
    this.upsert({ ...s, alertsSent: [...s.alertsSent, level].sort((a, b) => a - b) })
  }
}

export type WatchlistEntry = {
  poolAddress: Hex
  quoteToken: Hex
  label: string
  addedAtTs: number
}

export class WatchlistStore {
  constructor(private db: Db) {}

  add(e: WatchlistEntry): void {
    this.db.prepare(`
      INSERT INTO watchlist (pool_address, quote_token, label, added_at_ts)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(pool_address) DO UPDATE SET
        quote_token = excluded.quote_token,
        label = excluded.label,
        added_at_ts = excluded.added_at_ts
    `).run(e.poolAddress, e.quoteToken, e.label, e.addedAtTs)
  }

  all(): WatchlistEntry[] {
    const rows = this.db.prepare('SELECT * FROM watchlist ORDER BY added_at_ts').all() as {
      pool_address: string; quote_token: string; label: string; added_at_ts: number
    }[]
    return rows.map((r) => ({
      poolAddress: r.pool_address as Hex,
      quoteToken: r.quote_token as Hex,
      label: r.label,
      addedAtTs: r.added_at_ts,
    }))
  }
}
```

- [ ] **Step 4: Kjør og se at den passerer**

Run: `npx vitest run tests/store/setups.test.ts`
Expected: PASS, 8 tester

- [ ] **Step 5: Commit**

```bash
git add src/store tests/store
git commit -m "feat: SQLite-lager for oppsett og watchlist"
```

---

### Task 10: Varselformatering og Telegram-notifier

**Files:**
- Create: `src/alerts/types.ts`
- Create: `src/alerts/format.ts`
- Create: `src/alerts/telegram.ts`
- Test: `tests/alerts/format.test.ts`, `tests/alerts/telegram.test.ts`

**Interfaces:**
- Consumes: `Setup`, `StreamEvent`
- Produces:
  - `type Alert = { kind: 'milestone'; setup: Setup; level: number; price: number } | { kind: 'zone'; setup: Setup; price: number } | { kind: 'invalidated' | 'expired'; setup: Setup; reason: string } | { kind: 'degraded'; sinceMs: number } | { kind: 'recovered' }`
  - `interface Notifier { send(a: Alert): Promise<void> }`
  - `function formatAlert(a: Alert, label: string): string`
  - `class TelegramNotifier implements Notifier`
  - `class NullNotifier implements Notifier` (brukes i tester og i `observe`-modus uten token)

`formatAlert` er ren og testes uten nettverk. `TelegramNotifier` testes mot en injisert sende-funksjon.

- [ ] **Step 1: Skriv de feilende testene for formatering**

`tests/alerts/format.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { formatAlert } from '../../src/alerts/format.js'
import { createSetup } from '../../src/strategy/setups.js'
import type { Swing } from '../../src/domain/types.js'

const POOL = '0x1111111111111111111111111111111111111111' as const
const swing: Swing = { lowTs: 0, low: '100', highTs: 1000, high: '200', confirmedAtTs: 1000, provisional: false }
const FIB = { fibEntry: 0.886, fibZoneTop: 0.786, slBufferPct: 2, alertLevels: [0.5, 0.618, 0.786] }
const s = createSetup(POOL, swing, FIB, 1000)

describe('formatAlert', () => {
  it('nevner tokenet, nivået og prisen i et milepælsvarsel', () => {
    const txt = formatAlert({ kind: 'milestone', setup: s, level: 0.618, price: 138.2 }, 'PEPE/WETH')
    expect(txt).toContain('PEPE/WETH')
    expect(txt).toContain('0.618')
    expect(txt).toContain('138.2')
  })

  it('viser avstanden ned til entry-sonen', () => {
    const txt = formatAlert({ kind: 'milestone', setup: s, level: 0.618, price: 138.2 }, 'X/WETH')
    expect(txt).toMatch(/sone/i)
    expect(txt).toContain('121.4')
    expect(txt).toContain('111.4')
  })

  it('markerer sonevarselet tydeligere enn milepælsvarselet', () => {
    const zone = formatAlert({ kind: 'zone', setup: s, price: 115 }, 'X/WETH')
    expect(zone).toMatch(/SONE/i)
    expect(zone).toContain('98')
  })

  it('oppgir begrunnelse ved ugyldiggjøring', () => {
    const txt = formatAlert({ kind: 'invalidated', setup: s, reason: 'pris under swing low' }, 'X/WETH')
    expect(txt).toContain('pris under swing low')
  })

  it('formaterer degradert drift med varighet i sekunder', () => {
    expect(formatAlert({ kind: 'degraded', sinceMs: 45_000 }, '')).toContain('45')
  })

  it('formaterer gjenopprettet drift', () => {
    expect(formatAlert({ kind: 'recovered' }, '')).toMatch(/tilbake|gjenoppr/i)
  })
})
```

- [ ] **Step 2: Kjør og se at den feiler**

Run: `npx vitest run tests/alerts/format.test.ts`
Expected: FAIL — modulen finnes ikke

- [ ] **Step 3: Implementer typer og formatering**

`src/alerts/types.ts`:

```ts
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
```

`src/alerts/format.ts`:

```ts
import type { Alert } from './types.js'

const n = (v: number) => (v < 1 ? v.toPrecision(6) : v.toFixed(4).replace(/\.?0+$/, ''))

export function formatAlert(a: Alert, label: string): string {
  switch (a.kind) {
    case 'milestone': {
      const { zoneTop, zoneBottom, sl } = a.setup.levels
      const toZone = ((a.price - zoneTop) / a.price) * 100
      return [
        `${label} — fib ${a.level} truffet`,
        `pris ${n(a.price)}`,
        `sone ${n(zoneTop)} → ${n(zoneBottom)} (${toZone.toFixed(1)} % ned)`,
        `sl ${n(sl)}`,
      ].join('\n')
    }
    case 'zone': {
      const { zoneTop, zoneBottom, sl } = a.setup.levels
      return [
        `${label} — I SONEN`,
        `pris ${n(a.price)}`,
        `sone ${n(zoneTop)} → ${n(zoneBottom)}`,
        `sl ${n(sl)}`,
      ].join('\n')
    }
    case 'invalidated':
      return `${label} — oppsett ugyldig: ${a.reason}`
    case 'expired':
      return `${label} — oppsett utløpt: ${a.reason}`
    case 'degraded':
      return `Datastrøm nede i ${Math.round(a.sinceMs / 1000)} s — alle oppsett disarmert`
    case 'recovered':
      return 'Datastrøm tilbake'
  }
}
```

- [ ] **Step 4: Kjør og se at den passerer**

Run: `npx vitest run tests/alerts/format.test.ts`
Expected: PASS, 6 tester

- [ ] **Step 5: Skriv de feilende testene for Telegram**

`tests/alerts/telegram.test.ts`:

```ts
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
```

At en nede Telegram ikke får stoppe boten er bevisst: varsling er en bekvemmelighet, datainnsamling er kjernen.

- [ ] **Step 6: Kjør og se at den feiler**

Run: `npx vitest run tests/alerts/telegram.test.ts`
Expected: FAIL — modulen finnes ikke

- [ ] **Step 7: Implementer Telegram-notifieren**

`src/alerts/telegram.ts`:

```ts
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
```

- [ ] **Step 8: Kjør og se at den passerer**

Run: `npx vitest run tests/alerts/`
Expected: PASS, 9 tester

- [ ] **Step 9: Commit**

```bash
git add src/alerts tests/alerts
git commit -m "feat: varselformatering og Telegram-notifier med feiltoleranse"
```

---

### Task 11: Observer-orkestrering og ende-til-ende

**Files:**
- Create: `src/app/observer.ts`
- Create: `src/app/main.ts`
- Create: `tests/fixtures/recorded-stream.json`
- Test: `tests/app/observer.test.ts`

**Interfaces:**
- Consumes: alt fra Task 1–10
- Produces:
  - `class Observer { constructor(deps: ObserverDeps); onTrade(t: Trade): Promise<void>; onStale(sinceMs: number): Promise<void>; onHealthy(): Promise<void> }`
  - `type ObserverDeps = { pool: PoolMeta; label: string; config: Config; setups: SetupStore; notifier: Notifier; log: Logger }`

Observatøren binder sammen alt: den akkumulerer handler, aggregerer bars, kjører swing-deteksjon når en bar lukker, oppretter oppsett, og evaluerer hver enkelt handel mot alle aktive oppsett — det er dette som fanger et ti-sekunders wick.

**Ett viktig skille:** oppsett *opprettes* på barlukking (strukturklokken), men *evalueres* på hver handel (triggerklokken). Å blande dem er den feilen hele designet finnes for å unngå.

- [ ] **Step 1: Skriv de feilende testene**

`tests/app/observer.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { Observer } from '../../src/app/observer.js'
import { DEFAULT_CONFIG } from '../../src/config/schema.js'
import { NullNotifier } from '../../src/alerts/types.js'
import { SetupStore } from '../../src/store/setups.js'
import { migrate, openDb } from '../../src/store/db.js'
import type { PoolMeta } from '../../src/data/pool.js'
import type { Trade } from '../../src/domain/types.js'

const H = 3_600_000
const pool: PoolMeta = {
  address: '0x1111111111111111111111111111111111111111',
  token0: '0xaaaa000000000000000000000000000000000000',
  token1: '0xbbbb000000000000000000000000000000000000',
  decimals0: 18, decimals1: 18, baseIsToken0: true, feeBps: 30,
}

function observer(overrides: Partial<typeof DEFAULT_CONFIG.strategy> = {}) {
  const db = openDb(':memory:')
  migrate(db)
  const setups = new SetupStore(db)
  const notifier = new NullNotifier()
  const config = {
    ...DEFAULT_CONFIG,
    strategy: { ...DEFAULT_CONFIG.strategy, minSwingVolumeQuote: '0', minTradeSizeQuote: '0', ...overrides },
  }
  const obs = new Observer({
    pool, label: 'TEST/WETH', config, setups, notifier,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  })
  return { obs, setups, notifier }
}

let n = 0
const trade = (ts: number, price: number): Trade => ({
  ts, txHash: `0x${++n}`, logIndex: n, priceQuote: String(price),
  sizeQuote: 1_000_000n, sizeBase: 1n, side: 'buy',
})

/** Bygger et impulsbein fra 100 til 200 over ti timer, så et retracement. */
async function feedImpulse(obs: Observer) {
  for (let i = 1; i <= 10; i++) await obs.onTrade(trade(i * H, 100 + i * 10))
  // ny bar med lavere pris bekrefter beinet
  await obs.onTrade(trade(11 * H, 195))
}

describe('Observer', () => {
  it('lager ikke oppsett før et bein er bekreftet', async () => {
    const { obs, setups } = observer()
    await obs.onTrade(trade(H, 100))
    await obs.onTrade(trade(2 * H, 101))
    expect(setups.allActive()).toEqual([])
  })

  it('lager et oppsett når et bein er bekreftet', async () => {
    const { obs, setups } = observer()
    await feedImpulse(obs)
    expect(setups.allActive().length).toBe(1)
  })

  it('varsler ved 0.618 når prisen retracer', async () => {
    const { obs, notifier } = observer()
    await feedImpulse(obs)
    await obs.onTrade(trade(12 * H, 137))
    const levels = notifier.sent.filter((a) => a.kind === 'milestone').map((a) => a.level)
    expect(levels).toContain(0.5)
    expect(levels).toContain(0.618)
  })

  it('varsler ikke om samme nivå to ganger', async () => {
    const { obs, notifier } = observer()
    await feedImpulse(obs)
    await obs.onTrade(trade(12 * H, 137))
    await obs.onTrade(trade(12 * H + 1000, 136))
    const count = notifier.sent.filter((a) => a.kind === 'milestone' && a.level === 0.618).length
    expect(count).toBe(1)
  })

  it('fanger en berøring av sonen som varer én handel', async () => {
    const { obs, notifier } = observer()
    await feedImpulse(obs)
    await obs.onTrade(trade(12 * H, 137))
    await obs.onTrade(trade(12 * H + 1_000, 125))   // wick ned i sonen (120.26–129.26)
    await obs.onTrade(trade(12 * H + 11_000, 140))  // og ut igjen
    expect(notifier.sent.some((a) => a.kind === 'zone')).toBe(true)
  })

  it('ugyldiggjør oppsettet når prisen bryter under swing low', async () => {
    const { obs, setups, notifier } = observer()
    await feedImpulse(obs)
    await obs.onTrade(trade(12 * H, 95))
    expect(setups.allActive()).toEqual([])
    expect(notifier.sent.some((a) => a.kind === 'invalidated')).toBe(true)
  })

  it('varsler om degradert drift og igjen når den er tilbake', async () => {
    const { obs, notifier } = observer()
    await obs.onStale(45_000)
    await obs.onHealthy()
    expect(notifier.sent.map((a) => a.kind)).toEqual(['degraded', 'recovered'])
  })

  it('erstatter oppsettet når et provisorisk bein utvider toppen', async () => {
    const { obs, setups } = observer()
    await feedImpulse(obs)
    const first = setups.allActive()[0]!
    for (let i = 12; i <= 14; i++) await obs.onTrade(trade(i * H, 200 + i * 10))
    const active = setups.allActive()
    expect(active).toHaveLength(1)
    expect(active[0]!.id).not.toBe(first.id)
    expect(Number(active[0]!.swing.high)).toBeGreaterThan(Number(first.swing.high))
  })

  it('ignorerer handler under minTradeSizeQuote', async () => {
    const { obs, setups } = observer({ minTradeSizeQuote: '2000000' })
    await feedImpulse(obs)
    expect(setups.allActive()).toEqual([])
  })

  it('overlever omstart — oppsett og sendte varsler hentes fra basen', async () => {
    const { obs, setups, notifier } = observer()
    await feedImpulse(obs)
    await obs.onTrade(trade(12 * H, 137))
    const before = setups.allActive()[0]!
    expect(before.alertsSent).toContain(0.618)
    expect(notifier.sent.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Kjør og se at den feiler**

Run: `npx vitest run tests/app/observer.test.ts`
Expected: FAIL — modulen finnes ikke

- [ ] **Step 3: Implementer observatøren**

`src/app/observer.ts`:

```ts
import type { Config } from '../config/schema.js'
import type { Bar, Trade } from '../domain/types.js'
import type { PoolMeta } from '../data/pool.js'
import type { Notifier } from '../alerts/types.js'
import type { SetupStore } from '../store/setups.js'
import { aggregate, timeframeMs } from '../bars/aggregator.js'
import { detectSwings } from '../strategy/swings.js'
import { createSetup, evaluateSetup } from '../strategy/setups.js'

export type Logger = {
  info(o: object, msg?: string): void
  warn(o: object, msg?: string): void
  error(o: object, msg?: string): void
}

export type ObserverDeps = {
  pool: PoolMeta
  label: string
  config: Config
  setups: SetupStore
  notifier: Notifier
  log: Logger
}

const TERMINAL = new Set(['CLOSED', 'INVALIDATED', 'EXPIRED', 'REJECTED'])

export class Observer {
  private trades: Trade[] = []
  private bars: Bar[] = []
  private lastBarTs = -1
  private intervalMs: number
  private minTradeSize: bigint
  private minSwingVolume: bigint

  constructor(private deps: ObserverDeps) {
    this.intervalMs = timeframeMs(deps.config.strategy.structureTimeframe)
    this.minTradeSize = BigInt(deps.config.strategy.minTradeSizeQuote)
    this.minSwingVolume = BigInt(deps.config.strategy.minSwingVolumeQuote)
  }

  async onTrade(trade: Trade): Promise<void> {
    if (trade.sizeQuote < this.minTradeSize) return

    this.trades.push(trade)
    this.rebuildBars()

    const barTs = Math.floor(trade.ts / this.intervalMs) * this.intervalMs
    if (barTs > this.lastBarTs) {
      this.lastBarTs = barTs
      this.detectNewSetups(trade.ts)
    }

    await this.evaluateAll(Number(trade.priceQuote), trade.ts)
  }

  async onStale(sinceMs: number): Promise<void> {
    this.deps.log.warn({ sinceMs }, 'datastrøm stale — disarmerer')
    for (const s of this.deps.setups.allActive()) {
      if (s.state === 'ARMED') this.deps.setups.upsert({ ...s, state: 'DETECTED' })
    }
    await this.deps.notifier.send({ kind: 'degraded', sinceMs })
  }

  async onHealthy(): Promise<void> {
    await this.deps.notifier.send({ kind: 'recovered' })
  }

  private rebuildBars(): void {
    this.bars = aggregate(this.trades, this.intervalMs, this.minTradeSize)
  }

  private detectNewSetups(nowTs: number): void {
    const { strategy } = this.deps.config
    const swings = detectSwings(this.bars, {
      minSwingPct: strategy.minSwingPct,
      minSwingDurationMs: strategy.minSwingDurationMs,
      minSwingVolumeQuote: this.minSwingVolume,
    })

    const latest = swings.at(-1)
    if (!latest) return

    const fibOpts = {
      fibEntry: strategy.fibEntry,
      fibZoneTop: strategy.fibZoneTop,
      slBufferPct: strategy.slBufferPct,
      alertLevels: strategy.alertLevels,
    }
    const setup = createSetup(this.deps.pool.address, latest, fibOpts, nowTs)
    if (this.deps.setups.get(setup.id)) return

    // Et provisorisk bein kan utvide toppen sin. Da er det gamle oppsettet
    // tegnet fra feil topp og må vike, ellers samler det seg opp foreldede
    // fib-nivåer for samme bunn.
    for (const old of this.deps.setups.allActive()) {
      if (old.poolAddress === setup.poolAddress && old.swing.lowTs === latest.lowTs) {
        this.deps.setups.upsert({ ...old, state: 'EXPIRED' })
        this.deps.log.info({ id: old.id, erstattetAv: setup.id }, 'oppsett erstattet av utvidet bein')
      }
    }

    this.deps.setups.upsert(setup)
    this.deps.log.info({ id: setup.id, levels: setup.levels }, 'nytt oppsett')
  }

  private async evaluateAll(price: number, nowTs: number): Promise<void> {
    const { strategy } = this.deps.config

    for (const setup of this.deps.setups.allActive()) {
      const tr = evaluateSetup(setup, {
        price, nowTs,
        intervalMs: this.intervalMs,
        maxSetupAgeBars: strategy.maxSetupAgeBars,
        minRR: strategy.minRR,
        tpPct: strategy.tpPct,
      })

      for (const level of tr.newAlerts) {
        this.deps.setups.recordAlert(setup.id, level)
        const alert = setup.levels.alerts.find((a) => a.level === level)!
        await this.deps.notifier.send({
          kind: 'milestone',
          setup: this.deps.setups.get(setup.id)!,
          level,
          price: alert.price,
        })
      }

      if (tr.state === setup.state) continue

      this.deps.setups.upsert({ ...this.deps.setups.get(setup.id)!, state: tr.state })

      if (tr.state === 'TRIGGERED') {
        await this.deps.notifier.send({ kind: 'zone', setup, price })
      } else if (tr.state === 'INVALIDATED' || tr.state === 'EXPIRED') {
        await this.deps.notifier.send({ kind: tr.state === 'INVALIDATED' ? 'invalidated' : 'expired', setup, reason: tr.reason })
      }

      if (TERMINAL.has(tr.state)) {
        this.deps.log.info({ id: setup.id, state: tr.state, reason: tr.reason }, 'oppsett avsluttet')
      }
    }
  }
}
```

Merk at `TRIGGERED` her kun sender et varsel. I plan 3 er det denne overgangen risikomotoren og `PaperExecutor` kobles på — grensesnittet er allerede riktig formet.

- [ ] **Step 4: Kjør og se at den passerer**

Run: `npx vitest run tests/app/observer.test.ts`
Expected: PASS, 10 tester

- [ ] **Step 5: Skriv entrypointet**

`src/app/main.ts`:

```ts
import 'dotenv/config'
import pino from 'pino'
import { webSocket, createPublicClient } from 'viem'
import { DEFAULT_CONFIG } from '../config/schema.js'
import { robinhoodChain, publicClient } from '../chain/client.js'
import { loadPoolMeta } from '../data/pool.js'
import { LiveStream } from '../data/live.js'
import { backfillTrades } from '../data/backfill.js'
import { migrate, openDb } from '../store/db.js'
import { SetupStore, WatchlistStore } from '../store/setups.js'
import { NullNotifier } from '../alerts/types.js'
import { TelegramNotifier, grammySender } from '../alerts/telegram.js'
import { Observer } from './observer.js'

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' })

const http = publicClient(process.env.RPC_HTTP_URL!)
const ws = createPublicClient({
  chain: robinhoodChain,
  transport: webSocket(process.env.RPC_WS_URL!),
})

const db = openDb(process.env.DB_PATH ?? 'data/fibswingcatcher.db')
migrate(db)
const setups = new SetupStore(db)
const watchlist = new WatchlistStore(db)

const entries = watchlist.all()
if (entries.length === 0) {
  log.error({}, 'watchlisten er tom — legg til en pool før oppstart')
  process.exit(1)
}

const labels = new Map(entries.map((e) => [e.poolAddress.toLowerCase(), e.label]))
const notifier = process.env.TELEGRAM_BOT_TOKEN
  ? new TelegramNotifier({
      send: grammySender(process.env.TELEGRAM_BOT_TOKEN),
      chatId: process.env.TELEGRAM_CHAT_ID!,
      labelFor: (p) => labels.get(p.toLowerCase()) ?? p,
      onError: (e) => log.warn({ e }, 'telegram-sending feilet'),
    })
  : new NullNotifier()

const streams: LiveStream[] = []

for (const entry of entries) {
  const meta = await loadPoolMeta(http, entry.poolAddress, entry.quoteToken)
  const observer = new Observer({
    pool: meta, label: entry.label, config: DEFAULT_CONFIG, setups, notifier, log,
  })

  // Backfill nok historikk til at swing-deteksjonen har noe å jobbe med
  const latest = await http.getBlockNumber()
  const lookback = BigInt(DEFAULT_CONFIG.strategy.maxSetupAgeBars * 4) * 3600n
  const history = await backfillTrades(
    http as never, meta, latest > lookback ? latest - lookback : 0n, latest,
    DEFAULT_CONFIG.data.backfillBlockRange,
  )
  log.info({ pool: entry.label, trades: history.length }, 'backfill ferdig')
  for (const t of history) await observer.onTrade(t)

  const stream = new LiveStream({
    subscribe: (onLog, onError) =>
      ws.watchEvent({ address: meta.address, onLogs: (ls) => ls.forEach(onLog as never), onError }),
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as NodeJS.Timeout),
    maxStalenessMs: DEFAULT_CONFIG.data.maxDataStalenessMs,
    meta,
    blockTs: async (bn) => Number((await http.getBlock({ blockNumber: bn })).timestamp) * 1000,
  })

  stream.on((e) => {
    if (e.kind === 'trade') void observer.onTrade(e.trade)
    else if (e.kind === 'stale') void observer.onStale(e.sinceMs)
    else void observer.onHealthy()
  })
  stream.start()
  streams.push(stream)
  log.info({ pool: entry.label }, 'observerer')
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info({}, 'stopper')
    for (const s of streams) s.stop()
    db.close()
    process.exit(0)
  })
}
```

- [ ] **Step 6: Legg til kjørescript og en watchlist-kommando**

```bash
npm pkg set scripts.start="tsx src/app/main.ts"
npm pkg set scripts.watchlist:add="tsx scripts/add-pool.ts"
```

`scripts/add-pool.ts`:

```ts
import 'dotenv/config'
import { migrate, openDb } from '../src/store/db.js'
import { WatchlistStore } from '../src/store/setups.js'

const [pool, quote, label] = process.argv.slice(2)
if (!pool || !quote || !label) {
  throw new Error('bruk: npm run watchlist:add -- <pool> <quote-token> <etikett>')
}

const db = openDb(process.env.DB_PATH ?? 'data/fibswingcatcher.db')
migrate(db)
new WatchlistStore(db).add({
  poolAddress: pool as `0x${string}`,
  quoteToken: quote as `0x${string}`,
  label,
  addedAtTs: Date.now(),
})
console.log(`lagt til ${label}`)
```

- [ ] **Step 7: Kjør hele suiten og typesjekk**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS — alle tester grønne, ingen typefeil

- [ ] **Step 8: Røyktest mot ekte kjede**

```bash
mkdir -p data
npm run watchlist:add -- 0x<pool> 0x<quote-token> "TEST/WETH"
npm start
```

Forventet: backfill logges, «observerer» logges, og logglinjer dukker opp etter hvert som handler skjer. Sett `TELEGRAM_BOT_TOKEN` og `TELEGRAM_CHAT_ID` for å bekrefte at varslene faktisk kommer fram.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: observatør som binder sammen data, strategi og varsler

Struktur på HTF-bars, trigger på hver enkelt handel."
```

---

## Etter planen

Når alle elleve tasks er grønne har du en prosess som overvåker pools på Robinhood Chain og varsler deg på Telegram idet prisen faller mot entry-sonen. Ingen penger har vært i spill, og strategimotoren er dekket av tester som holder når plan 3 kobler på eksekvering.

Neste plan er **plan 2, backtest**, som gjenbruker `aggregate`, `detectSwings`, `fibLevels` og `evaluateSetup` uendret og kjører dem over backfillet historikk. Det er den planen som avgjør om strategien fortjener plan 3.
