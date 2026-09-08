# fibswingcatcher — designdokument

**Dato:** 2026-09-08
**Status:** Godkjent design, ikke implementert
**Neste steg:** Implementasjonsplan

---

## 1. Formål og avgrensning

En handelsbot som handler ERC-20-tokens on-chain på Robinhood Chain etter en
fibonacci-retracement-strategi: kjøp når prisen retracer ned i 0.786–0.886-sonen
av et bekreftet impulsbein opp, ta gevinst ved +60 %, stopp under swingbunnen.

Boten skal ikke satse hele porteføljen på én handel. Posisjonsstørrelse følger av
fast risiko per handel, begrenset av porteføljevakter og av hva poolen tåler.

**I scope for første versjon:**

- Robinhood Chain (chain ID 4663, Arbitrum-basert L2, EVM, ETH som gass)
- ERC-20-tokens på DEX-er på kjeden (Uniswap m.fl.)
- Semi-automatisk drift: boten varsler og foreslår, mennesket armerer
- Paper trading før live
- Backtest og fork-testing
- Lokalt web-UI for parametere, watchlist, armering og historikk
- Telegram-varsler

**Eksplisitt utenfor scope for første versjon, men designet skal tåle det:**

- Andre kjeder (adaptergrensesnitt finnes, kun én implementasjon)
- Tokeniserte aksjer / RWA
- Full automatikk (`auto`-modus) — grensesnittet finnes, policyen kommer senere
- Smart contract vault for midler (`Signer`-grensesnitt finnes)
- Egen tick-indekser som separat tjeneste

**Teknologi:** TypeScript. viem for RPC og signering, Uniswap SDK for ruting,
SQLite for tilstand, Fastify + React/Vite for UI, anvil for fork-testing.

---

## 2. Strategiens definisjon

### 2.1 To klokker

Strukturen finnes på høy tidsramme; berøringen av entry-sonen kan vare sekunder.
Dette er to uavhengige klokker, og sammenblanding av dem er hovedfeilen designet
unngår.

**Strukturklokke** (default 1h, konfigurerbar). Swing-deteksjon og fib-beregning
kjører på lukkede HTF-bars. Nivåer rekalkuleres ved barlukking, ikke oftere.

**Triggerklokke** (rå trade-strøm). Når et oppsett er armert, sjekkes hver enkelt
swap-event mot nivåene. Ingen aggregering, ingen venting på barlukking.

### 2.2 Swing-deteksjon

ZigZag med terskler. Et svingpunkt bekreftes først når prisen har beveget seg
`minSwingPct` motsatt vei uten å lage nytt ekstrempunkt.

Tre filtre hindrer at støy blir til struktur:

- `minSwingPct` — minste bevegelse som teller som et bein
- `minSwingDurationMs` — et bein som varte sekunder er ikke struktur
- `minSwingVolume` — et bein drevet av noen få små handler er ikke prisdannelse

Deteksjonen er **strengt kausal**. Den bruker aldri en bar som ikke ville
eksistert i sanntid. Dette er en testbar invariant, ikke en intensjon.

### 2.3 Fib-oppsett

Fra et bekreftet impulsbein opp (`swingLow` → `swingHigh`):

```
zoneBottom = swingHigh − fibEntry   × (swingHigh − swingLow)   // 0.886
zoneTop    = swingHigh − fibZoneTop × (swingHigh − swingLow)   // 0.786
sl         = swingLow × (1 − slBufferPct)
tp         = faktiskFyllpris × (1 + tpPct)
```

Entry er en **sone, ikke en linje**. Et fyll hvor som helst mellom `zoneBottom`
og `zoneTop` godtas. Årsaken er on-chain-spesifikk: en enkelt streng prisgrense
reverterer i det øyeblikket wicken snur, som er nøyaktig tilfellet strategien
prøver å fange.

RR beregnes på **faktisk fyllpris**, ikke på nivået det ble siktet mot. Oppsett
med RR under `minRR` forkastes.

