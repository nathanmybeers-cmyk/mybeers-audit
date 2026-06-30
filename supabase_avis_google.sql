-- Cache des données Google Business Profile (avis) pour l'Edge Function « avis-google »
-- À exécuter dans Supabase : Dashboard → SQL Editor → New query → coller → Run
-- Ré-exécutable sans erreur (idempotent).

create table if not exists public.gmb_cache (
  cache_key text primary key,       -- 'all' (toutes les fiches)
  data jsonb,                       -- { locations:[…], ts }
  updated_at timestamptz default now()
);

alter table public.gmb_cache enable row level security;

-- L'Edge Function écrit avec la clé service_role (qui ignore RLS) ;
-- on autorise la lecture anonyme au cas où on voudrait lire le cache côté client.
drop policy if exists "anon select gmb_cache" on public.gmb_cache;
create policy "anon select gmb_cache" on public.gmb_cache
  for select using (true);


-- ───────────────────────────────────────────────────────────────────────────
-- Stockage incrémental des avis individuels.
-- À chaque actualisation, la fonction ne récupère chez Google que les avis plus
-- récents que le dernier déjà stocké (update_time), puis recalcule les agrégats
-- sur l'ensemble conservé ici (historique complet, au-delà de la limite Google).
create table if not exists public.gmb_reviews (
  place_id    text not null,
  review_id   text not null,        -- identifiant unique Google de l'avis
  star        int,
  comment     text,
  author      text,
  create_time timestamptz,
  update_time timestamptz,
  has_reply   boolean default false,
  primary key (place_id, review_id)
);
create index if not exists gmb_reviews_place_idx on public.gmb_reviews (place_id);
create index if not exists gmb_reviews_place_update_idx on public.gmb_reviews (place_id, update_time desc);

alter table public.gmb_reviews enable row level security;
-- Écriture par la fonction (service_role, ignore RLS). Lecture anonyme facultative.
drop policy if exists "anon select gmb_reviews" on public.gmb_reviews;
create policy "anon select gmb_reviews" on public.gmb_reviews
  for select using (true);
