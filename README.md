# fibswingcatcher

Handelsbot for ERC-20-tokens på Robinhood Chain (chain ID 4663).

Strategi: kjøp når prisen retracer ned i 0.786–0.886-sonen av et bekreftet
impulsbein opp, ta gevinst ved +60 %, stopp under swingbunnen. Struktur beregnes
på høy tidsramme; berøringen av entry-sonen fanges på rå tick-strøm.

**Status: plan 1 (observatøren) er implementert.** Boten overvåker pools og
varsler på Telegram. Den sender ingen transaksjoner og oppretter ingen
wallet-klient — eksekvering hører til plan 3.

Se [designdokumentet](docs/superpowers/specs/2026-09-08-fibswingcatcher-design.md).

## Kom i gang

```bash
cp .env.example .env          # fyll inn RPC_HTTP_URL, RPC_WS_URL og Telegram-nøkler
npm install
npm test                      # hele suiten
npm run typecheck

# sjekk at poolen faktisk er Uniswap V3 — kjeden huser en blanding
npx tsx scripts/inspect-pool.ts <pool-adresse>

npm run watchlist:add -- <pool-adresse> <quote-token> "ETIKETT"
npm start
```

Miljøvariabler: `RPC_HTTP_URL` og `RPC_WS_URL` er påkrevd. `TELEGRAM_BOT_TOKEN`
og `TELEGRAM_CHAT_ID` er valgfrie — uten dem går varslene ingen steder.
`DB_PATH` (standard `data/fibswingcatcher.db`) og `LOG_LEVEL` kan overstyres.
Hvor mye historikk som hentes ved oppstart styres av
`data.backfillLookbackBars` i `src/config/schema.ts`.

I drift: kjør `tsx src/app/main.ts` direkte, **ikke** gjennom `npm start`. npm
videresender ikke SIGTERM til barneprosessen, så basen lukkes ikke ryddig ved
stopp. `npm start` er greit lokalt, der du avslutter med Ctrl-C.

Oppsett går gjennom tilstandene `DETECTED → TRIGGERED` i denne planen.
`ARMED` — at et oppsett er skarpt og klart til å fylles — hører til en senere
plan sammen med risikomotoren og eksekveringen. Observatøren disarmerer
allerede `ARMED` når datastrømmen blir stale, slik at den delen er på plass
før det finnes noe som armerer.

## Kjente grenser i plan 1

**Ikke pek boten på en stablecoin-priset pool.** Terskelene
`minTradeSizeQuote` og `minSwingVolumeQuote` er denominert i poolens
quote-token, og standardverdiene `0.015` og `3` er satt for WETH. På en
USDC-priset pool betyr `0.015` halvannen cent, og størrelsesfilteret slutter i
praksis å bite — da holder en støvhandel til å ødelegge et gyldig oppsett og
sende deg et falskt varsel. Per-pool-terskler og et USD-orakel hører til plan 3;
inntil da må verdiene settes for hånd per quote-token.

Loggen ved oppstart oppgir `passert` og `filtrertBort`. Er `filtrertBort` null
over tusenvis av handler, biter ikke terskelen på den poolen.

Oppstartstiden vokser med poolens aktivitet: backfillen henter ett
blokk-tidsstempel per unike blokk, sekvensielt, og det utgjør rundt 99 % av
tiden. Batching hører til plan 2.

Selve handelsbehandlingen er derimot bundet — bars vedlikeholdes inkrementelt,
så kostnaden per handel er flat (~50 µs) uansett hvor travel poolen er, og
minnet er 25 bars.

## Sikkerhet

- Boten bruker en dedikert hot wallet som kun finansieres med beløp som tåles tapt
- Ingen test sender noen gang en transaksjon mot mainnet
- Live-modus krever at sjekklisten i designdokumentets seksjon 7 er oppfylt
