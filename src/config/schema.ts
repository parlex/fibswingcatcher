import { z } from 'zod'

const pct = z.number().positive().max(100)

/**
 * En tokenmengde slik et menneske skriver den, i quote-tokenets egen enhet —
 * ikke i tokenets minste enhet.
 *
 * Valideringen finnes fordi `z.string()` godtok både `'femti'` og `'50,5'`, og
 * begge kastet en rå `SyntaxError` fra `BigInt()` inne i `Observer`-
 * konstruktøren, altså etter oppstart og langt fra årsaken. Skaleringen til
 * kjedens enheter skjer i `toBaseUnits`, som trenger et tall den kan stole på.
 *
 * **Verdien er pool-avhengig.** Den er i quote-token, og en WETH-pool og en
 * USDC-pool har ikke samme tall for samme mengde penger. Defaultene under er
 * stilt for WETH; peker du boten på en stablecoin-pool må de stilles om, ellers
 * er terskelen enten meningsløst lav eller så høy at ingen handel slipper
 * gjennom. Et prisorakel, som ville gjort USD mulig, hører til plan 3.
 */
const quoteAmount = z.string().regex(/^\d+(\.\d+)?$/, {
  message: 'må være en tokenmengde med siffer og eventuelt ett desimalpunkt, f.eks. "50" eller "0.5"',
})

export const StrategySchema = z.object({
  structureTimeframe: z.enum(['5m', '15m', '1h', '4h']),
  minSwingPct: pct,
  minSwingDurationMs: z.number().int().nonnegative(),
  minSwingVolumeQuote: quoteAmount,
  fibEntry: z.number().gt(0).lt(1),
  fibZoneTop: z.number().gt(0).lt(1),
  tpPct: pct,
  slBufferPct: pct,
  minRR: z.number().positive(),
  maxSetupAgeBars: z.number().int().positive(),
  minTradeSizeQuote: quoteAmount,
  alertLevels: z.array(z.number().gt(0).lt(1)).nonempty(),
}).strict().refine((s) => s.fibZoneTop < s.fibEntry, {
  message: 'fibZoneTop må være grunnere enn fibEntry',
  path: ['fibZoneTop'],
})

export const DataSchema = z.object({
  chainId: z.literal(4663),
  maxDataStalenessMs: z.number().int().positive(),
  backfillBlockRange: z.number().int().positive(),
  /**
   * Strukturvinduet, målt i bars på strukturtidsrammen.
   *
   * Styrer tre ting, med vilje samme tall: hvor mye historikk backfillen
   * henter ved oppstart, hvor mange bars observatøren holder i sitt rullende
   * handelsbuffer, og — som en direkte følge — **det lengste beinet
   * strategien kan se**. Et bein som strekker seg over flere bars enn dette
   * finnes ikke for `detectSwings`, uansett hvor ekte det er.
   *
   * Det er altså ikke bare en driftskostnad (RPC-kall og minne), det er også
   * en strategigrense. Sett den for lavt og boten blir blind for de trege
   * beina; sett den for høyt og oppstarten blir en kjedeskanning.
   *
   * Gulvet på 4: med barjustert klippekant beholdes N+1 bars, og
   * `detectSwings` trenger minst én bar til bunnen, én til bekreftelsen og —
   * etter at klippingen har begynt — én til vinduskanten den nekter å
   * forankre i. Fire bars er det minste som gir deteksjonen noe å jobbe med;
   * 1 gjorde den lydløst død.
   */
  backfillLookbackBars: z.number().int().min(4),
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
    // Se kommentaren på `quoteAmount`: disse er i quote-token, ikke USD, og
    // må stilles om når quote-tokenet ikke er WETH.
    //
    // Specens tall er 10 000 USD og 50 USD. Uttrykt i WETH til ~3 300 USD/ETH
    // blir det ~3 og ~0,015. Målt på poolen røyktesten bruker: 807 handler
    // over 24 bars med medianstørrelse 0,00058 WETH, p90 0,085 og totalt 19,7
    // WETH omsatt. Terskelen 0,015 slipper gjennom om lag 15 % av handlene —
    // halen som faktisk er prisdannelse — mens 50 slapp gjennom **0 av 807**.
    minSwingVolumeQuote: '3',
    fibEntry: 0.886,
    fibZoneTop: 0.786,
    tpPct: 60,
    slBufferPct: 2,
    minRR: 3,
    maxSetupAgeBars: 48,
    minTradeSizeQuote: '0.015',
    alertLevels: [0.5, 0.618, 0.786],
  },
  data: {
    chainId: 4663,
    maxDataStalenessMs: 10_000,
    // Målt mot det offentlige endepunktet: eth_getLogs godtar minst 2 000 000
    // blokker i ett kall, men er hardt rate-limitet på *antall* kall. Et stort
    // vindu er derfor billigere enn mange små.
    backfillBlockRange: 500_000,
    backfillLookbackBars: 24,
    reorgDepthBlocks: 20,
  },
}
