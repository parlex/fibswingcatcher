# fibswingcatcher

Handelsbot for ERC-20-tokens på Robinhood Chain (chain ID 4663).

Strategi: kjøp når prisen retracer ned i 0.786–0.886-sonen av et bekreftet
impulsbein opp, ta gevinst ved +60 %, stopp under swingbunnen. Struktur beregnes
på høy tidsramme; berøringen av entry-sonen fanges på rå tick-strøm.

**Status: design ferdig, ikke implementert.**

Se [designdokumentet](docs/superpowers/specs/2026-09-08-fibswingcatcher-design.md).

## Sikkerhet

- Boten bruker en dedikert hot wallet som kun finansieres med beløp som tåles tapt
- Ingen test sender noen gang en transaksjon mot mainnet
- Live-modus krever at sjekklisten i designdokumentets seksjon 7 er oppfylt
