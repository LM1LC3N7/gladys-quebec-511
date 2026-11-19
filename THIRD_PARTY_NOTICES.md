# Third-party notices

## Données Québec: Ministère des Transports et de la Mobilité durable du Québec

The integration reads, at run time, the public WFS service of the ministry
(https://ws.mapserver.transports.gouv.qc.ca/swtq), layers `ms:chantiers_mtmdet` and `ms:conditions_routieres`: the
source of the Données Québec datasets "Travaux routiers"
(https://www.donneesquebec.ca/recherche/dataset/travaux-routiers) and "Condition routière hivernale du réseau
routier" (https://www.donneesquebec.ca/recherche/dataset/condition-routiere-hivernale-du-reseau-routier-mtq), both
published under the Creative Commons Attribution 4.0 International licence (CC BY 4.0,
https://creativecommons.org/licenses/by/4.0/). Licence checked on Données Québec on 2026-11-15.

Attribution:

> Source: Ministère des Transports et de la Mobilité durable du Québec, Données Québec, CC BY 4.0.

Changes: the integration keeps the features inside the user's zones, counts them and writes a short summary; the
test fixtures `test/fixtures/montreal-works.json` and `test/fixtures/montreal-conditions.json` are real answers of
that service (2026-11-15) whose line geometries were thinned to 12 points.

No code of the ministry is used: the client is written from the WFS capabilities of the service, the data dictionary
published on Données Québec, and the observed answers. The integration is not endorsed by the ministry nor by
Québec 511.

## gladys-testkit

`test/kit/clock.mjs` is copied from gladys-testkit (Apache-2.0, same author as this repository).

## npm dependencies

The only runtime dependency is `@gladysassistant/integration-sdk` (Apache-2.0); its license ships in
`node_modules/@gladysassistant/integration-sdk/LICENSE` of the image.
