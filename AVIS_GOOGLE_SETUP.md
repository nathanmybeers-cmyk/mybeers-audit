# Mise en service — Avis Google (Edge Function Supabase)

Cette partie nécessite un petit backend (impossible en pur statique : le secret OAuth, le
rafraîchissement des tokens Google et le CORS l'exigent). Tout est prêt côté code ; il reste
ces étapes, à faire **une seule fois**.

---

## 1. Publier l'écran de consentement OAuth (IMPORTANT)

Dans **Google Cloud Console → API et services → Écran de consentement OAuth** :
- Statut de publication : passer de **« Test »** à **« En production »**.

⚠️ Sans ça, le refresh token Google **expire au bout de 7 jours** (c'est pourquoi le
`token_gmb.json` actuel ne fonctionne plus). En production, il reste valide durablement.

---

## 2. Obtenir un refresh token frais

En local, dans le dossier du projet (le script `test_gmb.py` fait déjà le travail) :

```bash
pip3 install google-auth-oauthlib requests
python3 test_gmb.py
```

Une fenêtre Google s'ouvre → se connecter avec le compte **gestionnaire des fiches My Beers**
et accepter. Le fichier `token_gmb.json` est alors régénéré. Récupérer la valeur du champ
`"refresh_token"` à l'intérieur.

---

## 3. Enregistrer les secrets dans Supabase

```bash
# (une fois) lier le projet : supabase link --project-ref kndaguwcpypcmjpkxpbw
supabase secrets set GOOGLE_CLIENT_ID="<client_id>"
supabase secrets set GOOGLE_CLIENT_SECRET="<client_secret>"
supabase secrets set GOOGLE_REFRESH_TOKEN="<refresh_token de l'étape 2>"
```

`client_id` et `client_secret` se trouvent dans le fichier
`Avis Google/client_secret_*.json` (clé `installed` ou `web`).

---

## 4. Créer la table de cache

Dans **Supabase → SQL Editor**, exécuter le contenu de `supabase_avis_google.sql`.

---

## 5. Déployer la fonction

```bash
supabase functions deploy avis-google --no-verify-jwt
```

L'URL devient : `https://kndaguwcpypcmjpkxpbw.supabase.co/functions/v1/avis-google`

`--no-verify-jwt` : la fonction est un proxy en lecture seule, appelée avec la clé anon
publique (déjà dans l'app). Le secret Google, lui, ne quitte jamais le serveur.

---

## 6. Vérifier

```bash
curl "https://kndaguwcpypcmjpkxpbw.supabase.co/functions/v1/avis-google?force=1" \
  -H "apikey: <clé anon Supabase>"
```

Doit renvoyer un JSON `{ "locations": [ … ] }`. Les fiches sans accès gestionnaire
ne remonteront pas (limite Google : il faut être propriétaire/gestionnaire de la fiche).

Une fois ces étapes faites, prévenez-moi : on teste l'onglet « Avis Google » ensemble et
j'ajuste l'affichage selon les données réelles.

---

## Rappel sécurité
- `client_secret_*.json` et `token_gmb.json` sont ignorés par git (jamais déployés).
- Le navigateur n'appelle que l'Edge Function ; il ne voit jamais le secret ni le refresh token.
