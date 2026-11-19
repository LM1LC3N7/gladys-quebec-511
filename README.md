# gladys-quebec-511

Unofficial [Gladys Assistant](https://gladysassistant.com) integration for **Québec 511** data: road works (with
their restrictions) and winter road conditions on the Québec road network, read from the open data of the Ministère
des Transports et de la Mobilité durable du Québec ([Données Québec](https://www.donneesquebec.ca/), CC BY 4.0), on
its public WFS service. No account, no API key.

> This integration is not an official source. Before you drive, check [Québec 511](https://www.quebec511.info/)
> itself.

Source: Ministère des Transports et de la Mobilité durable du Québec, datasets "Travaux routiers" and "Condition
routière hivernale du réseau routier", Données Québec, CC BY 4.0. Not endorsed by the ministry.

- Up to three watch zones (a circle of 1 to 300 km, optionally limited to some route numbers), one Gladys device
  each: road works in effect, major road works, segments in winter conditions (counters) and a summary (text,
  French or English).
- A scene trigger "New road works in a zone" (filters: zone, major or minor restriction).
- Two requests per round (one per dataset, for the box of all zones), 5 s apart, every 15 to 120 minutes; pauses
  after a 429, a 5xx or another unexpected status, kept across restarts.
- Tested against the real ministry service on 2026-11-15; never tested by a user in Québec.
- Québec only: the manifest declares `countries: ["CA"]` (Gladys 5.3.0 or later).

User documentation: [English](docs/en.md), [français](docs/fr.md).

## Development

```bash
npm install
npm test               # node --test (virtual clock, scripted WFS; two tests on a sped-up real clock)
npm run lint
npm run format:check
node scripts/cover.mjs cover.png
```

Tests never reach the Internet: real answers of the WFS captured on 2026-11-15 around Montréal (geometries thinned)
are in `test/fixtures/`, and the real-clock tests serve them from a local HTTP server.

## License

Apache-2.0, see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
