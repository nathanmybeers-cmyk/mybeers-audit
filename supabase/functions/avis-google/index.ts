// Edge Function « avis-google »
// Récupère les avis Google Business Profile, UNE FICHE À LA FOIS (rapide), et
// recalcule ce que l'API ne fournit pas (répartition par étoiles, taux de réponse…).
// Détient le secret côté serveur.
//
// Appels :
//   GET (sans param)        → annuaire léger des fiches [{placeId, title, address}]
//   GET ?place=<placeId>    → données complètes d'une fiche (note, avis, agrégats)
//   &force=1                → ignore le cache
//
// Secrets requis : GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
// (SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont injectés automatiquement.)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
}

const STAR: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 }
const DIRECTORY_TTL_MS = 24 * 60 * 60 * 1000 // 24 h
const LOCATION_TTL_MS = 6 * 60 * 60 * 1000   // 6 h
const MAX_REVIEWS = 400

async function getAccessToken(): Promise<string> {
  const body = new URLSearchParams({
    client_id: Deno.env.get("GOOGLE_CLIENT_ID") ?? "",
    client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "",
    refresh_token: Deno.env.get("GOOGLE_REFRESH_TOKEN") ?? "",
    grant_type: "refresh_token",
  })
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  })
  if (!r.ok) throw new Error(`OAuth refresh ${r.status} : ${await r.text()}`)
  return (await r.json()).access_token as string
}

async function gget(url: string, token: string): Promise<any> {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  const j = await r.json()
  if (!r.ok) throw new Error(`${url.split("?")[0]} → ${r.status} : ${JSON.stringify(j).slice(0, 200)}`)
  return j
}

// ── Cache Supabase (table gmb_cache) ────────────────────────────────────────
const SB_URL = Deno.env.get("SUPABASE_URL") ?? ""
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
const sbHeaders = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" }

async function cacheGet(key: string, ttl: number): Promise<any | null> {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/gmb_cache?cache_key=eq.${encodeURIComponent(key)}&select=data,updated_at`, { headers: sbHeaders })
    const rows = await r.json()
    if (!rows?.[0]) return null
    if (Date.now() - new Date(rows[0].updated_at).getTime() > ttl) return null
    return rows[0].data
  } catch { return null }
}
async function cachePut(key: string, data: unknown): Promise<void> {
  try {
    await fetch(`${SB_URL}/rest/v1/gmb_cache`, {
      method: "POST",
      headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify([{ cache_key: key, data, updated_at: new Date().toISOString() }]),
    })
  } catch { /* best-effort */ }
}

async function paginate(baseUrl: string, token: string, field: string, cap = 2000): Promise<any[]> {
  let out: any[] = [], pageToken = ""
  do {
    const url = baseUrl + (baseUrl.includes("?") ? "&" : "?") + (pageToken ? `pageToken=${encodeURIComponent(pageToken)}` : "")
    const d = await gget(url, token)
    out = out.concat(d[field] ?? [])
    pageToken = d.nextPageToken ?? ""
  } while (pageToken && out.length < cap)
  return out
}

// ── Annuaire : placeId → { resource, title, address } (mis en cache 24 h) ────
async function getDirectory(token: string, force: boolean): Promise<Record<string, any>> {
  if (!force) { const c = await cacheGet("directory", DIRECTORY_TTL_MS); if (c) return c }
  const accounts = await paginate("https://mybusinessaccountmanagement.googleapis.com/v1/accounts", token, "accounts")
  const dir: Record<string, any> = {}
  for (const acc of accounts) {
    try {
      const locs = await paginate(
        `https://mybusinessbusinessinformation.googleapis.com/v1/${acc.name}/locations?readMask=name,title,storefrontAddress,metadata&pageSize=100`,
        token, "locations",
      )
      for (const loc of locs) {
        const placeId = loc.metadata?.placeId
        if (!placeId) continue
        dir[placeId] = {
          resource: `${acc.name}/${loc.name}`, // accounts/X/locations/Y
          title: loc.title ?? "",
          address: [loc.storefrontAddress?.locality, loc.storefrontAddress?.postalCode].filter(Boolean).join(" "),
        }
      }
    } catch (e) { console.warn(`locations ${acc.name}: ${e instanceof Error ? e.message : e}`) }
  }
  await cachePut("directory", dir)
  return dir
}

// ── Avis + agrégats d'UNE fiche ──────────────────────────────────────────────
async function getLocation(token: string, placeId: string, info: any) {
  let reviews: any[] = [], averageRating = 0, totalReviewCount = 0, pageToken = ""
  do {
    const url = `https://mybusiness.googleapis.com/v4/${info.resource}/reviews?pageSize=50&orderBy=updateTime desc` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "")
    const d = await gget(url, token)
    reviews = reviews.concat(d.reviews ?? [])
    averageRating = d.averageRating ?? averageRating
    totalReviewCount = d.totalReviewCount ?? totalReviewCount
    pageToken = d.nextPageToken ?? ""
  } while (pageToken && reviews.length < MAX_REVIEWS)

  const dist: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  let replied = 0, negativeNoReply = 0
  for (const rv of reviews) {
    const s = STAR[rv.starRating] ?? 0
    if (s) dist[s]++
    const hasReply = !!rv.reviewReply?.comment
    if (hasReply) replied++
    if (s > 0 && s <= 3 && !hasReply) negativeNoReply++
  }
  const recent = reviews.slice(0, 8).map((rv) => ({
    author: rv.reviewer?.displayName ?? "Anonyme",
    stars: STAR[rv.starRating] ?? 0,
    comment: (rv.comment ?? "").slice(0, 280),
    date: rv.createTime ?? rv.updateTime ?? null,
    replied: !!rv.reviewReply?.comment,
  }))
  return {
    placeId, title: info.title, address: info.address,
    averageRating: Number(averageRating) || 0,
    totalReviewCount: Number(totalReviewCount) || reviews.length,
    fetchedCount: reviews.length,
    distribution: dist, replied,
    responseRate: reviews.length ? Math.round((replied / reviews.length) * 100) : 0,
    negativeNoReply, recent, ts: Date.now(),
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })
  const json = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } })
  try {
    const url = new URL(req.url)
    const place = url.searchParams.get("place")
    const force = url.searchParams.get("force") === "1"
    const token = await getAccessToken()

    // Sans paramètre : annuaire léger (pas d'avis) — pour lister les fiches dispo
    if (!place) {
      const dir = await getDirectory(token, force)
      const list = Object.entries(dir).map(([placeId, v]: [string, any]) => ({ placeId, title: v.title, address: v.address }))
      return json({ locations: list, count: list.length })
    }

    // Avec ?place= : données complètes d'une seule fiche
    const cacheKey = `loc_${place}`
    if (!force) { const c = await cacheGet(cacheKey, LOCATION_TTL_MS); if (c) return json({ ...c, cached: true }) }
    const dir = await getDirectory(token, force)
    const info = dir[place]
    if (!info) return json({ error: "Fiche introuvable dans le compte Google (placeId non géré par ce compte)." }, 404)
    const data = await getLocation(token, place, info)
    await cachePut(cacheKey, data)
    return json(data)
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
