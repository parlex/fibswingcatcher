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
`DB_PATH` (standard `data/fibswingcatcher.db`), `LOG_LEVEL` og `BACKFILL_BARS`
(hvor mange bars historikk som hentes ved oppstart) kan overstyres.

## Sikkerhet

- Boten bruker en dedikert hot wallet som kun finansieres med beløp som tåles tapt
- Ingen test sender noen gang en transaksjon mot mainnet
- Live-modus krever at sjekklisten i designdokumentets seksjon 7 er oppfylt
