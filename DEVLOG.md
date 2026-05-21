# Devlog — mybeers-audit

---

## Session du 28 avril 2026

### 1. Zone audience (ligne dépliable par publication)

**Nouvelle fonctionnalité :** chaque publication dans le tableau affiche désormais une ligne dépliable au clic qui résume le ciblage Meta de la campagne associée (âge, localisation, genre).

Évolutions successives au cours de la session :
- Ajout de la ligne audience dépliable avec données Meta (`f4bc931`)
- Correction du champ genre : `[1,2]` affiché "Tous" au lieu de "Hommes + Femmes" (`266fbcf`)
- Ajout temporaire d'une note disclaimer Advantage+ (`96de7c0`), puis suppression jugée inutile (`1cd598c`)
- Suppression du champ Genre de la ligne audience — donnée jugée non fiable côté API Meta (`f4a168e`)
- Support du ciblage par adresse (`custom_locations`) en plus du ciblage géographique classique (`1cd598c`)

> **Note — Zone d'audience :** quand un établissement cible une ville sans rayon dans Meta, l'API ne retourne pas de champ `radius` — seul le nom de la ville s'affiche (ex : "Carcassonne"). C'est un comportement normal, pas un bug. Si un rayon est configuré (ex : +15km), il s'affiche correctement.

---

### 2. Filtre compte publicitaire partagé

Problème de fond : certains franchisés utilisent un compte publicitaire partagé entre plusieurs pages Facebook. L'outil récupérait alors des campagnes appartenant à d'autres établissements.

Résolution en plusieurs itérations :
- Conservation des campagnes sans `promoted_object` pour ne pas perdre de données (`1a47e0c`)
- Détection automatique des comptes multi-pages → filtre strict par `page_id` (`83cf292`)
- Détection via la config + logs de diagnostic (`b91c1fe`)
- Résolution de l'absence de `promoted_object` sur certaines campagnes en passant par les ad sets (`ba775fa`)
- Double fallback : ad sets + créatifs (`object_story_id`) pour couvrir tous les cas (`076ab68`)
- Fallback sans filtre si 0 résultats après filtrage strict, avec champs créatifs étendus (`6e72303`)
- Extension du filtre au support Instagram (`instagram_account_id`) en plus de Facebook (`104050a`)

---

### 3. Récupération automatique de l'ID Instagram

**Nouvelle fonctionnalité :** bouton dans l'écran de configuration permettant de récupérer automatiquement l'ID Instagram d'un établissement sans avoir à le chercher manuellement.

Étapes de développement :
- Bouton initial récupérant l'ID depuis la page Facebook connectée (`928a52e`)
- Enrichissement : 3 tentatives successives (page, compte connecté, scan des ad sets) (`fe679f6`)
- Passage à 4 tentatives + lien de fallback vers lookup-id.com (`08d84d9`)
- Remplacement du lien fallback par commentpicker.com (lookup-id.com jugé moins fiable) (`975e185`)

---

### 4. Comparatif global des établissements

**Nouvelle fonctionnalité :** classement mensuel de tous les établissements avec persistance des données dans Supabase (`32813bb`).

- Calcul rendu séquentiel pour éviter les erreurs de rate limit Meta (`4ac5007`)
- Ajout d'un bouton "Calculer les manquants" pour compléter un comparatif partiel (`4ac5007`)

---

### 5. Améliorations diverses

