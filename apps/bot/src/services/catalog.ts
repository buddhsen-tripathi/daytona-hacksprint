/**
 * NYC311 category catalog (#7) — load + retrieval for the two-stage router (#8).
 * Stage 1 here: BM25 keyword search over title / summary / topic / agency, with a
 * small synonym table mapping residents' words onto 311 vocabulary. No embedder
 * exists yet (#4), so this is the keyword-only fallback the issue allows.
 * Stage 2 (the LLM pick among these candidates) lives in classifier.ts.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CatalogEntry } from "../core/contracts.js";
import { REPO_ROOT } from "../integrations/env.js";

export const CATALOG_SNAPSHOT = resolve(REPO_ROOT, "fixtures/nyc311-catalog.json");

let cached: { entries: CatalogEntry[]; byId: Map<string, CatalogEntry>; index: Index } | null = null;

/** The committed snapshot, validated once and kept in memory. */
export function loadCatalog(path = CATALOG_SNAPSHOT): CatalogEntry[] {
  return catalogState(path).entries;
}

export function getCatalogEntry(id: string | null | undefined): CatalogEntry | null {
  return id ? (catalogState().byId.get(id) ?? null) : null;
}

/** Tests / scripts: use these entries instead of the snapshot. */
export function setCatalogForTests(entries: CatalogEntry[] | null) {
  cached = entries ? build(entries) : null;
}

function catalogState(path = CATALOG_SNAPSHOT) {
  if (!cached) {
    const raw = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as unknown[]) : [];
    cached = build(raw.flatMap((e) => {
      const r = CatalogEntry.safeParse(e);
      return r.success ? [r.data] : [];
    }));
  }
  return cached;
}

// ---------------------------------------------------------------------------
// BM25 over weighted fields
// ---------------------------------------------------------------------------
const STOP = new Set(
  "a an and are as at be been but by can for from has have i if in into is it its me my of on or our so that the their there they this to was we were what when where which who will with you your about just there's it's im i'm dont don't get got near outside next front still been being very really".split(" "),
);

/** Resident phrasing → words the 311 titles/summaries actually use. */
const SYNONYMS: Record<string, string[]> = {
  rat: ["rodent"], rats: ["rodent"], mice: ["rodent"], mouse: ["rodent"], roach: ["pest"], roaches: ["pest"], cockroach: ["pest"], bedbug: ["bed", "bug"], bugs: ["pest"],
  loud: ["noise"], music: ["noise"], party: ["noise"], barking: ["noise", "dog"], noisy: ["noise"], blasting: ["noise"],
  car: ["vehicle"], cars: ["vehicle"], truck: ["vehicle"], parked: ["parking", "illegal"], parking: ["parking", "illegal"], double: ["parking"], hydrant: ["parking"], driveway: ["driveway", "blocked"],
  heat: ["heat", "hot", "water", "apartment"], heating: ["heat"], radiator: ["heat"], cold: ["heat"], hot: ["heat"], landlord: ["apartment", "maintenance"], leak: ["leak", "water"], mold: ["mold", "apartment"],
  pothole: ["pothole", "street", "condition"], potholes: ["pothole", "street", "condition"], road: ["street"], sidewalk: ["sidewalk"], cracked: ["damaged"], broken: ["damaged", "defective"],
  streetlight: ["street", "light"], lamp: ["light"], signal: ["traffic", "signal"], stoplight: ["traffic", "signal"],
  trash: ["garbage", "litter"], garbage: ["garbage"], litter: ["litter", "dirty"], dumping: ["dumping", "illegal"], recycling: ["recycling"], pickup: ["collection"],
  graffiti: ["graffiti"], tag: ["graffiti"], tree: ["tree"], branch: ["tree", "limb"], fallen: ["down", "damaged"],
  train: ["subway", "train"], subway: ["subway"], mta: ["subway", "bus"], delayed: ["delay"], late: ["delay"], stuck: ["delay"], bus: ["bus"], lirr: ["long", "island", "rail", "road"], metro: ["metro", "north"], path: ["path", "train"], ferry: ["ferry"],
  bike: ["bike", "bicycle"], bikes: ["bike"], scooter: ["scooter", "bike"], lane: ["lane"],
  homeless: ["homeless", "outreach"], panhandling: ["panhandling"], smoke: ["smoking"], smoking: ["smoking"], vape: ["smoking"],
  dog: ["dog", "animal"], cat: ["cat", "animal"], pigeons: ["pigeon"], dead: ["dead"], animal: ["animal"],
  taxi: ["taxi"], uber: ["car", "service"], lyft: ["car", "service"], cab: ["taxi"],
  water: ["water"], sewer: ["sewer"], flooding: ["flooding", "catch", "basin"], hydrants: ["hydrant"],
  construction: ["construction"], scaffolding: ["scaffold"], elevator: ["elevator"], boiler: ["boiler"],
  restaurant: ["restaurant", "food"], store: ["store", "business"], overcharged: ["overcharge", "consumer"], refund: ["consumer", "complaint"],
};

const FIELD_WEIGHTS = { title: 3, summary: 1, topic: 0.5, agency: 0.5 } as const;
const K1 = 1.2;
const B = 0.75;

type Doc = { tf: Map<string, number>; len: number };
type Index = { docs: Doc[]; df: Map<string, number>; avgLen: number };

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

/** Light stemming: enough to match "complaints"/"complaint", "parking"/"parked" → "park". */
export function stem(t: string): string {
  if (t.length > 5 && t.endsWith("ing")) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (t.length > 4 && t.endsWith("ed")) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

function expandQuery(text: string): string[] {
  const raw = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const extra = raw.flatMap((w) => SYNONYMS[w] ?? []);
  return [...tokenize(text), ...extra.map(stem)];
}

function build(entries: CatalogEntry[]) {
  const docs: Doc[] = entries.map((e) => {
    const tf = new Map<string, number>();
    let len = 0;
    const add = (text: string | null, w: number) => {
      for (const t of tokenize(text ?? "")) {
        tf.set(t, (tf.get(t) ?? 0) + w);
        len += w;
      }
    };
    add(e.title, FIELD_WEIGHTS.title);
    add(e.summary, FIELD_WEIGHTS.summary);
    add(e.topic, FIELD_WEIGHTS.topic);
    add(e.agency, FIELD_WEIGHTS.agency);
    return { tf, len };
  });
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const avgLen = docs.reduce((n, d) => n + d.len, 0) / Math.max(1, docs.length);
  return { entries, byId: new Map(entries.map((e) => [e.id, e])), index: { docs, df, avgLen } };
}

export type CatalogHit = { entry: CatalogEntry; score: number };

/** Top-k catalog entries for free text. Empty text ⇒ []. */
export function searchCatalog(text: string, k = 10): CatalogHit[] {
  const { entries, index } = catalogState();
  const q = [...new Set(expandQuery(text))];
  if (!q.length || !entries.length) return [];
  const N = entries.length;
  const hits: CatalogHit[] = [];
  index.docs.forEach((d, i) => {
    let score = 0;
    for (const t of q) {
      const f = d.tf.get(t);
      if (!f) continue;
      const n = index.df.get(t) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / index.avgLen));
    }
    if (score > 0) hits.push({ entry: entries[i], score });
  });
  return hits.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id)).slice(0, k);
}
