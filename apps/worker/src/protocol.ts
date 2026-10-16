/**
 * Worker-side copy of the protocol types from apps/bot/src/core/contracts.ts.
 * The worker runs alone inside the sandbox (only playwright-core installed), so it must not import the bot.
 * KEEP IDENTICAL to: FilingTarget, CategoryId, FilingPayload, FilingStatus, FilingErrorCode,
 * WorkerStep, WorkerEvent, EvidenceFile, WorkerResult, TransitDetails, SUBWAY_LINES, WorkerQuestion, WorkerAnswer,
 * FormField, FormSchema.
 * Deliberately wider than the bot: `category` is any catalog slug (the registry decides; unknown ⇒ FAILED/NO_ADAPTER).
 */
import type { FormRecipe } from "./adapters/recipe.js";

/** Every filing targets the official form (the replica portal is gone). */
export type FilingTarget = "real";
export type CategoryId = "subway-delay";
/**
 * The worker accepts any catalog slug as `category` (CatalogEntry.id, #7/#9); the adapter registry decides whether it
 * can file it. The bot's FilingPayload.category is still CategoryId (a subset).
 */
export type CatalogCategoryId = CategoryId | (string & {});
/** "none" | "handoff" | "adapter:<id>" (same as the bot's CatalogAutomation). */
export type CatalogAutomation = string;
export const CATEGORY_SLUG_RE = /^[a-z0-9-]+$/;
export const AUTOMATION_RE = /^(none|handoff|adapter:[a-z0-9-]+)$/;

/** Canonical subway lines (same order/spelling as the bot's SUBWAY_LINES). The MTA wizard labels them "<line> Line". */
export const SUBWAY_LINES = ["1", "2", "3", "4", "5", "6", "7", "A", "C", "E", "B", "D", "F", "M", "N", "Q", "R", "W", "G", "L", "J", "Z", "S-42 Street Shuttle", "S-Franklin Av Shuttle", "S-Rockaway Park Shuttle", "Staten Island Railway"] as const;

/** Transit details (subway categories). Values must come from the user. */
export interface TransitDetails {
  /** One of SUBWAY_LINES (canonical), or null if the user has not said. */
  line: string | null;
  /** Free text as the user said it, e.g. "downtown", "uptown", "Manhattan-bound", "toward Coney Island". */
  direction: string | null;
  /** Nearest station as the user said it, or null. */
  station: string | null;
  borough: string | null;
  /** ISO datetime of the incident if the user gave a time, else null. */
  incidentTime: string | null;
  /** Minutes delayed if stated. */
  delayMinutes: number | null;
}

export interface FilingPayload {
  attemptId: string;
  complaintId: string;
  approvedVersion: number;
  target: FilingTarget;
  category: CatalogCategoryId;
  /** Optional: how to file it (CatalogEntry.automation). Absent ⇒ the registry default for `category`. */
  automation?: CatalogAutomation;
  /** Declarative form recipe (adapters/recipe.ts) for `automation: "adapter:recipe"`; recipe.categoryId must equal category. */
  recipe?: FormRecipe;
  formUrl: string;
  allowedHosts: string[];
  extraHeaders: Record<string, string>;
  cdpUrl: string | null;
  liveViewUrl: string | null;
  form: {
    description: string;
    address: string | null;
    borough: string | null;
    latitude: number | null;
    longitude: number | null;
    contactName: string | null;
    contactEmail: string | null;
    contactPhone: string | null;
    dateObserved: string | null;
    /** Subway categories only. */
    transit?: TransitDetails | null;
    /** Resident's answers to questions learned from earlier filings (field label → answer). Hand-off prefill matches labels. */
    extraFields?: Record<string, string>;
  };
  /**
   * True ONLY when the resident explicitly approved AND env ALLOW_REAL_SUBMIT=1.
   * Real-site adapters must never click the final Submit unless this is true.
   */
  realSubmitAuthorized?: boolean;
  /**
   * questionTimeoutMs: how long ctx.ask() waits for <outDir>/answer-<id>.json (default 180000).
   * 0 ⇒ never ask; the adapter's original HUMAN_ACTION_REQUIRED outcome is thrown immediately.
   */
  limits: { totalTimeoutMs: number; stepTimeoutMs: number; maxNavigationRetries: number; questionTimeoutMs?: number };
}

export const DEFAULT_QUESTION_TIMEOUT_MS = 180_000;

