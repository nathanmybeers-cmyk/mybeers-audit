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
