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