/** Live follow-up question (worker → bot → resident). Written to <outDir>/question-<id>.json + an EVT "question". */
export type QuestionField = "direction" | "station" | "contact_name" | "contact_email" | "free_text";
export interface WorkerQuestion {
  /** [A-Za-z0-9_-]{1,24}; unique per attempt. */
  id: string;
  field: QuestionField;
  /** Resident-facing question. Never contains PII. */
  prompt: string;
  /** Tappable choices (exact labels). Free text is accepted when absent or when field is station/free_text. */
  options?: string[];
  required: boolean;
}
/** <outDir>/answer-<id>.json, written by the bot. optionIndex refers to WorkerQuestion.options. */
export interface WorkerAnswer {
  value: string;
  optionIndex?: number;
}

export type FilingStatus = "SUBMITTED" | "HUMAN_ACTION_REQUIRED" | "SUBMISSION_UNKNOWN" | "FAILED";

export type FilingErrorCode =
  | "CAPTCHA"
  | "LOGIN_REQUIRED"
  | "UNEXPECTED_REQUIRED_FIELD"
  | "OFF_ALLOWLIST_NAVIGATION"
  | "FORM_REJECTED"
  | "NO_CONFIRMATION"
  | "CONNECTION_LOST_AFTER_SUBMIT"
  | "NAVIGATION_FAILED"
  | "TIMEOUT"
  | "BROWSER_ERROR"
  | "WORKER_CRASH"
  | "SANDBOX_ERROR"
  | "NO_ADAPTER";

export type WorkerStep = "navigate" | "inspect" | "fill" | "validate" | "submit" | "confirm";

export interface WorkerEvent {
  ts: string;
  step: WorkerStep;
  level: "info" | "warn" | "error";
  message: string;
  data?: Record<string, unknown>;
}

export interface EvidenceFile {
  name: string;
  type: "screenshot" | "html" | "log" | "json";
  step: WorkerStep;
  summary: string;
}

/**
 * Observed structure of one form control (procedural memory input, issue #11). STRUCTURE ONLY: never a value the
 * resident typed or chose. `options` are the form's own labels (choice buttons / select / radio).
 */
export type FormFieldType = "text" | "textarea" | "select" | "radio" | "checkbox" | "button-choice" | "date" | "time" | "file" | "unknown";
export interface FormField {
  label: string;
  type: FormFieldType;
  required: boolean;
  options?: string[];
  /** Attribute maxlength, or the visible "0/4000" counter; null when unknown. */
  maxLength?: number | null;
  /** Title of the wizard step / page section this field was seen on. */
  step: string;
  /** Playwright selector that found it (role/label/placeholder based), e.g. `role=textbox[name="Email (optional)"]`. */
  selectorHint?: string;
}
/** Merged, ordered per-step schema observed during one run. Emitted per step as `EVT {"step":"inspect","message":"form_schema"}`. */
export interface FormSchema {
  steps: { title: string; fields: FormField[] }[];
  capturedAt: string;
}

export interface WorkerResult {
  attemptId: string;
  status: FilingStatus;
  errorCode: FilingErrorCode | null;
  officialRequestNumber: string | null;
  officialReceiptUrl: string | null;
  confirmationText: string | null;
  submitClicked: boolean;
  finalUrl: string | null;
  steps: WorkerEvent[];
  evidence: EvidenceFile[];
  startedAt: string;
  finishedAt: string;
  /** Form structure observed during this run (additive; null/absent when nothing was captured). */
  formSchema?: FormSchema | null;
}

/**
 * What the worker actually writes. Extra keys are ignored by the bot's zod parse (z.object strips unknown keys).
 * `message` = one human-readable sentence explaining the outcome (safe to show to the resident).
 */
export type WorkerResultFile = WorkerResult & { message: string; target: FilingTarget; category: CatalogCategoryId };

/** Thrown by adapters/main to stop the run with a definite non-SUBMITTED outcome. */
export class Outcome extends Error {
  constructor(
    public status: Exclude<FilingStatus, "SUBMITTED">,
    public errorCode: FilingErrorCode | null,
    message: string,
    public data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "Outcome";
  }
}

export const nowIso = () => new Date().toISOString();

