# TODO

## Before announcing

- [ ] Install it on a real Gladys 5.3+ and create a zone: device creation, the counters and the summary in the
      dashboard, the scene trigger in the scene editor.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store (after the first release: the store
      validator needs the GHCR image).
- [ ] Store metadata kept out of the manifest (no `keywords` field): keywords Québec 511, travaux routiers, road
      works, conditions routières, winter road conditions, MTMD, Données Québec.

## To confirm over time on the live service

- [ ] Winter conditions during a real storm: on 2026-11-15 the whole province showed only Ds, Dm, PE, E, CND and
      PCND; G and PG (ice) come from the data dictionary, never seen yet.
- [ ] Whether the conditions layer empties out of season (summer) or keeps the last segments; either way the count
      follows what the layer holds.
- [ ] Whether the WFS ever caps a GetFeature (no `count` sent; `numberMatched` equal to the list on 2026-11-15, 448
      segments and 325 works for the whole province). A cap would read as "answer incomplete", never as a count.
- [ ] The throttling of the service (Cloudflare in front): no limit published, no 429 seen.
- [ ] Road warnings (`ms:evenements`, "Avertissement routier") exist on the same WFS but are not published as a
      Données Québec dataset (no licence found on 2026-11-15): left out until the ministry publishes them openly.

## Decisions

- **Version 0.1.0** set by hand in package.json, package-lock.json, the manifest and its `docker_image`
  (`ghcr.io/lm1lc3n7/gladys-quebec-511:0.1.0`).
- **SDK `^0.16.0`**, the latest published (2026-11-15, checked on the npm registry): no change needed for a
  read-only device integration.
- **Source**: only the WFS of the ministry behind the two Données Québec datasets (CC BY 4.0, licence read on
  Données Québec on 2026-11-15). quebec511.info answers 403 to automated clients: never used.
- **Structure from gladys-drivebc** (same author, same shape: zones, pace, pauses, /data, status, scene trigger),
  with the WFS in place of Open511 and two layers in place of pages.
- **One device per zone, id = the slot** (`zone:1..3`): moving a zone keeps the device and its history; the scene
  trigger starts a new baseline for a moved zone (salted fingerprint in `/data`).
- **Two requests per round, whatever the number of zones**: each layer asked once for the box holding every zone
  (WFS `bbox` as an EPSG:4326 URN, latitude first), then the exact circle on our side. The whole province is about
  1.3 MB (conditions) and 0.7 MB (works): a far apart set of zones stays small.
- **Each layer stands alone**: a failed layer leaves its own features unpublished; the summary goes with the works
  (it says "Winter conditions not read" when that layer failed).
- **"In effect"**: start ≤ server time < end; dates without offset read as America/Toronto (checked: a condition
  "en vigueur depuis 04:07:47" in an answer dated 09:19 GMT). Unknown start or end = in effect. A spring-change time
  that does not exist is read with the offset before the change; a fall-back time as its first occurrence.
- **Major** = `entraveType` starting with "Majeure" (matches the red line color of the data, 155 of 325 works).
- **Winter** = a surface code of the data dictionary other than Ds / Dm; an unknown code is neither.
- **Routes**: numbers only (the layers know routes by number); a work or segment without a number never matches a
  route filter.
- **Interval**: 15 to 120 minutes, 15 by default (the lot asked for 15 at least); 5 s between two requests (no
  published limit); pauses 429 15 min doubled, 5xx and other statuses 5 min doubled, all bounded to 6 h.
- **Scene trigger** fresh within 24 h (the works are updated a few times a day, not live like incidents); at most 20
  events per zone and per read.
- **No `location: true`** (the house location is sensitive): the zones are typed in the configuration.
- **No widget, no scene action** in 0.1.0.
- **Default language French** (the data is French first; works titles exist in English too).
- **Test button = last read**: it never reads (the interval holds for it too).
- **/data that cannot tell the last attempt**: the first read waits 15 minutes (the minimum interval) after the
  process start.
- **Checked live on 2026-11-15**: the module code against the real service from the VM (Montréal, Québec City,
  Laurentides), then installed in the sandbox Gladys.