Eksempel, bein fra 100 til 200: zoneBottom 111,4, zoneTop 121,4, SL 98,
TP ved fyll på 111,4 er 178,2. Risiko 12 %, gevinst 60 %, RR ≈ 5:1.

### 2.4 Ugyldiggjøring

Et oppsett dør når:

- prisen lukker under `swingLow` — strukturen er brutt (`INVALIDATED`)
- det er eldre enn `maxSetupAgeBars` (`EXPIRED`)
- risikomotoren avviser det ved trigger (`REJECTED`)
- det finnes allerede en åpen posisjon i tokenet

### 2.5 Eksekvering mot et bevegelig mål

Boten kan ikke legge limit-ordre. Den oppdager berøring, sender transaksjon, og
den lander en blokk eller flere senere til en annen pris.

- Trigger på observert pris innenfor sonen
- `amountOutMinimum` settes fra `zoneTop` — en for sen transaksjon **reverterer
  heller enn å fylle utenfor sonen**
- Prisen som brukes til eksekveringsbeslutninger leses fra poolens tilstand rett
  før signering, ikke fra siste bar

Boten vil bomme på mange oppsett. Det er riktig oppførsel: feilmodusen er tapt
gass, ikke dårlig fyll. `fillRate` er derfor en førsteklasses metrikk — er den
svært lav, er strategien ikke handelbar i praksis uansett hvor god backtesten er.

---

## 3. Arkitektur

### 3.1 Prinsipp

Strategi og risiko er rene, deterministiske funksjoner. Bare data og eksekvering
snakker med omverdenen. Alt som er vanskelig å teste er isolert i to adaptere;
alt som avgjør resultatet er aritmetikk som kan kjøres tusen ganger i en test.

### 3.2 Dataflyt

```
Swap-events ──► Trade{ts, pris, volum} ──┬──► BarAggregator ──► HTF Bar[]
  (WS live / backfill)                   │                          │
                                         │                          ▼
                                         │                   SwingDetector
                                         │                (ZigZag + terskler)
                                         │                          │
                                         │                     Swing{hi, lo}
                                         │                          ▼
                                         │                   FibEngine → Setup
                                         │                          │
                                         │                     (armering)
                                         │                          │
                                         └──── tick-trigger ───────►│
                                                                    ▼
                                                              RiskEngine
                                                          (avvis / dimensjoner)
                                                                    │
                                                                    ▼
                                                        Executor (Paper | Live)
                                                                    │
                                                                    ▼
                                                        PositionStore (SQLite)
                                                                    │
                                                             PositionMonitor
                                                          (samme trade-strøm)
```

### 3.3 Moduler

| Modul | Ansvar | Avhenger av |
|---|---|---|
| `chain` | viem-klienter, chain-config, `Signer`-grensesnitt | — |
| `data` | `MarketDataSource`: live WS-strøm + historisk backfill, poolmetadata | `chain` |
| `bars` | `BarAggregator`: trades → bars. Ren | — |
| `strategy` | Swing-deteksjon, fib, signalgenerering. Ren | `bars` |
| `risk` | Sizing, porteføljevakter, likviditetstak, kill switch. Ren | — |
| `execution` | `Executor`: `PaperExecutor`, `LiveExecutor` (swap, approvals, slippage, gass) | `chain`, `data` |
| `portfolio` | Posisjonslager, persistens, oppstartsavstemming | — |
| `alerts` | `Notifier`-grensesnitt, Telegram-implementasjon | — |
| `ui` | Fastify-API + React-dashboard | alle |
| `app` | Orkestrering, config, watchlist, logging | alle |
| `backtest` | Spiller historiske trades gjennom samme motor | `data`, `strategy`, `risk` |

`backtest` er ikke en parallell implementasjon. Den er en annen `MarketDataSource`
pluss `PaperExecutor` rundt nøyaktig samme motor. `PositionMonitor` lytter på den
samme trade-strømmen som entryen, så det finnes ingen separat polling som kan gå
ut av synk med det boten trodde da den kjøpte.

### 3.4 Utvidelsespunkter

