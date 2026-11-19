// -----------------------------------------------------------------------------
// What a zone sees in a read: the road works in effect now (server time) and
// the winter road condition segments, inside its circle and, when the user
// named routes, on one of them. Works sorted major first, then by distance;
// counted; summed up in a short text in the user's language.
// -----------------------------------------------------------------------------

import { MAX_COUNT, SUMMARY_MAX } from './constants.js';
import { distanceKm } from './geo.js';
import { inEffect } from './wfs.js';
import { t } from './i18n.js';

const onRoads = (zone, route) => zone.roads.length === 0 || zone.roads.includes(route);

/**
 * The works of a zone: `[{ work, distanceKm }]`, sorted. `at` is the server
 * time of the answer (`null`: every listed work is in effect).
 */
export function matchWorks(zone, works, at) {
  const matches = [];
  for (const work of works) {
    if (!inEffect(work, at)) continue;
    if (!onRoads(zone, work.route)) continue;
    const distance = distanceKm(zone, work.lines);
    if (!(distance <= zone.radiusKm)) continue;
    matches.push({ work, distanceKm: distance });
  }
  matches.sort(
    (a, b) =>
      Number(b.work.major) - Number(a.work.major) ||
      a.distanceKm - b.distanceKm ||
      (a.work.id < b.work.id ? -1 : 1),
  );
  return matches;
}

/** The condition segments of a zone: `[{ segment, distanceKm }]`, winter first. */
export function matchConditions(zone, segments) {
  const matches = [];
  for (const segment of segments) {
    if (!onRoads(zone, segment.route)) continue;
    const distance = distanceKm(zone, segment.lines);
    if (!(distance <= zone.radiusKm)) continue;
    matches.push({ segment, distanceKm: distance });
  }
  matches.sort(
    (a, b) =>
      Number(b.segment.winter === true) - Number(a.segment.winter === true) ||
      a.distanceKm - b.distanceKm ||
      (a.segment.id < b.segment.id ? -1 : 1),
  );
  return matches;
}

const bound = (n) => Math.min(n, MAX_COUNT);

export function workCounts(matches) {
  return {
    works: bound(matches.length),
    major: bound(matches.filter((m) => m.work.major).length),
  };
}

/** Segments with snow or ice on the road; an unknown code is never counted. */
export function winterCount(matches) {
  return bound(matches.filter((m) => m.segment.winter === true).length);
}

export function formatKm(km, language) {
  const rounded = km < 10 ? Math.round(km * 10) / 10 : Math.round(km);
  return `${String(rounded).replace('.', language === 'fr' ? ',' : '.')} km`;
}

const routeLabel = (route, language) => t(language, 'route', { route });

/** One line per work: "Route 40: Planage et revêtement (majeure), 3,2 km". */
export function describeWork(match, language) {
  const { work } = match;
  const where = work.route !== null ? routeLabel(work.route, language) : work.place || '?';
  const title = (language === 'en' ? work.titleEn : '') || work.title || t(language, 'works');
  const major = work.major ? ` (${t(language, 'majorWord')})` : '';
  const sep = language === 'fr' ? ' : ' : ': ';
  return `${[...where].slice(0, 80).join('')}${sep}${title}${major}, ${formatKm(match.distanceKm, language)}`;
}

/** One line per winter segment: "Route 117: Partly Snow Covered, visibility reduced". */
export function describeSegment(match, language) {
  const { segment } = match;
  const where = segment.route !== null ? routeLabel(segment.route, language) : segment.road || '?';
  const sep = language === 'fr' ? ' : ' : ': ';
  let text = `${where}${sep}${segment.surfaceText[language] || segment.surface}`;
  if (segment.visibility === 'R' || segment.visibility === 'N') {
    text += `, ${t(language, segment.visibility === 'N' ? 'visibilityNone' : 'visibilityReduced')}`;
  }
  return text;
}

/**
 * The summary text of a zone, bounded to SUMMARY_MAX characters. `conditions`
 * is null when the conditions layer could not be read.
 */
export function summary(works, conditions, language) {
  const parts = [];
  const c = workCounts(works);
  parts.push(
    c.works === 0
      ? t(language, 'noWorks')
      : t(language, 'worksCount', { count: c.works, major: c.major }),
  );
  const lines = works.map((m) => describeWork(m, language));
  let tail;
  if (conditions === null) tail = [t(language, 'conditionsUnread')];
  else {
    const winter = conditions.filter((m) => m.segment.winter === true);
    if (winter.length > 0) {
      tail = [
        t(language, 'winterCount', { count: winter.length }),
        ...winter.map((m) => describeSegment(m, language)),
      ];
    } else if (conditions.length > 0) tail = [t(language, 'roadsBare')];
    else tail = [t(language, 'noSegment')];
  }
  // The works first, then the conditions: each list cut with "N more" when long.
  return fit([parts[0], ...lines], tail, language);
}

function fit(head, tail, language) {
  const join = (list) => list.join(' · ');
  const cut = (list, room) => {
    const [first, ...items] = list;
    let text = first;
    let shown = 0;
    for (const item of items) {
      const rest = items.length - shown - 1;
      const more = rest > 0 ? ` · ${t(language, 'more', { count: rest })}` : '';
      if ([...`${text} · ${item}${more}`].length > room) break;
      text += ` · ${item}`;
      shown += 1;
    }
    const rest = items.length - shown;
    if (rest > 0) text += ` · ${t(language, 'more', { count: rest })}`;
    return text;
  };
  const tailText = cut(tail, Math.floor(SUMMARY_MAX / 3));
  const headText = cut(head, SUMMARY_MAX - [...tailText].length - 3);
  return [...join([headText, tailText])].slice(0, SUMMARY_MAX).join('');
}
