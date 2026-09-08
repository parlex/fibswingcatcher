/**
 * Nytt forsøk med voksende pause, for RPC-kall.
 *
 * Finnes fordi det offentlige endepunktet på Robinhood Chain svarer 429 når
 * kallene kommer tett, og både backfillen og den levende strømmen må tåle det.
 * Modulen er delt mellom dem: den levende strømmens `blockTs` døde tidligere av
 * ett enkelt nettverkshikk, i en prosess som skal stå i dagevis.
 */

export type RetryInfo = {
  attempt: number
  delayMs: number
  error: unknown
}

export type RetryOpts = {
  /** Antall forsøk før feilen slippes videre. */
  maxAttempts?: number
  /** Første pause. Dobles for hvert nye forsøk. */
  baseDelayMs?: number
  /** Injiserbar for testene, slik at de ikke må vente i sanntid. */
  sleep?: (ms: number) => Promise<void>
  /**
   * Kalles før hver pause. Uten den ser en 429-storm ut som en oppstart som
   * bare er treg, og det er nettopp forskjellen man trenger å se.
   */
  onRetry?: (info: RetryInfo) => void
  /**
   * Feil som ikke skal prøves på nytt fordi svaret blir det samme — typisk
   * «spørringen ga for mange treff». Kalleren eier gjenkjenningen, siden hva
   * feilen ser ut som er transportspesifikt.
   */
  isPermanent?: (e: unknown) => boolean
}

export const DEFAULT_MAX_ATTEMPTS = 5
export const DEFAULT_BASE_DELAY_MS = 500

/**
 * Tak på pausen.
 *
 * Med standardverdiene bindes den aldri: fem forsøk gir 500, 1000, 2000 og
 * 4000 ms, altså 7,5 sekunder til sammen. Taket finnes for kallere som setter
 * `maxAttempts` høyere — fra og med det åttende forsøket ville doblingen
 * ellers gått fra et halvt minutt til flere minutter per pause.
 */
export const MAX_DELAY_MS = 30_000

const nap = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function resolveRetry(opts: RetryOpts): Required<RetryOpts> {
  return {
    maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    baseDelayMs: opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    sleep: opts.sleep ?? nap,
    onRetry: opts.onRetry ?? (() => {}),
    isPermanent: opts.isPermanent ?? (() => false),
  }
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const r = resolveRetry(opts)
  let delay = r.baseDelayMs
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (e) {
      // Permanente feil skal ikke prøves på nytt — de skal håndteres.
      if (r.isPermanent(e)) throw e
      if (attempt >= r.maxAttempts) throw e
      r.onRetry({ attempt, delayMs: delay, error: e })
      await r.sleep(delay)
      delay = Math.min(delay * 2, MAX_DELAY_MS)
    }
  }
}
