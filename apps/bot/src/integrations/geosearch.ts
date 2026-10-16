/**
 * NYC Planning Labs GeoSearch (Pelias) client + intersection fallback.
 * GeoSearch does not resolve intersections ("Broadway & W 45th St"), so for
 * those we fall back to NYC 311 Open Data itself, whose rows carry
 * intersection_street_1/2 + lat/lon (the city's own geocoding of that corner).
 */
const GEOSEARCH = "https://geosearch.planninglabs.nyc/v2";
const OPEN_DATA = "https://data.cityofnewyork.us/resource/erm2-nwe9.json";
const DEFAULT_TIMEOUT_MS = 6_000;

export type GeoFeature = {
  label: string;
  latitude: number;
  longitude: number;
  borough: string | null;
  housenumber: string | null;
  street: string | null;
  postalcode: string | null;
  confidence: number | null;
  layer: string | null;
  source: "geosearch" | "open-data-intersection";
};

function toFeature(f: any): GeoFeature | null {
  const coords = f?.geometry?.coordinates;
  const p = f?.properties ?? {};
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const [lon, lat] = coords.map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    label: String(p.label ?? p.name ?? ""),
    latitude: lat,
    longitude: lon,
    borough: p.borough ?? null,
    housenumber: p.housenumber ?? null,
    street: p.street ?? null,
    postalcode: p.postalcode ?? null,
    confidence: typeof p.confidence === "number" ? p.confidence : null,
    layer: p.layer ?? null,
    source: "geosearch",
  };
}

