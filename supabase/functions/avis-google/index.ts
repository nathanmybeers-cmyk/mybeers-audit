// Edge Function « avis-google »
// Récupère les fiches Google Business Profile de My Beers et leurs avis,
// recalcule ce que l'API ne fournit pas (répartition par étoiles, taux de réponse…)
// et renvoie du JSON propre à l'application. Détient le secret côté serveur.
//
// Déploiement :  supabase functions deploy avis-google --no-verify-jwt
// Secrets requis : GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
// (SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont injectés automatiquement.)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
}

const STAR: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 }
const CACHE_TTL_MS = 6 * 60 * 60 * 1000 // 6 h
const MAX_REVIEWS_PER_LOCATION = 400

// ── OAuth : échange du refresh_token contre un access_token frais ───────────
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

async function cacheGet(key: string): Promise<any | null> {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/gmb_cache?cache_key=eq.${key}&select=data,updated_at`, { headers: sbHeaders })
    const rows = await r.json()
    if (!rows?.[0]) return null
    if (Date.now() - new Date(rows[0].updated_at).getTime() > CACHE_TTL_MS) return null
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
  } catch { /* cache best-effort */ }
}

// ── Pagination générique ─────────────────────────────────────────────────────
async function paginate(baseUrl: string, token: string, field: string, cap = 2000): Promise<any[]> {
  let out: any[] = [], pageToken = ""
  do {
    const url = baseUrl + (baseUrl.includes("?") ? "&" : "?") + (pageToken ? `pageToken=${pageToken}` : "")
    const d = await gget(url, token)
    out = out.concat(d[field] ?? [])
    pageToken = d.nextPageToken ?? ""
  } while (pageToken && out.length < cap)
  return out
}

// ── Construction des données pour toutes les fiches ──────────────────────────
async function buildAll(token: string) {
  // 1) Comptes
  const accounts = await paginate("https://mybusinessaccountmanagement.googleapis.com/v1/accounts", token, "accounts")
  const locations: any[] = []

  for (const acc of accounts) {
    // 2) Établissements du compte
    const locs = await paginate(
      `https://mybusinessbusinessinformation.googleapis.com/v1/${acc.name}/locations?readMask=name,title,storefrontAddress,metadata&pageSize=100`,
      token, "locations",
    )
    for (const loc of locs) {
      // loc.name = "locations/123" → ressource avis = "accounts/X/locations/123"
      const parent = `${acc.name}/${loc.name}`
      let reviews: any[] = []
      let averageRating = 0, totalReviewCount = 0
      try {
        let pageToken = ""
        do {
          const url = `https://mybusiness.googleapis.com/v4/${parent}/reviews?pageSize=50&orderBy=updateTime desc` +
            (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "")
          const d = await gget(url, token)
          reviews = reviews.concat(d.reviews ?? [])
          averageRating = d.averageRating ?? averageRating
          totalReviewCount = d.totalReviewCount ?? totalReviewCount
          pageToken = d.nextPageToken ?? ""
        } while (pageToken && reviews.length < MAX_REVIEWS_PER_LOCATION)
      } catch (e) {
        // fiche sans accès aux avis : on la garde sans données d'avis
        console.warn(`avis ${parent}: ${e instanceof Error ? e.message : e}`)
      }

      // Agrégats recalculés côté serveur
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

      locations.push({
        placeId: loc.metadata?.placeId ?? null,
        resource: parent,
        title: loc.title ?? "",
        address: [loc.storefrontAddress?.locality, loc.storefrontAddress?.postalCode].filter(Boolean).join(" "),
        averageRating: Number(averageRating) || 0,
        totalReviewCount: Number(totalReviewCount) || reviews.length,
        fetchedCount: reviews.length,
        distribution: dist,
        replied,
        responseRate: reviews.length ? Math.round((replied / reviews.length) * 100) : 0,
        negativeNoReply,
        recent,
      })
    }
  }
  return { locations, ts: Date.now() }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })
  try {
    const force = new URL(req.url).searchParams.get("force") === "1"
    if (!force) {
      const cached = await cacheGet("all")
      if (cached) return new Response(JSON.stringify({ ...cached, cached: true }), { headers: { ...CORS, "Content-Type": "application/json" } })
    }
    const token = await getAccessToken()
    const data = await buildAll(token)
    await cachePut("all", data)
    return new Response(JSON.stringify(data), { headers: { ...CORS, "Content-Type": "application/json" } })
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    })
  }
})
