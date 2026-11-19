# Québec 511 (travaux routiers et conditions routières hivernales)

Intégration non officielle. Elle lit deux jeux de données ouvertes du **ministère des Transports et de la Mobilité
durable du Québec** (MTMD), publiés sur [Données Québec](https://www.donneesquebec.ca/) : les **travaux routiers**
(avec leurs entraves) et les **conditions routières hivernales** du réseau. Elle les lit sur le service WFS public du
ministère (`ws.mapserver.transports.gouv.qc.ca`), la source des deux jeux. Sans compte ni clé d'API.

> Cette intégration n'est pas une source officielle. Avant de prendre la route, consultez
> [Québec 511](https://www.quebec511.info/). Les données peuvent avoir du retard sur la route, et l'intégration peut
> manquer des travaux ou un changement de conditions.

Source : Ministère des Transports et de la Mobilité durable du Québec, jeux de données « Travaux routiers » et
« Condition routière hivernale du réseau routier », Données Québec, sous licence CC BY 4.0
(https://creativecommons.org/licenses/by/4.0/deed.fr). L'intégration ne modifie pas les données : elle les filtre par
zone et les résume. Elle n'est pas approuvée par le ministère.

## Ce que vous obtenez

Jusqu'à **trois zones de surveillance**, chacune un appareil Gladys. Une zone est un cercle autour d'un point (1 à
300 km), éventuellement limité à certains numéros de routes (« 20, 40, 117 »).

Chaque appareil de zone a :

| Fonction                          | Type     | Sens                                                                    |
| --------------------------------- | -------- | ----------------------------------------------------------------------- |
| Travaux en cours                  | compteur | Les travaux dont la période couvre l'heure actuelle, dans la zone       |
| Entraves majeures                 | compteur | Ceux dont l'entrave est « Majeure » dans les données                    |
| Tronçons en conditions hivernales | compteur | Les tronçons de la zone dont la chaussée est enneigée, durcie ou glacée |
| Résumé                            | texte    | Les travaux (majeurs d'abord, puis par distance), puis les tronçons     |

Le résumé est écrit dans la langue choisie dans la configuration (français par défaut, ou anglais) : les titres des
travaux viennent du ministère dans les deux langues ; les noms de lieux restent tels que le ministère les écrit.

**En cours** veut dire : le début des travaux est passé et leur fin ne l'est pas, par rapport à l'heure du serveur du
ministère (en-tête `Date` de sa réponse). Les dates des données n'ont pas de fuseau : elles sont lues à l'heure du
Québec (heure de l'Est, heure avancée comprise). Des travaux prévus plus tard ne sont comptés qu'à leur début. Les
données donnent une période, pas les heures de chaque jour : des travaux « en semaine » ou « de nuit » comptent pour
toute leur période. Des travaux dont le début ou la fin ne se lit pas comptent comme en cours ; quand plus de la
moitié des travaux ont de telles dates, le jeu est refusé (son format a changé) et rien n'est compté. Sans en-tête
`Date`, l'horloge de Gladys sert, si elle est plausible. Une `Date` à plus d'un jour de l'horloge de Gladys (l'une des
deux est fausse), ou pas de `Date` avec une horloge non plausible : les travaux ne sont pas comptés du tout (jamais
tous ceux de la liste), et le statut le dit.

**Conditions hivernales** : les codes d'état de la chaussée du dictionnaire de données du ministère. « Dégagée et
sèche » et « Dégagée et mouillée » ne sont pas des conditions hivernales ; partiellement enneigée, enneigée,
partiellement couverte de neige durcie, couverte de neige durcie, partiellement glacée et glacée le sont. Un code
inconnu n'est compté ni d'un côté ni de l'autre. Le ministère publie cette couche pendant la saison hivernale ; hors
saison, ou si aucun tronçon n'est couvert, le compte est 0 et le résumé dit « Aucun tronçon de conditions hivernales
dans la zone ». Une visibilité réduite ou nulle est écrite dans le résumé à côté d'un tronçon en conditions hivernales (pas pour une chaussée dégagée).

**Rien plutôt que 0** : une réponse qui n'est pas une liste complète (page d'erreur, liste coupée, liste dont plus de
la moitié des entrées est illisible) n'est jamais publiée comme 0. Chacun des deux jeux de données est indépendant :
quand l'un échoue, ses fonctions gardent leur dernière valeur, le statut dit pourquoi, et l'autre est quand même
publié. Le résumé suit les jeux lus : il dit « Travaux non lus » ou « Conditions hivernales non lues » pour celui
qui a échoué. Une liste sans le compte que le service envoie toujours (`numberMatched`) est prise comme coupée,
jamais comme 0.

## Déclencheur de scène : « Nouveaux travaux dans une zone »

Déclenché quand des travaux en cours apparaissent pour la première fois dans une zone et ont commencé ou été mis à jour
dans les dernières 24 heures (heure du serveur). Filtres : zone, entrave (majeure, mineure). Variables : numéro de
route (vide s'il n'y en a pas), titre des travaux (français et anglais), localisation, entrave, direction et type
d'entrave (français), majeure (oui/non), début et fin (UTC, ISO 8601), distance au centre de la zone (km),
identifiant des travaux du ministère.

Il n'est pas déclenché par la première lecture d'une zone, ni après que vous avez déplacé une zone (nouveau centre,
rayon ou routes) : cette lecture apprend seulement ce qui est déjà là. Il n'est pas déclenché quand aucune heure n'est crue (voir plus haut). Au
plus 20 événements par zone et par lecture : les autres viennent avec la lecture suivante (s'ils ont encore moins
de 24 heures).

## Configuration

1. **Langue du résumé** : français ou anglais.
2. **Intervalle de lecture** : 15 à 120 minutes (15 par défaut).
3. **Zone 1** (obligatoire), zones 2 et 3 (facultatives, laissées vides pour les désactiver) : un nom, la latitude et
   la longitude du centre (degrés décimaux, au Québec), le rayon en km (20 par défaut), et éventuellement les routes
   à garder, en numéros séparés par des virgules (« 20, 40, 117 » ; « A-20 », « R-117 », « autoroute 20 » ou
   « route 117 » marchent aussi). Avec des routes, les travaux et tronçons sans numéro de route (rues locales,
   certains ponts) sont laissés de côté.

Un champ refusé est nommé dans le statut (la valeur saisie n'y est pas répétée).

Le bouton **Voir la dernière lecture** dit ce qu'a donné la dernière lecture de chaque zone et quand vient la
suivante. Il n'interroge pas le service du ministère.

## Rythme et courtoisie envers le service du ministère

- Deux requêtes par tour (travaux, puis conditions hivernales), quel que soit le nombre de zones : chacune ne demande
  que la boîte qui contient toutes les zones. Une requête à la fois, 5 secondes au moins entre les débuts de deux
  requêtes.
- Un tour par intervalle, 15 minutes au moins, mesuré depuis le début du tour précédent.
- Pas de lecture plus tôt après un redémarrage, une reconnexion à Gladys, une configuration enregistrée sans
  changement, une Découverte ou le bouton de test (l'heure de la dernière tentative est gardée dans `/data`, et en
  mémoire) ; déplacer une zone lit tout de suite, 5 secondes après la dernière requête.
- Quand `/data` ne peut pas dire la dernière tentative (fichier illisible, date dans le futur, `/data` non
  inscriptible ou qui ne répond pas en 2 secondes), la première lecture attend 15 minutes après le démarrage, et le
  statut le dit ; un `/data` illisible est relu toutes les 10 secondes, et ce qu'il garde (pause, travaux déjà vus)
  revient dès qu'il se lit ; un `/data` qui cesse plus tard d'être inscriptible est dit aussi : un redémarrage peut
  alors lire plus tôt.
- Après un **429** (« trop de requêtes »), toutes les lectures font une pause de 15 minutes, puis 30, 60… jusqu'à
  6 heures ; après une erreur du serveur (**5xx**) ou un autre statut inattendu (400, 403, 404…), de 5 minutes, puis
  10, 20… jusqu'à 6 heures ; un `Retry-After` plus long est respecté, jusqu'à 6 heures. Un refus qui arrive pendant
  l'enregistrement de la configuration, ou une reconnexion de Gladys, lance quand même la pause. La pause est gardée
  dans `/data` d'un redémarrage à l'autre ; le doublement repart de zéro après une lecture réussie.
- User-Agent `gladys-quebec-511/<version> (+https://github.com/LM1LC3N7/gladys-quebec-511)`.
- Une réponse est coupée après 30 secondes ou 8 Mo (toute la province fait environ 1,3 Mo).

Le service n'offre ni `ETag` ni `Last-Modified` : chaque tour relit les données. Les jeux sont mis à jour en continu ;
lire plus souvent que toutes les 15 minutes n'apporterait rien.

## Statut

L'écran de configuration montre, pour chaque zone, les comptes de la dernière lecture et son heure (heure de l'Est),
ou, pour chaque jeu de données en échec, pourquoi et l'heure de ses dernières données. Des données de plus de 2 heures
sont dites périmées. L'intégration est montrée connectée quand la dernière lecture d'au moins un jeu d'une zone a
réussi il y a moins de 2 heures.

## Vie privée

Les coordonnées de vos zones restent dans la configuration de Gladys. Le service du ministère reçoit la boîte autour
de vos zones (leurs cercles y tiennent). Le fichier `/data` garde l'heure de la dernière tentative, la pause, et par
zone les identifiants des travaux déjà vus avec une empreinte salée de la zone, pas ses coordonnées.

## Limites

- Québec seulement (le centre de la zone doit être au Québec ; les données près des frontières sont incluses).
- Testée avec le vrai service du ministère le 2026-11-15 (Montréal, Québec, Laurentides) ; jamais testée par un
  utilisateur au Québec, ni pendant une tempête (ce jour-là, tous les tronçons autour de Montréal étaient dégagés).
- Les avertissements routiers (incidents, fermetures annoncées sur Québec 511) ne font pas partie de ces données
  ouvertes et ne sont pas lus.
- Le site quebec511.info lui-même n'est pas lu (il refuse les clients automatisés) ; seul le service de données
  ouvertes l'est.