| Commit | Changement |
|--------|-----------|
| `76e1462` | Support de plusieurs comptes publicitaires par établissement |
| `d550a3b` | Filtre par type d'événement dans le tableau des publications |
| `3b9ad71` | Détection Sport enrichie : ajout des mots-clés `ligue`, `league` et émoji ⚽ |
| `87dfc2a` | Fix bouton Configurer : `nav('config')` appelé avant `showForm` pour que `form-zone` existe dans le DOM |
| `b339322` | Gestion `QuotaExceededError` localStorage : purge du cache et nouvelle tentative automatique |
| `a219e97` | Suppression des onglets Organique, Page Facebook et Google My Business (simplification de l'interface) |

---

### Nettoyage

- Ajout temporaire de logs de debug pour diagnostiquer les campagnes (`ebe929e`), puis suppression (`0c09c79`)

---

## Session du 20 mai 2026

### Fix filtre par date — campagnes actives sans `date_stop`

**Problème :** Sur Roquebrune (et potentiellement d'autres établissements), le sélecteur "Personnalisé" ne proposait pas les mois 2026, car les campagnes lancées en 2025 et toujours actives n'ont pas de `date_stop`. L'index `yearMonths` et le filtre `getFiltered` utilisaient uniquement `date_start` pour classer les campagnes.

**Tentatives précédentes échouées :**
- Étendre à `[date_start, date_stop || aujourd'hui]` (`7f4ddd5`) → campagnes 2023 sans fin remontaient en 2026
- Conditionner l'extension à `status === 'ACTIVE'` (`c0e3500`) → "Aucune publicité" sur 2026 (cause probable : cache `ads_max` stale ou status non fiable)
- Les deux revertés (`3263414`)

**Solution retenue (`3bc7741`) :** nouvelle fonction `campEnd(r)` :
- Si `date_stop` existe → l'utiliser tel quel
- Sinon → plafonner à `date_start + 366 jours`, maximum aujourd'hui

Résultat : campagne Oct 2025 sans fin → couvre jusqu'à Mai 2026 ✅. Campagne 2023 sans fin → plafonnée à Juin 2024, n'apparaît pas en 2026 ✅.

`campEnd()` est appelée dans `yearMonths` (sélecteur dropdown) et dans `getFiltered` (filtre année et mois).

> **Note :** si le cache `ads_max` d'un établissement est stale, les campagnes récentes peuvent manquer même après ce fix. Forcer un rechargement des données Meta si le sélecteur reste vide.

---

### Fix sélecteur mois récents — campagnes absentes du dropdown

**Problème :** sur certains établissements (Étoile, Roquebrune), les mois récents (ex : avril–mai 2026) n'apparaissaient pas dans le sélecteur "Personnalisé" malgré des campagnes actives.

Trois causes identifiées et corrigées en séquence :

**1. Cache `ads_max` stale** — `ads_max` peut avoir été créé avant le lancement des campagnes récentes. `date_preset=maximum` de l'API Meta omet parfois les campagnes récentes sur certains comptes.
- Remplacement de `date_preset=maximum` par un `time_range` explicite `2018 → aujourd'hui` (`9f4529d`)
- Puis correction : la limite API Meta est 37 mois → passage à 36 mois glissants (`ce7a4d6`)

**2. `ads_30d` exclu du sélecteur en mode `max`** — `renderDash` passait `ads_max` comme `data` ET `allData`, donc `ads_30d` (qui contient les campagnes récentes) n'était jamais fusionné dans le dropdown.
- `renderAdsTab` lit désormais `ads_30d` directement depuis le cache et fusionne son contenu dans `sourceForSelect` (`5aaac66`)
- Fallback dans `getFiltered` sur `ads_30d` quand `ads_max` est vide pour le mois/année demandé (`5e0761b`)

**3. Bouton "Personnalisé" remplacé par un date range picker** — pour permettre de charger n'importe quelle période sans être limité par le cache existant.
- Modale avec deux champs date (début / fin) + bouton Valider (`b4192a0`)
- `loadAds` supporte le format `range:YYYY-MM-DD:YYYY-MM-DD` → appel API Meta direct avec `time_range` explicite
- `renderDash` charge `ads_30d` en parallèle si absent du cache lors de l'ouverture du dashboard

---

### Comparatif global — refonte complète

**Problème d'origine :** le comparatif existant calculait les données mois par mois (séquentiel, lent), stockait en Supabase avec une clé par mois, et `computeMonthMetrics` filtrait par `date_start` dans le mois — excluant les campagnes démarrées avant mais actives sur la période.

**Refonte en trois temps :**

**1. Nouveau flow UX** (`5fc7d13`)
- Landing page : sélecteur d'année (3 dernières) puis multi-sélection de mois (max 12)
- Chargement séquentiel par établissement avec spinner par ligne → données affichées au fur et à mesure
- Colonnes triables à tout moment pendant le chargement

**Architecture stockage deux niveaux :**
- localStorage : cache 7 jours des données brutes Meta (clé `ads_range:since:until`)
- Supabase `comparatif_mensuel` : résultats agrégés, clé période `"2026-01~2026-03"`
- Un seul appel Meta par établissement pour toute la plage ; mois déjà en Supabase → aucun appel Meta

**2. Données correctes par établissement** (`1115155`)
- `computeRangeMetrics` remplace `computeMonthMetrics` : travaille directement sur les données retournées par l'API Meta (déjà filtrées par `time_range` + `page_id`), sans re-filtrer par `date_start`
- Clé Supabase = période complète (`"2026-01~2026-03"`) au lieu de mois individuels — élimine les incohérences d'agrégation

**3. Bouton "Recalculer"** (`1f55f55`)
- Disponible dans le topbar (admin uniquement)
- Supprime les entrées Supabase pour la période, vide le cache localStorage, re-fetch depuis Meta avec `force=true`
- Résout les établissements (Orléans Sud/Fleury, Montargis, Chambray) dont les données Supabase avaient été calculées avec l'ancienne logique sans filtre `page_id`

---

## Session du 21 mai 2026

### Sélection de période

*Comparatif global*

- Année **2026** présélectionnée par défaut à l'ouverture du comparatif
- Bouton **Changer la période** redessiné : vert, positionné à côté du titre/sous-titre, hauteur calée sur celle du bloc titre
- Bouton **Recalculer** (admin) déplacé à droite dans le topbar, séparé du bouton de navigation

---

### Filtres par type (`3341b12`)

*Comparatif global*

Barre de boutons colorés au-dessus du tableau (Apéro Quiz, Apéro Concert, Soirée, Sport). Cliquer sur un type affiche uniquement les métriques de ce type pour chaque établissement ; cliquer **Tous** réinitialise.

- Les boutons utilisent les couleurs `TYPE_COLORS` (amber/vert/rouge/bleu) avec opacité réduite quand inactif
- L'ordre alphabétique est préservé pendant le filtrage
- **Bug `JSON.stringify` — RÉSOLU :** `JSON.stringify(t)` injectait des guillemets doubles dans `onclick="..."`, cassant le gestionnaire. Remplacé par `data-ctype` + `this.dataset.ctype`.

---

### Nouvelles colonnes FB / IG / FB+IG (`3341b12`)

*Comparatif global*

Détection de la plateforme par campagne (même logique que la page établissement) :
- Objectif `Événement` → **FB**
- Objectif `Trafic` ou `"instagram"` dans le nom de campagne → **IG**
- Reste → **FB+IG**

Trois colonnes ajoutées au comparatif, couleurs page établissement (bleu/rose/violet). Stockées dans `metriques` + `par_type` en Supabase.

---

### Suppression score global et colonne Activité (`a4b304e`)

*Comparatif global*

- Score global (agrégat des 3 scores) et colonne Activité supprimés
- Tri alphabétique par défaut (`localeCompare fr`) ; conservé lors du filtrage par type
- Card tableau `padding:0;overflow:hidden` → fond `bg3` cols 1-2 atteint les bords du bloc
- Suppression de `sortComparatif`, `compSortCol`, `compSortAsc`

**Refactoring architecture :**
- `par_type` stocké dans Supabase avec les métriques globales → filtrage par type depuis le cache sans rappel Meta
- `_metricsFromTypedRows` extrait pour calculer les métriques sur des lignes déjà typées (évite un re-typage hors contexte)

---

### Correctifs visuels et restauration colonnes qualité (`d5094c5`)

*Comparatif global*

- Colonnes **Durée**, **Budget cible**, **Objectif** (avec %) restaurées après retrait involontaire
- `padding-top: 1rem` sur `thead` pour ne plus être collé au bord du bloc
- Fond `bg3` cols 1-2 via CSS `nth-child(-n+2)` — couvre `thead`, `tbody` et hover ; `border-right` sur col 2 comme séparateur
- Titres FB/IG/FB+IG colorés dans le `<th>` uniquement
- Cellules FB : fond bleu · IG : fond rose · FB+IG : fond violet (`--purple-bg`/`--purple-tx`)

> **Note :** un clic sur "Recalculer" est nécessaire pour les établissements dont les entrées Supabase ont été créées avant cette session — elles n'ont pas encore `par_type` ni `nb_fb/nb_ig/nb_fb_ig`.
