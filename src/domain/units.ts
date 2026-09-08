/**
 * Konverterer en menneskelesbar tokenmengde til tokenets egne enheter.
 *
 * Finnes fordi terskler skrives som mennesker tenker («50 WETH») mens kjeden
 * regner i heltall skalert med tokenets desimaler. Blandes de to blir
 * `minTradeSizeQuote: '50'` femti *wei* på et 18-desimalers token, altså
 * ingen terskel i det hele tatt — nøyaktig hullet spec 6.7 mottiltak 1 skulle
 * lukke.
 *
 * Regnet i strenger og bigint, aldri gjennom `Number()`: en terskel på
 * 0,000000000000000001 skal bli 1n, ikke 1e-18.
 */
export function toBaseUnits(amount: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(amount)) {
    throw new Error(`ugyldig mengde: ${JSON.stringify(amount)} — forventet siffer, eventuelt med ett desimalpunkt`)
  }
  const [whole = '', frac = ''] = amount.split('.')
  if (frac.length > decimals) {
    throw new Error(
      `mengden ${amount} har ${frac.length} desimaler, men tokenet har bare ${decimals}`,
    )
  }
  return BigInt(whole + frac.padEnd(decimals, '0'))
}
