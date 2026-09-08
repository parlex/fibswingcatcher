import type { Alert, Notifier } from './types.js'

/**
 * En notifier som kan dempes.
 *
 * Finnes for oppstart. Når observatøren mates med backfillet historikk
 * gjenskaper den hele hendelsesforløpet på nytt, inkludert varsler for
 * kursbevegelser som skjedde for timer siden. De skal ikke ut på Telegram —
 * ellers får du en byge av foreldede varsler ved hver omstart.
 *
 * Dempingen stopper bare *utsendingen*. Observatøren registrerer nivåene i
 * basen uansett, så et nivå som alt er passert varsles ikke på nytt når
 * strømmen kommer i gang.
 */
export class MutableNotifier implements Notifier {
  constructor(private inner: Notifier, private muted = false) {}

  mute(): void {
    this.muted = true
  }

  unmute(): void {
    this.muted = false
  }

  async send(a: Alert): Promise<void> {
    if (this.muted) return
    await this.inner.send(a)
  }
}
