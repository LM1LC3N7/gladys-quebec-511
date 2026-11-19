// -----------------------------------------------------------------------------
// Every text the integration writes, in English and French: the summary of a
// zone (in the language of the configuration), the status and the test
// button (both languages, Gladys picks). Times are shown in Eastern time, the
// time zone of the source; works titles come in both languages, road and
// place names stay as the source writes them.
// -----------------------------------------------------------------------------

import { TIME_ZONE } from './constants.js';

const TEXTS = {
  en: {
    noWorks: 'No road works in effect',
    worksCount: ({ count, major }) =>
      `${count === 1 ? '1 road work' : `${count} road works`} in effect${major > 0 ? ` (${major} major)` : ''}`,
    works: 'road works',
    more: ({ count }) => `${count} more`,
    majorWord: 'major',
    route: ({ route }) => `Route ${route}`,
    winterCount: ({ count }) =>
      count === 1 ? 'Winter conditions on 1 segment' : `Winter conditions on ${count} segments`,
    roadsBare: 'Roads bare',
    noSegment: 'No winter condition segment in the zone',
    conditionsUnread: 'Winter conditions not read',
    worksUnread: 'Road works not read',
    visibilityReduced: 'reduced visibility',
    visibilityNone: 'no visibility',
    zoneDefault: ({ slot }) => `Québec 511 zone ${slot}`,
    worksFeature: 'Road works in effect',
    majorFeature: 'Major road works',
    winterFeature: 'Segments in winter conditions',
    summaryFeature: 'Summary',
  },
  fr: {
    noWorks: 'Aucuns travaux en cours',
    worksCount: ({ count, major }) =>
      `${count === 1 ? '1 chantier en cours' : `${count} chantiers en cours`}${major > 0 ? ` (${major} entrave${major > 1 ? 's' : ''} majeure${major > 1 ? 's' : ''})` : ''}`,
    works: 'travaux',
    more: ({ count }) => `${count} de plus`,
    majorWord: 'majeure',
    route: ({ route }) => `Route ${route}`,
    winterCount: ({ count }) =>
      count === 1
        ? 'Conditions hivernales sur 1 tronçon'
        : `Conditions hivernales sur ${count} tronçons`,
    roadsBare: 'Chaussées dégagées',
    noSegment: 'Aucun tronçon de conditions hivernales dans la zone',
    conditionsUnread: 'Conditions hivernales non lues',
    worksUnread: 'Travaux non lus',
    visibilityReduced: 'visibilité réduite',
    visibilityNone: 'visibilité nulle',
    zoneDefault: ({ slot }) => `Québec 511 zone ${slot}`,
    worksFeature: 'Travaux en cours',
    majorFeature: 'Entraves majeures',
    winterFeature: 'Tronçons en conditions hivernales',
    summaryFeature: 'Résumé',
  },
};

export function t(language, key, params = {}) {
  const text = (TEXTS[language] ?? TEXTS.en)[key];
  return typeof text === 'function' ? text(params) : text;
}

/** A time in Eastern time: "Nov 15, 14:05 ET" / "15 nov., 14 h 05 (heure de l'Est)". */
export function formatTime(ms, language) {
  if (!Number.isFinite(ms)) return '?';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TIME_ZONE,
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  const month = Number(parts.month);
  if (language === 'fr') {
    const months = [
      'janv.',
      'févr.',
      'mars',
      'avr.',
      'mai',
      'juin',
      'juil.',
      'août',
      'sept.',
      'oct.',
      'nov.',
      'déc.',
    ];
    return `${Number(parts.day)} ${months[month - 1]}, ${parts.hour} h ${parts.minute} (heure de l'Est)`;
  }
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return `${months[month - 1]} ${Number(parts.day)}, ${parts.hour}:${parts.minute} ET`;
}

