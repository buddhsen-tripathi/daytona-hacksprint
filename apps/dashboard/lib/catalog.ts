/**
 * Catalog (#7) types + mock data. Shape mirrors CatalogEntry in apps/bot/src/core/contracts.ts.
 */
export type CatalogEntry = {
  id: string;
  title: string;
  kaNumber: string;
  articleUrl: string;
  summary: string;
  agency: string | null;
  topic: string | null;
  channel: string;
  officialUrl: string | null;
  requiresLogin: boolean | null;
  hasCaptcha: boolean | null;
  requiredFields: string[] | null;
  automation: string;
  lastVerifiedAt: string;
};

export type CatalogResponse = { entries: CatalogEntry[]; count: number; source?: string };

const V = "2026-10-15T09:00:00Z";
const ka = (n: string) => `https://portal.311.nyc.gov/article/?kanumber=KA-${n}`;

export const MOCK_CATALOG: CatalogEntry[] = [
  {
    id: "mta-bus-complaint",
    title: "MTA Bus Complaint",
    kaNumber: "KA-01121",
    articleUrl: ka("01121"),
    summary: "Report a problem with an MTA bus, bus operator, or bus service.",
    agency: "MTA",
    topic: "Transportation",
    channel: "external-site",
    officialUrl: "https://contact.mta.info/s/customer-feedback",
    requiresLogin: false,
    hasCaptcha: false,
    requiredFields: ["route", "direction", "occurredAt", "description"],
    automation: "adapter:mta-feedback",
    lastVerifiedAt: V,
  },
  {
    id: "noise-from-neighbor",
    title: "Noise from Neighbor",
    kaNumber: "KA-01012",
    articleUrl: ka("01012"),
    summary: "Report loud music, talking, or other noise from a neighbor's apartment.",
    agency: "NYPD",
    topic: "Noise",
    channel: "nyc311-sr-form",
    officialUrl: "https://portal.311.nyc.gov/sr-step/?id=noise-residential",
    requiresLogin: false,
    hasCaptcha: true,
    requiredFields: null,
    automation: "handoff",
    lastVerifiedAt: V,
  },
  {
    id: "pothole",
    title: "Pothole",
    kaNumber: "KA-01046",
    articleUrl: ka("01046"),
    summary: "Report a pothole on a street or highway.",
    agency: "DOT",
    topic: "Streets",
    channel: "nyc311-sr-form",
    officialUrl: "https://portal.311.nyc.gov/sr-step/?id=pothole",
    requiresLogin: false,
    hasCaptcha: null,
    requiredFields: null,
    automation: "handoff",
    lastVerifiedAt: V,
  },
  {
    id: "heat-or-hot-water",
    title: "Heat or Hot Water",
    kaNumber: "KA-01087",
    articleUrl: ka("01087"),
    summary: "Report no heat or hot water in a residential building.",
    agency: "HPD",
    topic: "Housing",
    channel: "nyc311-sr-form",
    officialUrl: "https://portal.311.nyc.gov/sr-step/?id=heat",
    requiresLogin: true,
    hasCaptcha: false,
    requiredFields: null,
    automation: "none",
    lastVerifiedAt: V,
  },
  {
    id: "missed-collection",
    title: "Missed Trash or Recycling Collection",
    kaNumber: "KA-01150",
    articleUrl: ka("01150"),
    summary: "Report trash, recycling, or compost that was not picked up on schedule.",
    agency: "DSNY",
    topic: "Sanitation",
    channel: "agency-form",
    officialUrl: null,
    requiresLogin: null,
    hasCaptcha: null,
    requiredFields: null,
    automation: "none",
    lastVerifiedAt: V,
  },
];

export function catalogHaystack(e: CatalogEntry) {
  return [e.title, e.agency, e.topic, e.kaNumber, e.id, e.summary].filter(Boolean).join(" ").toLowerCase();
}

/** `?mock=1` responses for /api/catalog and /api/catalog/:id. */
export function mockCatalog(path: string): unknown {
  const [p, qs] = path.split("?");
  const one = p.match(/^\/api\/catalog\/(.+)$/);
  if (one) {
    const e = MOCK_CATALOG.find((x) => x.id === decodeURIComponent(one[1]));
    if (!e) throw new Error("HTTP 404 — catalog entry not found");
    return e;
  }
  const q = new URLSearchParams(qs ?? "").get("q")?.toLowerCase() ?? "";
  const entries = q ? MOCK_CATALOG.filter((e) => catalogHaystack(e).includes(q)) : MOCK_CATALOG;
  return { entries, count: entries.length, source: "mock" } satisfies CatalogResponse;
}

/** /api/catalog/:id may return the entry bare or wrapped ({ entry } / { entries: [e] }). */
export function asEntry(raw: unknown): CatalogEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id === "string" && typeof o.title === "string") return o as unknown as CatalogEntry;
  if (o.entry && typeof o.entry === "object") return o.entry as CatalogEntry;
  if (Array.isArray(o.entries) && o.entries[0]) return o.entries[0] as CatalogEntry;
  return null;
}

export function automationLabel(a: string): { text: string; tone: string } {
  if (a.startsWith("adapter:")) return { text: a.slice(8), tone: "border-go/50 text-go" };
  if (a === "handoff") return { text: "handoff", tone: "border-caution/50 text-caution" };
  return { text: "none", tone: "border-rule2 text-muted" };
}

export function triState(v: boolean | null) {
  return v == null ? "?" : v ? "yes" : "no";
}
