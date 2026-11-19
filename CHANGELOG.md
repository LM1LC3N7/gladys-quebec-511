# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Up to three watch zones in Québec, each one a Gladys device: road works in effect, major road works, road
  segments in winter conditions and a summary, from the open data of the Ministère des Transports et de la Mobilité
  durable (Données Québec, CC BY 4.0), no account, no key.
- Scene trigger "New road works in a zone", filtered by zone and restriction (major, minor).
- A button that shows the last read of each zone and the next one.
- Courtesy toward the ministry service: two requests per round for all zones, one at a time, 5 s apart, every 15
  minutes at least; pauses after a 429, a 5xx or another unexpected status, kept across restarts; no read sooner than
  the interval after a restart.
- Each dataset published on its own: a failed one keeps its last values (never 0) and the status says why.
- Store: `countries: ["CA"]` (the integration serves Québec only), so `gladys_version` is `>=5.3.0`.
- Without a believable time (server `Date` more than a day off the Gladys clock, or none with an implausible
  clock), road works are not counted and the status says so; a list without `numberMatched` is never 0.
- `/data` unreadable at start is read again every 10 s; a stop cuts the request in flight; more than 20 new works
  in one read are announced at the next read.
