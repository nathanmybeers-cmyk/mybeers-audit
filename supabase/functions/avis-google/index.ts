// Edge Function « avis-google »
// Récupère les avis Google Business Profile, UNE FICHE À LA FOIS, en stockant les
// avis dans Supabase de façon INCRÉMENTALE (seuls les avis plus récents que le
// dernier connu sont retéléchargés). Recalcule les agrégats que l'API ne fournit
// pas (répartition par étoiles, taux de réponse) et fait ressortir les points
// négatifs récurrents par mots-clés. Détient le secret côté serveur.
//
// Appels :
//   GET (sans param)        → annuaire léger des fiches [{placeId, title, address}]
//   GET ?place=<placeId>    → données complètes d'une fiche (note, avis, agrégats, points négatifs)
//   &force=1                → ignore le cache résumé (resync incrémentale quand même)
//
// Secrets requis : GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
}

const STAR: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 }
const DIRECTORY_TTL_MS = 24 * 60 * 60 * 1000 // 24 h
const SUMMARY_TTL_MS = 6 * 60 * 60 * 1000    // 6 h
const MAX_FETCH = 2000

// Thèmes des points négatifs (mots-clés en français, accents ignorés)
const THEMES: { key: string; kw: string[] }[] = [
  { key: "Attente / service",        kw: ["attente", "attendre", "attendu", "lent", "lente", "lents", "service", "servi", "serveur", "serveuse", "rapidite", "file", "queue", "patienter", "interminable"] },
  { key: "Prix",                     kw: ["prix", "cher", "chere", "chers", "tarif", "couteux", "arnaque", "qualite prix", "qualite-prix", "ruineux", "abuse"] },
  { key: "Propreté / hygiène",       kw: ["sale", "salete", "proprete", "crasse", "toilette", "hygiene", "collant", "poisseux", "degueulasse", "degoutant"] },
  { key: "Bruit / ambiance",         kw: ["bruit", "bruyant", "sonore", "trop fort", "musique", "ambiance", "assourdissant"] },
  { key: "Accueil / personnel",      kw: ["accueil", "personnel", "desagreable", "agressif", "impoli", "antipathique", "mal recu", "malpoli", "aimable", "froid", "meprisant"] },
  { key: "Qualité bière / produits", kw: ["biere", "bieres", "plate", "eventee", "tiede", "chaude", "gobelet", "plastique", "mousse", "gout", "pression", "fade", "infecte"] },
  { key: "Affluence / place",        kw: ["monde", "bonde", "place", "assis", "debout", "plein", "surcharge", "trop de monde", "serre"] },
  { key: "Organisation / horaires",  kw: ["reservation", "reserve", "organisation", "ferme", "horaire", "commande", "erreur", "oubli", "desorganise"] },
]
const norm = (s: string) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")

async function getAccessToken(): Promise<string> {
  const body = new URLSearchParams({
    client_id: Deno.env.get("GOOGLE_CLIENT_ID") ?? "",
    client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "",
    refresh_token: Deno.env.get("GOOGLE_REFRESH_TOKEN") ?? "",
    grant_type: "refresh_token",
  })
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
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

// ── Supabase REST ────────────────────────────────────────────────────────────
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
      method: "POST", headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify([{ cache_key: key, data, updated_at: new Date().toISOString() }]),
    })
  } catch { /* best-effort */ }
}
async function reviewsMaxUpdate(placeId: string): Promise<number | null> {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/gmb_reviews?place_id=eq.${encodeURIComponent(placeId)}&select=update_time&order=update_time.desc&limit=1`, { headers: sbHeaders })
    const rows = await r.json()
    return rows?.[0]?.update_time ? new Date(rows[0].update_time).getTime() : null
  } catch { return null }
}
async function reviewsUpsert(rows: any[]): Promise<void> {
  if (!rows.length) return
  for (let i = 0; i < rows.length; i += 500) {
    await fetch(`${SB_URL}/rest/v1/gmb_reviews`, {
      method: "POST", headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify(rows.slice(i, i + 500)),
    })
  }
}
async function reviewsAll(placeId: string): Promise<any[]> {
  const r = await fetch(`${SB_URL}/rest/v1/gmb_reviews?place_id=eq.${encodeURIComponent(placeId)}&select=star,comment,author,create_time,update_time,has_reply&order=update_time.desc&limit=${MAX_FETCH}`, { headers: sbHeaders })
  return await r.json()
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

// ── Annuaire : placeId → { resource, title, address } (cache 24 h) ───────────
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
          resource: `${acc.name}/${loc.name}`,
          title: loc.title ?? "",
          address: [loc.storefrontAddress?.locality, loc.storefrontAddress?.postalCode].filter(Boolean).join(" "),
        }
      }
    } catch (e) { console.warn(`locations ${acc.name}: ${e instanceof Error ? e.message : e}`) }
  }
  await cachePut("directory", dir)
  return dir
}

// ── Sync incrémentale : ne télécharge que les avis plus récents que le dernier stocké ──
async function syncReviews(token: string, placeId: string, info: any) {
  const storedMax = await reviewsMaxUpdate(placeId)
  let fresh: any[] = [], averageRating = 0, totalReviewCount = 0, pageToken = "", reached = false
  do {
    const url = `https://mybusiness.googleapis.com/v4/${info.resource}/reviews?pageSize=50&orderBy=updateTime desc` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "")
    const d = await gget(url, token)
    averageRating = d.averageRating ?? averageRating
    totalReviewCount = d.totalReviewCount ?? totalReviewCount
    for (const rv of (d.reviews ?? [])) {
      const ut = rv.updateTime ? new Date(rv.updateTime).getTime() : 0
      if (storedMax !== null && ut <= storedMax) { reached = true; break } // déjà connu → stop
      fresh.push({
        place_id: placeId,
        review_id: rv.reviewId ?? rv.name ?? `${ut}`,
        star: STAR[rv.starRating] ?? null,
        comment: rv.comment ?? null,
        author: rv.reviewer?.displayName ?? "Anonyme",
        create_time: rv.createTime ?? null,
        update_time: rv.updateTime ?? null,
        has_reply: !!rv.reviewReply?.comment,
      })
    }
    pageToken = (!reached && d.nextPageToken) ? d.nextPageToken : ""
  } while (pageToken && fresh.length < MAX_FETCH)
  await reviewsUpsert(fresh)
  return { averageRating, totalReviewCount, newCount: fresh.length, firstSync: storedMax === null }
}

