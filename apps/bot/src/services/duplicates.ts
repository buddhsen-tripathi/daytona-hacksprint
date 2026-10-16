/**
 * DuplicateService (design doc §12). Possible duplicates are presented as
 * possibilities, never as confirmed duplicates, and never block reporting.
 */
import { CATEGORIES, DUPLICATE_SEARCH, haversineMeters } from "../core/contracts.js";
import type { CategoryId, DuplicateCandidate, DuplicateService } from "../core/contracts.js";
import { getByUniqueKey, searchNearby } from "../integrations/nyc-open-data.js";
import type { Raw311Record } from "../integrations/nyc-open-data.js";

const DAY_MS = 86_400_000;

/** Street-surface descriptors under "Street Condition" (anything else there ⇒ weak match). */
export const STREET_SURFACE_DESCRIPTORS = [
  "Pothole",
  "Cave-in",
  "Defective Hardware",
  "Rough, Pitted or Cracked Roads",
  "Failed Street Repair",
  "Plate Condition - Noisy",
  "Plate Condition - Shifted",
  "Plate Condition - Noisy/Shifted",
];

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const num = (v: unknown) => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Socrata floating timestamps are NYC local time; treat them as such (approx: parse as UTC-4/-5 isn't worth it for day-level recency). */
function parseDate(s: string | undefined | null): number | null {
  if (!s) return null;
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isFinite(t) ? t : null;
}

export function categorySimilarity(category: CategoryId, rec: Pick<Raw311Record, "complaint_type" | "descriptor">): number {
  const def = CATEGORIES[category];
  const descriptor = (rec.descriptor ?? "").trim();
  if (rec.complaint_type === def.openData.complaintType) {
    if (def.openData.descriptors.includes(descriptor)) return 1.0;
    if (STREET_SURFACE_DESCRIPTORS.some((d) => d.toLowerCase() === descriptor.toLowerCase()) || /^plate condition/i.test(descriptor)) return 0.6;
  }
  return 0.2;
}

/** Score one Open Data record against the user's location/category (design doc §12.3). Returns null if dropped. */
export function scoreRecord(
  rec: Raw311Record,
  args: { category: CategoryId; latitude: number; longitude: number; now?: Date },
  cfg: { radiusMeters: number; broadRadiusMeters: number; recencyDays: number } = DUPLICATE_SEARCH,
): DuplicateCandidate | null {
  const lat = num(rec.latitude);
  const lon = num(rec.longitude);
  const created = parseDate(rec.created_date);
  if (!rec.unique_key || created == null) return null;
  const distanceMeters = lat != null && lon != null ? haversineMeters(args.latitude, args.longitude, lat, lon) : null;
  if (distanceMeters == null || distanceMeters > cfg.broadRadiusMeters) return null;
  const now = (args.now ?? new Date()).getTime();
  const ageDays = Math.max(0, (now - created) / DAY_MS);
  const location = clamp01(1 - distanceMeters / cfg.radiusMeters);
  const category = categorySimilarity(args.category, rec);
  const recency = clamp01(1 - ageDays / cfg.recencyDays);
  const matchScore = 0.45 * location + 0.35 * category + 0.2 * recency;
  return {
    uniqueKey: String(rec.unique_key),
    complaintType: rec.complaint_type,
    descriptor: rec.descriptor ?? null,
    status: rec.status ?? null,
    createdDate: rec.created_date,
    closedDate: rec.closed_date ?? null,
    resolutionDescription: rec.resolution_description ?? null,
    incidentAddress: rec.incident_address ?? null,
    latitude: lat,
    longitude: lon,
    distanceMeters: Math.round(distanceMeters * 10) / 10,
    ageDays: Math.round(ageDays * 10) / 10,
    matchScore: round3(matchScore),
    scoreBreakdown: { location: round3(location), category: round3(category), recency: round3(recency) },
  };
}

export function rankCandidates(
  records: Raw311Record[],
  args: { category: CategoryId; latitude: number; longitude: number; now?: Date },
  cfg: { radiusMeters: number; broadRadiusMeters: number; recencyDays: number; minScore: number; maxCandidates: number } = DUPLICATE_SEARCH,
): { candidates: DuplicateCandidate[]; dataAsOf: string | null } {
  let maxCreated: string | null = null;
  let maxT = -Infinity;
  const seen = new Set<string>();
  const scored: DuplicateCandidate[] = [];
  for (const r of records) {
    const t = parseDate(r.created_date);
    if (t != null && t > maxT) {
      maxT = t;
      maxCreated = r.created_date;
    }
    if (seen.has(String(r.unique_key))) continue;
    seen.add(String(r.unique_key));
    const c = scoreRecord(r, args, cfg);
    if (c && c.matchScore >= cfg.minScore) scored.push(c);
  }
  scored.sort((a, b) => b.matchScore - a.matchScore || (a.distanceMeters ?? 0) - (b.distanceMeters ?? 0));
  return { candidates: scored.slice(0, cfg.maxCandidates), dataAsOf: maxCreated };
}

export function toCandidate(rec: Raw311Record, now = new Date()): DuplicateCandidate {
  const created = parseDate(rec.created_date);
  return {
    uniqueKey: String(rec.unique_key),
    complaintType: rec.complaint_type,
    descriptor: rec.descriptor ?? null,
    status: rec.status ?? null,
    createdDate: rec.created_date,
    closedDate: rec.closed_date ?? null,
    resolutionDescription: rec.resolution_description ?? null,
    incidentAddress: rec.incident_address ?? null,
    latitude: num(rec.latitude),
    longitude: num(rec.longitude),
    distanceMeters: null,
    ageDays: created == null ? 0 : Math.round(((now.getTime() - created) / DAY_MS) * 10) / 10,
    matchScore: 0,
    scoreBreakdown: { location: 0, category: 0, recency: 0 },
  };
}

export type DuplicateServiceOptions = { timeoutMs?: number; now?: () => Date };

export function createDuplicateService(opts: DuplicateServiceOptions = {}): DuplicateService {
  const now = opts.now ?? (() => new Date());
  return {
    async findPotentialDuplicates({ category, latitude, longitude }) {
      try {
        const def = CATEGORIES[category];
        if (!def) return { candidates: [], dataAsOf: null, source: "unavailable" };
        const at = now();
        const records = await searchNearby({
          latitude,
          longitude,
          radiusMeters: DUPLICATE_SEARCH.broadRadiusMeters,
          complaintType: def.openData.complaintType,
          since: new Date(at.getTime() - DUPLICATE_SEARCH.recencyDays * DAY_MS),
          limit: 50,
          timeoutMs: opts.timeoutMs ?? 8_000,
        });
        const { candidates, dataAsOf } = rankCandidates(records, { category, latitude, longitude, now: at });
        return { candidates, dataAsOf, source: "open-data" };
      } catch {
        return { candidates: [], dataAsOf: null, source: "unavailable" };
      }
    },

    async lookupStatus(uniqueKey) {
      try {
        const rec = await getByUniqueKey(uniqueKey, { timeoutMs: opts.timeoutMs ?? 8_000 });
        return rec ? toCandidate(rec, now()) : null;
      } catch {
        return null;
      }
    },
  };
}
