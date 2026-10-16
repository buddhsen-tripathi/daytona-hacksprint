/**
 * Degraded-mode implementations used by integrations/index.ts when a
 * provider module is missing or fails to initialize. They keep the bot,
 * the API and scripts/demo.ts runnable without keys. Never used when the
 * real module loads.
 */
import type {
  ClassificationResult,
  Classifier,
  ComplaintDraft,
  ComplaintLocation,
  DuplicateService,
  FilingOutcome,
  FilingTarget,
  LocationService,
  Resident,
  SpanHelpers,
  Tracer,
} from "../core/contracts.js";
import { NYC_BOUNDS } from "../core/contracts.js";
import { env } from "./env.js";

// ---- service shapes owned by other agents (structural, so any compatible impl fits) ----
export interface FilingService {
  executeFiling(complaint: ComplaintDraft, opts: { resident: Resident; onProgress: (text: string) => void }): Promise<FilingOutcome>;
}
export type StatusLookupResult = {
  found: boolean;
  status: string | null;
  detail?: string | null;
  source?: string | null;
  [k: string]: unknown;
} | null;
export interface StatusService {
  lookup(sr: string, opts: { target: FilingTarget }): Promise<StatusLookupResult>;
}

// ---- tracer ----
export function createNoopTracer(): Tracer {
  const helpers: SpanHelpers = {
    set() {},
    input() {},
    output() {},
    llm() {},
    retriever() {},
    tool() {},
    metadata() {},
  };
  return {
    async span(_name, _attrs, fn) {
      return fn(helpers.set, helpers);
    },
    async withSession(_s, fn) {
      return fn();
    },
    currentTraceId: () => null,
    traceUrl: () => null,
    sessionUrl: () => null,
    evaluate() {},
    async flush() {},
  };
}

// ---- classifier (keyword heuristic) ----
const EMERGENCY_RE = /\b(fire|smoke|injur|hurt|bleed|unconscious|fell in|car fell|collapsed?|sinkhole|gas leak|explosion|downed (power )?line|someone is trapped|open manhole|dangerous hole)\b/i;
const REPAIR_RE = /\b(patch|trench|street cut|utility cut|repaired|restoration|plate|steel plate|sunk(en)? patch)\b/i;
const POTHOLE_RE = /\b(pothole|pot hole|road|street|asphalt|crack|hole|broken|pavement|cave)\b/i;
const OOS_RE = /\b(noise|dog|bark|music|parking|rat|garbage|trash|graffiti|heat|hot water|tree|light out|streetlight|sidewalk|neighbor)\b/i;

export function createHeuristicClassifier(): Classifier {
  return {
    async classify(input) {
      const text = [...input.conversation, input.text ?? ""].join(" \n ").trim();
      const hasImage = input.imagePaths.length > 0;
      const base: Omit<ClassificationResult, "triage" | "category" | "confidence" | "description" | "rationale"> = {
        alternativeConsidered: null,
        safetyFlags: [],
        clarifyingQuestion: null,
      };
      let result: ClassificationResult;
      if (EMERGENCY_RE.test(text)) {
        result = { ...base, triage: "EMERGENCY", category: null, confidence: 0.9, description: summarize(text), rationale: "Text mentions immediate danger.", safetyFlags: ["danger-keywords"] };
      } else if (REPAIR_RE.test(text)) {
        result = { ...base, triage: "SUPPORTED", category: "street-repair-defect", confidence: 0.75, description: summarize(text) || "Damage in a previously repaired section of the street.", rationale: "Mentions a patch/trench/street cut.", alternativeConsidered: "Pothole: rejected because damage is inside a repaired area." };
      } else if (POTHOLE_RE.test(text) || (hasImage && !OOS_RE.test(text))) {
        result = { ...base, triage: "SUPPORTED", category: "street-pothole", confidence: hasImage ? 0.8 : 0.7, description: summarize(text) || "Road surface has a visible pothole.", rationale: hasImage ? "Photo provided; text/photo suggest road surface damage." : "Text describes road surface damage.", alternativeConsidered: "Street repair defect: no sign of a patch or trench." };
      } else if (OOS_RE.test(text)) {
        result = { ...base, triage: "OUT_OF_SCOPE", category: null, confidence: 0.8, description: summarize(text), rationale: "Not a street surface problem." };
      } else {
        result = { ...base, triage: "UNCLEAR", category: null, confidence: 0.3, description: summarize(text), rationale: "Not enough detail.", clarifyingQuestion: "What kind of problem is it? For example, a pothole in the road, or a damaged patch where the street was dug up?" };
      }
      return { result, model: "heuristic-fallback", usage: { promptTokens: null, completionTokens: null } };
    },
  };
}
function summarize(t: string) {
  const s = t.replace(/\s+/g, " ").trim();
  return s.length > 200 ? `${s.slice(0, 197)}…` : s;
}

// ---- location (bbox only; no geocoding) ----
export function createBoundsLocationService(): LocationService {
  const within = (lat: number, lon: number) => lat >= NYC_BOUNDS.minLat && lat <= NYC_BOUNDS.maxLat && lon >= NYC_BOUNDS.minLon && lon <= NYC_BOUNDS.maxLon;
  return {
    withinNyc: within,
    async fromPin(lat, lon): Promise<ComplaintLocation> {
      return { latitude: lat, longitude: lon, address: null, borough: null, rawInput: null, source: "pin", userConfirmed: true, withinNyc: within(lat, lon) };
    },
    async fromText() {
      return null;
    },
  };
}

// ---- duplicates ----
export function createUnavailableDuplicateService(): DuplicateService {
  return {
    async findPotentialDuplicates() {
      return { candidates: [], dataAsOf: null, source: "unavailable" };
    },
    async lookupStatus() {
      return null;
    },
  };
}

// ---- filing ----
export function createUnavailableFilingService(): FilingService {
  return {
    async executeFiling(complaint) {
      return {
        complaintId: complaint.id,
        attemptId: "none",
        status: "FAILED",
        errorCode: "SANDBOX_ERROR",
        message: "The isolated filing environment isn't available in this build. Nothing was submitted.",
      };
    },
  };
}

// ---- status ----
export function createBasicStatusService(duplicates: DuplicateService): StatusService {
  return {
    async lookup(sr) {
      if (/^DEMO-/i.test(sr)) {
        try {
          const res = await fetch(`${env.DEMO_PORTAL_URL.replace(/\/$/, "")}/api/status/${encodeURIComponent(sr)}`, { signal: AbortSignal.timeout(5000) });
          if (!res.ok) return { found: false, status: null, source: "demo-portal" };
          const j = (await res.json()) as { status?: string; category?: string; createdAt?: string };
          return { found: true, status: j.status ?? null, detail: j.category ? `${j.category}, filed ${j.createdAt ?? ""}` : null, source: "NYC311 Demo Portal" };
        } catch {
          return { found: false, status: null, source: "demo-portal" };
        }
      }
      const c = await duplicates.lookupStatus(sr).catch(() => null);
      if (!c) return { found: false, status: null, source: "open-data" };
      return { found: true, status: c.status, detail: c.resolutionDescription, source: "NYC Open Data (311 Service Requests)" };
    },
  };
}