/** Hand-written shape check (no zod in the sandbox). Returns a list of problems; empty = valid. */
export function validatePayload(p: unknown): string[] {
  const problems: string[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const str = (o: Record<string, unknown>, k: string, prefix = "") => {
    if (typeof o[k] !== "string" || (o[k] as string).length === 0) problems.push(`${prefix}${k} must be a non-empty string`);
  };
  const strOrNull = (o: Record<string, unknown>, k: string, prefix = "") => {
    if (!(o[k] === null || typeof o[k] === "string")) problems.push(`${prefix}${k} must be string|null`);
  };
  const numOrNull = (o: Record<string, unknown>, k: string, prefix = "") => {
    if (!(o[k] === null || (typeof o[k] === "number" && Number.isFinite(o[k])))) problems.push(`${prefix}${k} must be number|null`);
  };
  if (!isObj(p)) return ["payload must be an object"];
  str(p, "attemptId");
  str(p, "complaintId");
  if (typeof p.approvedVersion !== "number") problems.push("approvedVersion must be a number");
  if (p.target !== "real") problems.push("target must be real");
  // Any catalog slug is accepted here; whether it can be filed is the adapter registry's call (FAILED/NO_ADAPTER).
  if (typeof p.category !== "string" || !CATEGORY_SLUG_RE.test(p.category)) problems.push("category must be a catalog slug [a-z0-9-]+");
  if (p.automation !== undefined && (typeof p.automation !== "string" || !AUTOMATION_RE.test(p.automation))) problems.push("automation must be none|handoff|adapter:<id>");
  str(p, "formUrl");
  try {
    const u = new URL(String(p.formUrl));
    if (u.protocol !== "http:" && u.protocol !== "https:") problems.push("formUrl must be http(s)");
  } catch {
    problems.push("formUrl must be an absolute URL");
  }
  if (!Array.isArray(p.allowedHosts) || p.allowedHosts.length === 0 || !p.allowedHosts.every((h) => typeof h === "string" && h.length > 0))
    problems.push("allowedHosts must be a non-empty string[]");
  if (!isObj(p.extraHeaders) || !Object.values(p.extraHeaders).every((v) => typeof v === "string")) problems.push("extraHeaders must be Record<string,string>");
  strOrNull(p, "cdpUrl");
  strOrNull(p, "liveViewUrl");
  // Unknown keys are ignored (tolerant: older bots may still send extra fields).
  if (!isObj(p.form)) problems.push("form must be an object");
  else {
    const f = p.form;
    if (typeof f.description !== "string") problems.push("form.description must be a string");
    for (const k of ["address", "borough", "contactName", "contactEmail", "contactPhone", "dateObserved"]) strOrNull(f, k, "form.");
    numOrNull(f, "latitude", "form.");
    numOrNull(f, "longitude", "form.");
    if (f.extraFields !== undefined && (!isObj(f.extraFields) || !Object.values(f.extraFields).every((v) => typeof v === "string"))) problems.push("form.extraFields must be Record<string,string>");
    if (f.transit !== undefined && f.transit !== null) {
      if (!isObj(f.transit)) problems.push("form.transit must be an object|null");
      else {
        for (const k of ["line", "direction", "station", "borough", "incidentTime"]) if (f.transit[k] !== undefined) strOrNull(f.transit, k, "form.transit.");
        if (f.transit.delayMinutes !== undefined) numOrNull(f.transit, "delayMinutes", "form.transit.");
      }
    }
  }
  // Recipe structure is checked by the registry (validateRecipe) so a bad recipe is FAILED/NO_ADAPTER.
  if (p.recipe !== undefined && !isObj(p.recipe)) problems.push("recipe must be an object");
  if (p.realSubmitAuthorized !== undefined && typeof p.realSubmitAuthorized !== "boolean") problems.push("realSubmitAuthorized must be a boolean");
  if (!isObj(p.limits)) problems.push("limits must be an object");
  else
    for (const k of ["totalTimeoutMs", "stepTimeoutMs", "maxNavigationRetries"])
      if (typeof p.limits[k] !== "number" || !Number.isFinite(p.limits[k]) || (p.limits[k] as number) < 0) problems.push(`limits.${k} must be a non-negative number`);
  if (isObj(p.limits) && p.limits.questionTimeoutMs !== undefined && (typeof p.limits.questionTimeoutMs !== "number" || !Number.isFinite(p.limits.questionTimeoutMs) || p.limits.questionTimeoutMs < 0))
    problems.push("limits.questionTimeoutMs must be a non-negative number");
  // A formUrl outside the allowlist is a payload bug: refuse before opening anything.
  if (problems.length === 0) {
    const host = new URL(String(p.formUrl)).hostname;
    if (!hostAllowed(host, p.allowedHosts as string[])) problems.push(`formUrl host ${host} is not in allowedHosts`);
  }
  return problems;
}

export function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return allowed.some((a) => {
    const x = a.toLowerCase().trim().replace(/\.$/, "");
    return h === x || h.endsWith(`.${x}`);
  });
}

/** Strip query + fragment (signed tokens, session ids) before a URL goes into logs/results. */
export function sanitizeUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const url = new URL(u);
    if (url.protocol !== "http:" && url.protocol !== "https:") return url.protocol + "//" + url.host + url.pathname;
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}
