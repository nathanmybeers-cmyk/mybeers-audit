# My Beers Audit — guide pour Claude Code

Outil interne de suivi des performances réseaux sociaux / publicités / avis des établissements
My Beers. Ce fichier explique où sont les données et comment les interroger pour répondre à des
questions d'analyse (ex. « compare Advantage+ vs plateformes séparées pour Meyzieu »).

## Architecture (important)

- **Une seule page statique** : `index.html` (HTML + JavaScript natif, pas de build, pas de framework).
  Déployée telle quelle sur Vercel (`mybeers-audit.vercel.app`).
- **Supabase** = base de données + cache + une Edge Function. Sert à stocker la config des
  établissements, le cache des avis Google et les stats « My Beers Officiel ».
- **Meta Graph API** (`graph.facebook.com/v25.0`) = source des données publicitaires et Instagram/Facebook.
  ⚠ **Les données de perf pubs ne sont PAS dans Supabase** : elles se récupèrent en direct via l'API Meta.
- **Google Business Profile** = avis, via l'Edge Function `avis-google`.

## Accès aux données

Supabase (URL + clé anon **publiques**, déjà dans `index.html`, chercher `SUPABASE_URL` / `SUPABASE_KEY`) :

```
GET {SUPABASE_URL}/rest/v1/etablissements?select=*
    headers: apikey: {anon}, Authorization: Bearer {anon}
```

Table `etablissements` (une ligne par établissement) — colonnes clés :
`nom, ville, ad_account_id (act_…), fb_token (token Meta), fb_page_id, filter_page_id,
instagram_account_id, gmb_place_id`. **Le `fb_token` de chaque établissement est lisible ici**
(c'est ce qui permet d'interroger l'API Meta pour cet établissement).

Autres tables : `gmb_reviews` (avis Google stockés), `gmb_cache`, `officiel_cache`, `officiel_snapshots`.

## Interroger l'API Meta Ads (le plus utile pour l'analyse)

Récupérer le token + compte d'un établissement dans `etablissements`, puis :

```
# Perf par plateforme (compte), sur une période
GET act_XXX/insights?fields=spend,reach,impressions,actions,cpm
    &breakdowns=publisher_platform&level=account
    &time_range={"since":"2026-01-01","until":"2026-07-03"}&access_token={fb_token}

# Par ensemble (adset) : ajouter level=adset, fields=…,adset_id,adset_name
# Ciblage d'un ensemble (placements, Advantage+, géo) :
GET ?ids=ADSET_ID,…&fields=targeting{publisher_platforms,targeting_automation,geo_locations}
```

Notions : **couverture** = personnes uniques ; **impressions** = affichages totaux ;
**fréquence** = impressions ÷ couverture ; **CPM** = budget ÷ impressions × 1000.
Advantage+ placements = `targeting.publisher_platforms` absent (Meta répartit seul) ;
diffusion séparée = `publisher_platforms` = `["instagram"]` ou `["facebook"]`.

Limites API connues : `reach` du compte n'est plus renvoyé au-delà d'~12 mois ; insights de compte
Instagram limités à 2 ans / fenêtres de 30 jours.

## Avis Google

Edge Function déployée : `{SUPABASE_URL}/functions/v1/avis-google?place={placeId}` (avec la clé anon
en header). Renvoie note moyenne, répartition étoiles, taux de réponse, avis récents, points
positifs/négatifs. Les avis bruts sont dans la table `gmb_reviews`. Code source :
`supabase/functions/avis-google/index.ts`.

## My Beers Officiel (page nationale)

Config + tokens dans la constante `OFFICIEL` en haut du bloc script d'`index.html`
(compte IG, page FB, compte pub, token longue durée).

## Méthode pour répondre à une question d'analyse

1. Lire la config de l'établissement concerné dans `etablissements` (via la clé anon Supabase).
2. Interroger l'API Meta (ou l'Edge Function avis-google) avec le token récupéré, sur la période demandée.
3. Calculer les indicateurs en Python (curl + json) et interpréter — toujours distinguer
   couverture vs impressions, et signaler les réserves (échantillon faible, doublons de couverture
   quand on somme des reach d'adsets, etc.).

## Conventions

- Toujours répondre en français.
- Rôles de l'app (login dans `index.html`) : `admin` (tout), `animateur` (établissements),
  `community` (uniquement l'onglet My Beers Officiel).
- Les fichiers de secrets Google (`client_secret_*.json`, `token_gmb.json`) et les docs de travail
  (`*.docx`, specs) sont volontairement **hors Git** (voir `.gitignore`).
- Ne jamais committer/exposer de nouveaux secrets.