Fire grensesnitt, hvert med én implementasjon i dag:

- `MarketDataSource` — RPC-basert i dag, egen indekser eller annen kjede senere
- `Signer` — EOA i dag, smart contract vault eller KMS senere
- `Notifier` — Telegram i dag, Discord/ntfy senere
- `Armer` — menneske i dag, `AutoArmer` med policy senere

---

## 4. Risikomotoren

Risikomotoren har vetorett. Strategimotoren foreslår; risikomotoren bestemmer om
og hvor stort. Den er ren: inn går et signal og et porteføljesnapshot, ut går
enten en avvisning med begrunnelse eller en størrelse.

### 4.1 Sizing

```
riskAmount   = equity × riskPerTradePct
stopDistance = (fyllpris − sl) / fyllpris
notional     = riskAmount / stopDistance
qty          = notional / fyllpris
```

Regnet på faktisk fyllpris. Ellers drifter reell risiko oppover hver gang boten
fyller høyt i sonen.

### 4.2 Porteføljevakter

Alle må passere. Avvisninger logges med grunn.

| Vakt | Default | Beskytter mot |
|---|---|---|
| `maxConcurrentPositions` | 3 | Å være fullt eksponert når markedet snur |
| `maxTotalExposurePct` | 25 % | Korrelert nedside — microcaps faller sammen |
| `maxPerTokenPct` | 10 % | Ett token som går til null |
| `dailyLossLimitPct` | 3 % | En dårlig dag som blir katastrofal |
| `consecutiveLossHalt` | 4 | Regimeskifte du ikke har oppdaget |
| `maxDrawdownPct` | 15 % fra topp | Full stopp, krever manuell restart |

De tre siste er halt-vakter: de stopper nye entries, men **fortsetter å forvalte
åpne posisjoner**. En bot som slutter å passe på sine egne stop losses er
farligere enn en som handler.

### 4.3 Likviditetstak

Binder ofte hardere enn risikoregelen.

- Estimert prispåvirkning ≤ `maxImpactPct` (default 1 %), regnet fra reserver
- Aldri mer enn `maxPoolSharePct` (default 1 %) av reservene
- `minLiquidityUsd` (default 50 000) for i det hele tatt å være i watchlisten
- **Størrelsen dimensjoneres på exiten, ikke entryen.** Salg skjer etter +60 %,
  ofte inn i tynnere forhold. En posisjon med 1 % impact inn og 8 % ut er feil
  dimensjonert.

### 4.4 Token-sikkerhetsport

Kjøres når et token legges i watchlisten, og re-valideres før første kjøp. Dette
er der penger faktisk forsvinner on-chain, mer enn på dårlig timing.

- Honeypot-simulering: `eth_call` et salg **før** kjøp. Kan ikke exiten
  simuleres, handles det ikke.
- Overføringsskatt: simuler kjøp→salg, mål avviket. `maxTokenTaxPct` default 3 %.
- Kontraktsflagg: mint, blacklist, pausbarhet, oppgraderbar proxy, eier ikke
  renounced
- Poolalder og LP-lock

### 4.5 Kostnadsgulv

Gass inn + gass ut + 2 × DEX-gebyr + forventet slippage beregnes før handel.
Overstiger rundturkostnaden `maxRoundTripCostPct` (default 1,5 %) av notional,
avvises handelen. `minNotionalUsd` følger av samme hensyn.

### 4.6 Kill switch

Ett flagg, satt fra UI eller fil, som stopper alle nye entries umiddelbart.
Separat «panic close» lukker i tillegg åpne posisjoner til markedspris. Flagget
sjekkes rett før hver signering, ikke bare i hovedløkken.

### 4.7 Parameter-snapshot

Når en posisjon åpnes, lagres parameterne den ble åpnet med på posisjonen.
Parameterendringer i UI gjelder kun nye oppsett. Uten dette får man posisjoner
uten definert exit-logikk.

### 4.8 Gassreserve

Sizing får aldri røre gassreserven. Boten må til enhver tid ha nok ETH til å
komme seg ut av alle åpne posisjoner.