async function getJson(url: string, timeoutMs: number, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

export async function geosearchForward(text: string, opts: { size?: number; timeoutMs?: number } = {}): Promise<GeoFeature[]> {
  const url = `${GEOSEARCH}/search?text=${encodeURIComponent(text)}&size=${opts.size ?? 3}`;
  const json = await getJson(url, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return (Array.isArray(json?.features) ? json.features : []).map(toFeature).filter((f: GeoFeature | null): f is GeoFeature => !!f);
}

export async function geosearchReverse(lat: number, lon: number, opts: { timeoutMs?: number } = {}): Promise<GeoFeature | null> {
  const url = `${GEOSEARCH}/reverse?point.lat=${lat}&point.lon=${lon}&size=1`;
  const json = await getJson(url, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const f = Array.isArray(json?.features) ? json.features[0] : null;
  return f ? toFeature(f) : null;
}

// ---------------------------------------------------------------------------
// Intersections
// ---------------------------------------------------------------------------
const SUFFIX: Record<string, string> = {
  st: "STREET", str: "STREET", street: "STREET",
  ave: "AVENUE", av: "AVENUE", avenue: "AVENUE",
  blvd: "BOULEVARD", boulevard: "BOULEVARD",
  rd: "ROAD", road: "ROAD",
  pl: "PLACE", place: "PLACE",
  pkwy: "PARKWAY", parkway: "PARKWAY",
  dr: "DRIVE", drive: "DRIVE",
  ln: "LANE", lane: "LANE",
  ct: "COURT", court: "COURT",
  ter: "TERRACE", terrace: "TERRACE",
  hwy: "HIGHWAY", highway: "HIGHWAY",
  sq: "SQUARE", square: "SQUARE",
  expy: "EXPRESSWAY", expressway: "EXPRESSWAY",
};
const DIRECTION: Record<string, string> = { w: "WEST", west: "WEST", e: "EAST", east: "EAST", n: "NORTH", north: "NORTH", s: "SOUTH", south: "SOUTH" };
const ORDINAL_WORDS: Record<string, string> = { first: "1", second: "2", third: "3", fourth: "4", fifth: "5", sixth: "6", seventh: "7", eighth: "8", ninth: "9", tenth: "10", eleventh: "11", twelfth: "12" };

/** "W 45th St" → "WEST 45 STREET" (the form used in 311 intersection_street_* fields). */
export function normalizeStreetName(raw: string): string {
  const words = raw
    .replace(/[.,]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words
    .map((w, i) => {
      const lw = w.toLowerCase();
      if (i === 0 && DIRECTION[lw] && words.length > 1) return DIRECTION[lw];
      if (i === words.length - 1 && SUFFIX[lw] && words.length > 1) return SUFFIX[lw];
      if (ORDINAL_WORDS[lw]) return ORDINAL_WORDS[lw];
      const ord = lw.match(/^(\d+)(st|nd|rd|th)$/);
      if (ord) return ord[1];
      return w.toUpperCase();
    })
    .join(" ");
}

const BOROUGH_RE = /,?\s*\b(manhattan|brooklyn|queens|bronx|the bronx|staten island|new york|nyc|ny)\b.*$/i;

/** Split "Broadway & W 45th St, Manhattan" → ["Broadway", "W 45th St"] or null. */
export function splitIntersection(text: string): [string, string] | null {
  let t = text.trim().replace(/^(at\s+)?(the\s+)?corner\s+of\s+/i, "").replace(/^(near|at|on)\s+/i, "");
  t = t.replace(BOROUGH_RE, "").replace(/\b\d{5}\b/g, "").trim();
  const parts = t.split(/\s*(?:&|\band\b|\/|@|\bat\b|\bx\b)\s*/i).map((s) => s.trim()).filter(Boolean);
  if (parts.length !== 2) return null;
  return [parts[0], parts[1]];
}

function soqlEscape(s: string) {
  return s.replace(/'/g, "''");
}

export async function intersectionLookup(a: string, b: string, opts: { timeoutMs?: number; appToken?: string } = {}): Promise<GeoFeature | null> {
  const na = soqlEscape(normalizeStreetName(a));
  const nb = soqlEscape(normalizeStreetName(b));
  // Exact match on the normalized names (indexed ⇒ ~1 s); `like` scans are 10 s+.
  const where =
    `((intersection_street_1='${na}' AND intersection_street_2='${nb}') OR ` +
    `(intersection_street_1='${nb}' AND intersection_street_2='${na}')) AND latitude IS NOT NULL`;
  const params = new URLSearchParams({
    $where: where,
    $select: "intersection_street_1,intersection_street_2,latitude,longitude,borough",
    $limit: "15",
  });
  const headers: Record<string, string> = {};
  const token = opts.appToken ?? process.env.NYC_OPEN_DATA_APP_TOKEN;
  if (token) headers["X-App-Token"] = token;
  const rows = await getJson(`${OPEN_DATA}?${params}`, opts.timeoutMs ?? 10_000, headers);
  if (!Array.isArray(rows) || rows.length === 0) return null;
  // Most common coordinate wins (311 geocodes an intersection to one point).
  const counts = new Map<string, { n: number; row: any }>();
  for (const r of rows) {
    const k = `${Number(r.latitude).toFixed(4)},${Number(r.longitude).toFixed(4)}`;
    const c = counts.get(k) ?? { n: 0, row: r };
    c.n++;
    counts.set(k, c);
  }
  const best = [...counts.values()].sort((x, y) => y.n - x.n)[0].row;
  const lat = Number(best.latitude);
  const lon = Number(best.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const boroughRaw = typeof best.borough === "string" ? best.borough : null;
  const borough = boroughRaw && boroughRaw !== "Unspecified" ? boroughRaw.toLowerCase().replace(/\b\w/g, (c: string) => c.toUpperCase()) : null;
  const s1 = String(best.intersection_street_1 ?? "");
  const s2 = String(best.intersection_street_2 ?? "");
  return {
    label: `${s1} & ${s2}${borough ? `, ${borough}` : ""}, NY`,
    latitude: lat,
    longitude: lon,
    borough,
    housenumber: null,
    street: null,
    postalcode: null,
    confidence: null,
    layer: "intersection",
    source: "open-data-intersection",
  };
}
