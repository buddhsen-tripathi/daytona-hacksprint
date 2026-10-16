/**
 * Degraded-mode implementations used by integrations/index.ts when a
 * provider module is missing or fails to initialize. They keep the bot,
 * the API and the scripted runner runnable without keys. Never used when the
 * real module loads.
 */
import type {
  ClassificationResult,
  Classifier,
  ComplaintDraft,
  ComplaintLocation,
  DuplicateService,
  Evidence,
  FilingOutcome,
  FilingTarget,
  LocationService,
  Resident,
  SpanHelpers,
  Tracer,
  WorkerAnswer,
  WorkerQuestion,
} from "../core/contracts.js";
import { NYC_BOUNDS } from "../core/contracts.js";
import { env } from "./env.js";

// ---- service shapes owned by other agents (structural, so any compatible impl fits) ----
export interface FilingService {
  executeFiling(
    complaint: ComplaintDraft,
    opts: {
      resident: Resident;
      onProgress: (text: string) => void;
      /** Called in the background once the browser session recording is downloaded (Anchor only). */
      onRecording?: (localPath: string, evidence: Evidence) => Promise<void>;
      /** Live follow-up question from the worker; resolve with the resident's answer, or null (no answer ⇒ hand-off). */
      onQuestion?: (q: WorkerQuestion & { attemptId: string; timeoutMs: number }) => Promise<WorkerAnswer | null>;
    },
  ): Promise<FilingOutcome>;
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
const SUBWAY_RE = /\b(subway|train|[1-7ACEBDFMNQRWGLJZ] line)\b/i;
const DELAY_RE = /\b(delay(ed)?|late|stuck|held|sat|stopped|waiting|no train|slow)\b/i;
const OTHER_TRANSIT_RE = /\b(lirr|long island rail|metro-?north|path train|nj transit|amtrak|bus|ferry|access-a-ride)\b/i;
const OOS_RE = /\b(pothole|pot hole|road|street|asphalt|sidewalk|noise|dog|bark|music|parking|rat|garbage|trash|graffiti|heat|hot water|tree|light out|streetlight|neighbor|broken)\b/i;

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
      } else if (OTHER_TRANSIT_RE.test(text)) {
        result = { ...base, triage: "OUT_OF_SCOPE", category: null, confidence: 0.8, description: summarize(text), rationale: "Not a NYC subway delay (another transit service)." };
      } else if (SUBWAY_RE.test(text) && DELAY_RE.test(text)) {
        result = { ...base, triage: "SUPPORTED", category: "subway-delay", confidence: 0.8, description: summarize(text), rationale: "Text describes a delayed subway train.", transit: null };
      } else if (OOS_RE.test(text)) {
        result = { ...base, triage: "OUT_OF_SCOPE", category: null, confidence: 0.8, description: summarize(text), rationale: "Not a supported category." };
      } else {
        result = { ...base, triage: "UNCLEAR", category: null, confidence: 0.3, description: summarize(text), rationale: hasImage ? "Photo without enough context." : "Not enough detail.", clarifyingQuestion: "What's the problem you ran into? For example, was a subway train delayed?" };
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
      const c = await duplicates.lookupStatus(sr).catch(() => null);
      if (!c) return { found: false, status: null, source: "open-data" };
      return { found: true, status: c.status, detail: c.resolutionDescription, source: "NYC Open Data (311 Service Requests)" };
    },
  };
}