---

## 5. Driftsmodus, UI og varsler

### 5.1 To akser

**Automatisering:** `observe` → `armed` → `auto`
**Eksekvering:** `paper` → `live`

Innfasing: `observe+paper` → `armed+paper` → `armed+live` (lav kapital) →
`auto+live`. Samme kode hele veien, kun to flagg.

### 5.2 Oppsettets livssyklus

```
DETECTED ──varsel 0.5/0.618/0.786──► (menneske armerer) ──► ARMED
   │                                                          │
   ├── INVALIDATED (lukking under swing low)         pris treffer sone
   ├── EXPIRED (maxSetupAgeBars)                              │
   └── REJECTED (risikomotoren)                               ▼
                                                         TRIGGERED
                                                              │
                                                              ▼
                                                        OPEN ──► CLOSED
```

Uarmerte oppsett gir **kun varsel**. Ingenting skjer med penger uten armering.
Armering utløper automatisk sammen med oppsettet.

### 5.3 Armering som ressursstyring

Armering er ikke bare en sikkerhetsknapp. Den utløser det dyre forarbeidet:

- approval-tx sendes (**ikke** ved handel — en approval først ville kostet wicken)
- calldata forhåndsbygges
- dedikert tick-abonnement åpnes på nettopp den poolen
- nonce holdes varm

Det er dette forarbeidet som gjør at boten rekker et ti-sekunders wick. Å
tick-abonnere på hele watchlisten samtidig er hverken gratis eller raskt.

Derfor blir `auto` billig senere: den er en `AutoArmer` bak samme grensesnitt,
med en policy-funksjon i stedet for et menneske.

### 5.4 Varsler

Telegram, med inline-knapper slik at armering kan skje fra låseskjermen.

Varsles ved: nedoverkryssing av 0.5 → 0.618 → 0.786 → sone, armering, fyll,
TP/SL, utløst vakt, kill switch, degradert drift.

Hver (oppsett, milepæl) varsler **én gang**. Et token som vibrerer rundt 0.618
skal ikke gi tolv varsler.

### 5.5 Dashboard

Servert av bot-prosessen selv, bundet til localhost, ingen separat deploy.
Sanntidsoppdatering via WebSocket.

| Visning | Innhold |
|---|---|
| Watchlist | Tokens, pool, likviditet, status fra sikkerhetsporten, legg til/fjern |
| Oppsett | Live fib-nivåer, avstand til sone i %, tilstand, ARM/DISARM |
| Posisjoner | Åpne posisjoner, live PnL, TP/SL, manuell lukking, panic close |
| Parametere | Globale defaults + per-token-overstyringer |
| Historikk | Lukkede handler, win rate, snitt-RR, realisert R, `fillRate` |
| Backtest | Kjør parametersett mot historikk, sammenlign mot gjeldende |

### 5.6 Regler for parameterredigering

1. Alle endringer valideres mot skjema før lagring
2. Endringer versjoneres med tidsstempel, slik at en resultatendring kan spores
   til parameterendringen som forårsaket den
3. Endringer gjelder kun nye oppsett (se 4.7)

Config lever i SQLite som eneste sannhet. UI-et er en visning på den, og boten
kjører headless uten at UI-et er oppe.

---

## 6. Feilhåndtering

Grunnregel: **degrader til trygt, aldri til gjetting.** En bot som mister
datastrømmen skal slutte å handle, ikke begynne å polle og late som det er
tick-data.

### 6.1 Datastrøm

Heartbeat forventer events eller blokk-headere innen `maxDataStalenessMs`.
Reconnect med backoff, fallback til sekundær RPC. Er ingen kilde frisk lenger enn
terskelen: **alle oppsett disarmeres** og varsel sendes. Sekvenser-nedetid
håndteres likt.

### 6.2 Transaksjoner

