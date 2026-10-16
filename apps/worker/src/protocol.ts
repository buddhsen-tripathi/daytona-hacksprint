/**
 * Worker-side copy of the protocol types from apps/bot/src/core/contracts.ts.
 * The worker runs alone inside the sandbox (only playwright-core installed), so it must not import the bot.
 * KEEP IDENTICAL to: FilingTarget, PortalMode, CategoryId, FilingPayload, FilingStatus, FilingErrorCode,
 * WorkerStep, WorkerEvent, EvidenceFile, WorkerResult.
 */
export type FilingTarget = "demo" | "real";
export type PortalMode = "normal" | "captcha" | "flaky" | "reject";
export type CategoryId = "street-pothole" | "street-repair-defect";

export interface FilingPayload {
  attemptId: string;
  complaintId: string;
  approvedVersion: number;
  target: FilingTarget;
  category: CategoryId;
  formUrl: string;
  allowedHosts: string[];
  extraHeaders: Record<string, string>;
  cdpUrl: string | null;
  liveViewUrl: string | null;
  portalMode: PortalMode;
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
  };
  limits: { totalTimeoutMs: number; stepTimeoutMs: number; maxNavigationRetries: number };
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
  | "SANDBOX_ERROR";

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
}

/**
 * What the worker actually writes. Extra keys are ignored by the bot's zod parse (z.object strips unknown keys).
 * `message` = one human-readable sentence explaining the outcome (safe to show to the resident).
 */
export type WorkerResultFile = WorkerResult & { message: string; target: FilingTarget; category: CategoryId };

export const DEMO_SR_RE = /^DEMO-\d{8}-[A-Z0-9]{6}$/;

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

const PORTAL_MODES: PortalMode[] = ["normal", "captcha", "flaky", "reject"];
const CATEGORIES: CategoryId[] = ["street-pothole", "street-repair-defect"];

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
  if (p.target !== "demo" && p.target !== "real") problems.push("target must be demo|real");
  if (!CATEGORIES.includes(p.category as CategoryId)) problems.push(`category must be one of ${CATEGORIES.join("|")}`);
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
  if (!PORTAL_MODES.includes(p.portalMode as PortalMode)) problems.push(`portalMode must be one of ${PORTAL_MODES.join("|")}`);
  if (!isObj(p.form)) problems.push("form must be an object");
  else {
    const f = p.form;
    if (typeof f.description !== "string") problems.push("form.description must be a string");
    for (const k of ["address", "borough", "contactName", "contactEmail", "contactPhone", "dateObserved"]) strOrNull(f, k, "form.");
    numOrNull(f, "latitude", "form.");
    numOrNull(f, "longitude", "form.");
  }
  if (!isObj(p.limits)) problems.push("limits must be an object");
  else
    for (const k of ["totalTimeoutMs", "stepTimeoutMs", "maxNavigationRetries"])
      if (typeof p.limits[k] !== "number" || !Number.isFinite(p.limits[k]) || (p.limits[k] as number) < 0) problems.push(`limits.${k} must be a non-negative number`);
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