const ERRORS = {
  required: { en: 'is required', fr: 'est obligatoire' },
  not_a_number: { en: 'is not a number', fr: "n'est pas un nombre" },
  outside_qc: {
    en: 'places the zone outside Québec (the data covers Québec only)',
    fr: 'place la zone hors du Québec (les données ne couvrent que le Québec)',
  },
  radius: { en: 'must be between 1 and 300 km', fr: 'doit être entre 1 et 300 km' },
  roads_invalid: {
    en: 'holds something that is not a route number (e.g. 20, A-40, 117)',
    fr: "contient autre chose qu'un numéro de route (ex. 20, A-40, 117)",
  },
  roads_too_many: { en: 'names more than 10 routes', fr: 'nomme plus de 10 routes' },
  name_invalid: {
    en: 'is invalid (60 characters at most, no control character)',
    fr: 'est invalide (60 caractères au plus, sans caractère de contrôle)',
  },
  refresh: {
    en: 'must be a whole number of minutes between 15 and 120 (15 used)',
    fr: 'doit être un nombre entier de minutes entre 15 et 120 (15 utilisé)',
  },
};

/** "Field zone1_latitude is required" in both languages. */
export function configErrors(errors) {
  const line = (lang) =>
    errors
      .map(
        (e) =>
          `${lang === 'fr' ? 'Le champ' : 'Field'} ${e.field} ${ERRORS[e.code]?.[lang] ?? e.code}`,
      )
      .join('; ');
  return { en: line('en'), fr: line('fr') };
}

const FAILURES = {
  network: { en: 'the MTMD service could not be reached', fr: 'service du MTMD injoignable' },
  timeout: {
    en: 'the MTMD service did not answer in time',
    fr: "le service du MTMD n'a pas répondu à temps",
  },
  rate: {
    en: 'the MTMD service asked to slow down (429)',
    fr: 'le service du MTMD demande de ralentir (429)',
  },
  server: { en: 'MTMD server error', fr: 'erreur du serveur du MTMD' },
  http: {
    en: 'unexpected answer from the MTMD service',
    fr: 'réponse inattendue du service du MTMD',
  },
  format: { en: 'MTMD answer not readable', fr: 'réponse du MTMD illisible' },
  unreadable_events: {
    en: 'the MTMD sends features that cannot be read (its format may have changed), nothing published',
    fr: 'le MTMD envoie des données illisibles (son format a peut-être changé), rien publié',
  },
  too_big: { en: 'MTMD answer too large', fr: 'réponse du MTMD trop grande' },
  no_time: {
    en: 'no believable time to judge the road works in effect (server Date missing or more than a day from the Gladys clock), not counted',
    fr: "pas d'heure fiable pour juger les travaux en cours (en-tête Date absent ou à plus d'un jour de l'horloge de Gladys), non comptés",
  },
  incomplete: {
    en: 'MTMD answer incomplete (fewer features than announced)',
    fr: 'réponse du MTMD incomplète (moins de données qu’annoncé)',
  },
};

export function failure(kind, status, lang) {
  const text = FAILURES[kind]?.[lang] ?? FAILURES.http[lang];
  const full = status && kind !== 'rate' ? `${text} (HTTP ${status})` : text;
  return full.charAt(0).toUpperCase() + full.slice(1);
}

/** The bilingual messages of the status and the test button. */
export const M = {
  starting: {
    en: 'Starting: the first read of Québec 511 data comes shortly.',
    fr: 'Démarrage : la première lecture des données Québec 511 arrive sous peu.',
  },
  configRetry: ({ seconds }) => ({
    en: `The configuration could not be read from Gladys; next try in ${seconds} s.`,
    fr: `La configuration n'a pas pu être lue dans Gladys ; nouvel essai dans ${seconds} s.`,
  }),
  noZone: {
    en: 'No valid zone: fill in the latitude and longitude of zone 1.',
    fr: 'Aucune zone valide : renseignez la latitude et la longitude de la zone 1.',
  },
};

export function zoneLabel(zone, language) {
  return zone.name ?? t(language, 'zoneDefault', { slot: zone.slot });
}