| Feil | Håndtering |
|---|---|
| Revert på slippage | Forventet. Telles i `fillRate`. Oppsettet forblir armert. |
| Tx henger | Etter `txTimeoutMs`: erstatt med samme nonce og høyere fee, eller kanseller med selvsending. Aldri hull i nonce-sekvensen. |
| Nonce ute av synk | Resynk fra kjeden før neste signering |
| Tom for ETH | Stopp alle entries, varsle høyt (se 4.8) |

### 6.3 Fyll

Faktisk mottatt mengde leses fra kvitteringen og føres på posisjonen. Aldri den
kvoterte mengden — tokens med overføringsskatt gir systematisk mindre.

### 6.4 Exit som feiler

SL truffet, men salget reverterer gjentatte ganger (likviditet trukket, skatt
hevet, honeypot aktivert). Retry med økende slippage-toleranse opp til
`maxExitSlippagePct`, deretter **stopp**. Posisjonen markeres `STUCK`, varsel
sendes, og den tas ut av equity-grunnlaget for sizing. Å prøve i evighet brenner
gassen som trengs for å redde de øvrige posisjonene.

### 6.5 Krasj og omstart

Ved oppstart avstemmes SQLite mot faktiske tokensaldoer on-chain. Ved
uoverensstemmelse: **stopp nye entries og krev manuell gjennomgang.** Boten
gjetter aldri. Alle handlinger er idempotente og nøklet, så omstart midt i en flyt
ikke gir dobbeltkjøp.

### 6.6 Dataintegritet

Dedupe på `(txHash, logIndex)`. Bars rekalkuleres for de siste N blokkene ved
reorg.

### 6.7 Prismanipulasjon i tynne pools

Reell angrepsvektor: én liten swap kan printe en absurd pris, og noen kan bevisst
wicke en tynn pool ned i sonen for å trigge boter og selge inn i kjøpet.

1. Handler under `minTradeSizeUsd` teller hverken i bar-bygging eller som trigger
2. En sone-berøring valideres mot **poolens spotpris fra reservene**, ikke bare
   mot den printede handelsprisen

### 6.8 Observabilitet

Strukturert JSON-logging. Hver beslutning logges med sine inputs, slik at enhver
handel kan rekonstrueres. Nøkkelmetrikker: `fillRate`, realisert vs. forventet
slippage, gassforbruk, utløste vakter, WS-oppetid. Og en logg over hvorfor boten
**ikke** handlet.

---

## 7. Teststrategi

Utviklingen kjører TDD: testen for hver regel skrives før regelen.

**1 — Enhetstester på den rene kjernen.** Håndbygde fixtures, inkludert formen
nedtrend → dypt wick gjennom 0.886 → rask retur. Property-baserte invarianter:

- realisert risiko overstiger aldri `riskPerTradePct`
- posisjonsstørrelse bryter aldri likviditetstaket
- vaktene er monotone
- swing-deteksjon er strengt kausal: å legge til framtidige bars endrer aldri et
  allerede avgitt signal

**2 — Replay-tester.** Innspilte `Swap`-strømmer fra virkelige pools som
fixtures, med snapshot av motorens beslutninger.

**3 — Backtest med to-lags ærlighet.** HTF-passet finner kandidat-berøringene;
tick-backfill måler faktisk oppholdstid i sonen. Rapporten viser **begge tall**:
optimistisk (anta fyll) og realistisk (fyll kun hvis oppholdstid > latensbudsjett).
Spriket er strategiens egentlige risiko.

Utover trades, win rate, snitt-R, expectancy og max drawdown: **parametersveip**.
Et sett som bare virker ved nøyaktig `minSwingPct: 15` er kurvetilpasset. Målet
er platåer, ikke topper.

**4 — Fork-tester (anvil).** Fork Robinhood Chain og kjør `LiveExecutor` mot
virkelige Uniswap- og tokenkontrakter: approvals, slippage, gassestimering,
revert-håndtering, nonce-erstatning. **Fiendtlige testtokens** deployes — en
honeypot, en med 20 % skatt, en med blacklist — og sikkerhetsporten må avvise
dem. Porten er verdiløs utestet.