// ── Points négatifs récurrents (mots-clés) ──────────────────────────────────
function negativeThemes(reviews: any[]) {
  const neg = reviews.filter((r) => r.star && r.star <= 3 && r.comment)
  const acc = THEMES.map((t) => ({ key: t.key, count: 0, samples: [] as string[] }))
  for (const r of neg) {
    const c = norm(r.comment)
    THEMES.forEach((t, i) => {
      if (t.kw.some((k) => c.includes(norm(k)))) {
        acc[i].count++
        if (acc[i].samples.length < 2) acc[i].samples.push(String(r.comment).replace(/\s+/g, " ").slice(0, 160))
      }
    })
  }
  return { negativeCount: neg.length, themes: acc.filter((t) => t.count > 0).sort((a, b) => b.count - a.count) }
}

// ── Agrégats sur l'ensemble stocké ───────────────────────────────────────────
function summarize(placeId: string, info: any, stored: any[], sync: any) {
  const dist: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  let replied = 0, negativeNoReply = 0
  for (const rv of stored) {
    const s = rv.star ?? 0
    if (s) dist[s]++
    if (rv.has_reply) replied++
    if (s > 0 && s <= 3 && !rv.has_reply) negativeNoReply++
  }
  const recent = stored.slice(0, 8).map((rv) => ({
    author: rv.author ?? "Anonyme", stars: rv.star ?? 0,
    comment: (rv.comment ?? "").slice(0, 280), date: rv.create_time ?? rv.update_time ?? null,
    replied: !!rv.has_reply,
  }))
  return {
    placeId, title: info.title, address: info.address,
    averageRating: Number(sync.averageRating) || 0,
    totalReviewCount: Number(sync.totalReviewCount) || stored.length,
    fetchedCount: stored.length,
    distribution: dist, replied,
    responseRate: stored.length ? Math.round((replied / stored.length) * 100) : 0,
    negativeNoReply,
    negative: negativeThemes(stored),
    recent, newSinceLast: sync.newCount, ts: Date.now(),
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

    if (!place) {
      const dir = await getDirectory(token, force)
      const list = Object.entries(dir).map(([placeId, v]: [string, any]) => ({ placeId, title: v.title, address: v.address }))
      return json({ locations: list, count: list.length })
    }

    const cacheKey = `loc_${place}`
    if (!force) { const c = await cacheGet(cacheKey, SUMMARY_TTL_MS); if (c) return json({ ...c, cached: true }) }
    const dir = await getDirectory(token, force)
    const info = dir[place]
    if (!info) return json({ error: "Fiche introuvable dans le compte Google (placeId non géré par ce compte)." }, 404)

    const sync = await syncReviews(token, place, info)   // ne télécharge que les nouveaux avis
    const stored = await reviewsAll(place)               // ensemble complet conservé dans Supabase
    const summary = summarize(place, info, stored, sync)
    await cachePut(cacheKey, summary)
    return json(summary)
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
