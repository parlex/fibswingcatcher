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
  /**
   * Hvor mange bars på strukturtidsrammen som hentes ved oppstart. Eksplisitt
   * felt, ikke avledet av `maxSetupAgeBars`: tilbakeblikket er en driftskostnad
   * (RPC-kall) og har ingenting å gjøre med hvor lenge et oppsett får leve.
   */
  backfillLookbackBars: z.number().int().positive(),
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
    // Målt mot det offentlige endepunktet: eth_getLogs godtar minst 2 000 000
    // blokker i ett kall, men er hardt rate-limitet på *antall* kall. Et stort
    // vindu er derfor billigere enn mange små.
    backfillBlockRange: 500_000,
    backfillLookbackBars: 24,
    reorgDepthBlocks: 20,
  },
}