**5 — Paper shadow-kjøring.** `armed+paper` mot ekte mainnet-data. Måler det
ingen backtest kan: faktisk fillRate, antall oppsett per uke, og om varslene
kommer tidsnok.

**6 — Live canary.** Lav `riskPerTradePct`, `maxConcurrentPositions: 1`.

**Absolutt regel:** ingen test sender noen gang en transaksjon mot mainnet.
Live-nøkkelen finnes ikke i testmiljøet, håndhevet i CI.

### Klar for live — sjekkliste

- [ ] Backtest viser platå, ikke topp, i parametersveipet
- [ ] `fillRate` målt i paper og over avtalt terskel
- [ ] Fork-tester grønne, inkludert alle fiendtlige tokens
- [ ] Kill switch og `STUCK`-håndtering utløst og verifisert i fork
- [ ] Gassreserve-regelen verifisert: boten kan alltid komme seg ut
- [ ] Oppstartsavstemming testet mot en bevisst uoverensstemmelse

---

## 8. Parameterreferanse

Alle parametere ligger i config med globale defaults og valgfri
per-token-overstyring. Ingen magiske tall i koden.

### Strategi

| Parameter | Default | Beskrivelse |
|---|---|---|
| `structureTimeframe` | `1h` | Tidsramme for swings og fib |
| `minSwingPct` | 15 % | Minste bevegelse som teller som bein |
| `minSwingDurationMs` | 30 000 | Minste varighet på et bein |
| `minSwingVolume` | 10 000 USD | Minste volum i et bein |
| `fibEntry` | 0.886 | Bunn av entry-sonen |
| `fibZoneTop` | 0.786 | Topp av entry-sonen, dårligste fyll |
| `tpPct` | 60 % | Take profit |
| `slBufferPct` | 2 % | Under swingbunnen |
| `minRR` | 3.0 | Minste akseptable RR |
| `maxSetupAgeBars` | 48 | Levetid for oppsett og armering |
| `minTradeSizeQuote` | 50 (quote-token) | Handler under dette ignoreres i bars og som trigger. USD-konvertering innføres med prisorakelet i plan 3. |

### Risiko

| Parameter | Default |
|---|---|
| `riskPerTradePct` | 1 % |
| `maxConcurrentPositions` | 3 |
| `maxTotalExposurePct` | 25 % |
| `maxPerTokenPct` | 10 % |
| `dailyLossLimitPct` | 3 % |
| `consecutiveLossHalt` | 4 |
| `maxDrawdownPct` | 15 % |
| `maxImpactPct` | 1 % |
| `maxPoolSharePct` | 1 % |
| `minLiquidityUsd` | 50 000 |
| `maxTokenTaxPct` | 3 % |
| `maxRoundTripCostPct` | 1,5 % |
| `minNotionalUsd` | 200 USD |
| `gasReserveEth` | 0,01 ETH |

### Eksekvering og drift

| Parameter | Default |
|---|---|
| `maxEntrySlippagePct` | 0,5 % |
| `maxExitSlippagePct` | 1 % start, trappes til 5 % over retries |
| `txTimeoutMs` | 15 000 |
| `maxDataStalenessMs` | 10 000 |
| `automationMode` | `observe` |
| `executionMode` | `paper` |

---

## 9. Kjente begrensninger

- **0.886 + 60 % er en entry/exit-regel, ikke en dokumentert edge.** Designet gjør
  regelen målbar og risikostyrt; det gjør den ikke lønnsom. Backtest og paper
  shadow-kjøring skal avgjøre om den er verdt ekte penger.
- **Fyllrate er den store ukjente.** Et ti-sekunders wick krever at alt går
  perfekt. Er `fillRate` svært lav i paper, må enten latensbudsjettet forbedres,
  sonen utvides, eller strategien forkastes.
- **Hot wallet er akseptert risiko.** Sikkerhetsgrensen er beløpet på walleten,
  ikke kodekvaliteten. Wallet finansieres kun med det som tåles tapt.
- **Backtest på HTF-bars alene er systematisk for optimistisk.** Derfor
  to-lags-ærligheten i seksjon 7.
