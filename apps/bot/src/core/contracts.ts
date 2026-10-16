/**
 * 311Relay shared contracts. Every module imports from here; do not redefine.
 *
 * Core principle (design doc §8, §9.4, final principle): the LLM understands,
 * classifies and plans within bounds; deterministic code owns state
 * transitions, approval, tool permissions and the final outcome. A prepared
 * complaint ≠ an attempted filing ≠ an officially confirmed service request.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Categories (allowlist). The classifier may only pick from these ids.
// ---------------------------------------------------------------------------
export const CategoryId = z.enum([
  "street-pothole", // Pothole or Cave-In on Street (KA-01093) → DOT pothole form
  "street-repair-defect", // Street Repair Complaint (KA-01095): failed restoration / utility cut
]);
export type CategoryId = z.infer<typeof CategoryId>;

/** Non-filing resolutions the classifier may return instead of a category. */
export const TriageOutcome = z.enum([
  "SUPPORTED", // one of CategoryId
  "OUT_OF_SCOPE", // real issue, but not a supported category (give manual guidance)
  "EMERGENCY", // immediate danger → 911 referral, stop
  "UNCLEAR", // cannot tell from the input; ask a clarifying question
]);
export type TriageOutcome = z.infer<typeof TriageOutcome>;

export const CategoryDefinition = z.object({
  id: CategoryId,
  label: z.string(),
  /** Official NYC311 label shown to the user. */
  officialLabel: z.string(),
  /** NYC311 knowledge article. */
  articleUrl: z.string().url(),
  /** Official reporting route the browser worker may open (allowlisted). */
  officialFormUrl: z.string().url(),
  /** Route id inside the controlled demo portal (apps/portal). */
  demoRoute: z.string(),
  /** NYC Open Data (erm2-nwe9) complaint_type / descriptor values that map to this category. */
  openData: z.object({ complaintType: z.string(), descriptors: z.array(z.string()) }),
  /** Fields the draft must have before READY_FOR_APPROVAL. */
  requiredFields: z.array(z.enum(["location", "description"])),
  /** Short guidance used in prompts + /help. */
  guidance: z.string(),
});
export type CategoryDefinition = z.infer<typeof CategoryDefinition>;

export const CATEGORIES: Record<CategoryId, CategoryDefinition> = {
  "street-pothole": {
    id: "street-pothole",
    label: "Street pothole",
    officialLabel: "Pothole or Cave-In on Street",
    articleUrl: "https://portal.311.nyc.gov/article/?kanumber=KA-01093",
    officialFormUrl: "https://a841-dotvweb01.nyc.gov/potholeform",
    demoRoute: "pothole",
    openData: { complaintType: "Street Condition", descriptors: ["Pothole", "Cave-in", "Rough, Pitted or Cracked Roads"] },
    requiredFields: ["location", "description"],
    guidance:
      "A shallow hole or crack in the street surface, NOT inside a previously repaired patch and NOT next to a catch basin. Deep cave-ins or unprotected openings are a safety hazard: refer to 911.",
  },
  "street-repair-defect": {
    id: "street-repair-defect",
    label: "Street repair defect",
    officialLabel: "Street Repair Complaint",
    articleUrl: "https://portal.311.nyc.gov/article/?kanumber=KA-01095",
    officialFormUrl: "https://portal.311.nyc.gov/article/?kanumber=KA-01095",
    demoRoute: "street-repair",
    openData: { complaintType: "Street Condition", descriptors: ["Failed Street Repair", "Pothole"] },
    requiredFields: ["location", "description"],
    guidance:
      "Damage inside a filled/repaired area left by street work: a street cut, trench or square patch that is heaped above street level, sunk an inch or more, or has developed a pothole or depression.",
  },
};

// ---------------------------------------------------------------------------
// Conversation state machine (design doc §8.3)
// ---------------------------------------------------------------------------
export const ComplaintState = z.enum([
  "RECEIVED",
  "TRIAGING",
  "OUT_OF_SCOPE",
  "EMERGENCY_REFERRAL",
  "NEEDS_INFORMATION",
  "DUPLICATE_REVIEW",
  "READY_FOR_APPROVAL",
  "APPROVED",
  "FILING",
  "HUMAN_ACTION_REQUIRED",
  "SUBMISSION_UNKNOWN",
  "FAILED",
  "SUBMITTED",
  "TRACKING",
  "CANCELLED",
]);
export type ComplaintState = z.infer<typeof ComplaintState>;

/** Allowed transitions. `state-machine.ts` enforces these; nothing else mutates `status`. */
export const TRANSITIONS: Record<ComplaintState, ComplaintState[]> = {
  RECEIVED: ["TRIAGING", "CANCELLED"],
  TRIAGING: ["OUT_OF_SCOPE", "EMERGENCY_REFERRAL", "NEEDS_INFORMATION", "DUPLICATE_REVIEW", "READY_FOR_APPROVAL", "CANCELLED"],
  OUT_OF_SCOPE: ["TRIAGING", "CANCELLED"],
  EMERGENCY_REFERRAL: ["CANCELLED"],
  NEEDS_INFORMATION: ["TRIAGING", "NEEDS_INFORMATION", "DUPLICATE_REVIEW", "READY_FOR_APPROVAL", "CANCELLED"],
  DUPLICATE_REVIEW: ["READY_FOR_APPROVAL", "NEEDS_INFORMATION", "CANCELLED"],
  READY_FOR_APPROVAL: ["APPROVED", "NEEDS_INFORMATION", "TRIAGING", "CANCELLED"],
  APPROVED: ["FILING", "CANCELLED"],
  FILING: ["SUBMITTED", "HUMAN_ACTION_REQUIRED", "SUBMISSION_UNKNOWN", "FAILED"],
  HUMAN_ACTION_REQUIRED: ["CANCELLED", "READY_FOR_APPROVAL"],
  SUBMISSION_UNKNOWN: ["CANCELLED", "SUBMITTED"],
  FAILED: ["READY_FOR_APPROVAL", "CANCELLED"],
  SUBMITTED: ["TRACKING"],
  TRACKING: ["TRACKING"],
  CANCELLED: [],
};

/** Transitions that REQUIRE a user action (never an LLM / timer). */
export const USER_GATED: ReadonlyArray<`${ComplaintState}->${ComplaintState}`> = [
  "READY_FOR_APPROVAL->APPROVED",
  "DUPLICATE_REVIEW->READY_FOR_APPROVAL",
];

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------
export const LocationSource = z.enum(["pin", "text", "none"]);
export const ComplaintLocation = z.object({
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  /** Normalized street address (GeoSearch label) or null. */
  address: z.string().nullable(),
  borough: z.string().nullable(),
  /** Raw text the user typed, if any. */
  rawInput: z.string().nullable(),
  source: LocationSource,
  /** True once the user explicitly provided it (pin or typed) — never inferred from a photo. */
  userConfirmed: z.boolean(),
  withinNyc: z.boolean().nullable(),
});
export type ComplaintLocation = z.infer<typeof ComplaintLocation>;

export const EMPTY_LOCATION: ComplaintLocation = {
  latitude: null,
  longitude: null,
  address: null,
  borough: null,
  rawInput: null,
  source: "none",
  userConfirmed: false,
  withinNyc: null,
};

/** Rough NYC bounding box used for the jurisdiction check. */
export const NYC_BOUNDS = { minLat: 40.477, maxLat: 40.918, minLon: -74.26, maxLon: -73.699 };

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------
export const MediaItem = z.object({
  id: z.string(),
  type: z.enum(["photo", "voice"]),
  /** Telegram file_id (not a URL; resolved server-side). */
  telegramFileId: z.string(),
  /** Local path under .runs/media/ once downloaded (short retention). */
  localPath: z.string().nullable(),
  mime: z.string().nullable(),
  createdAt: z.string(),
});
export type MediaItem = z.infer<typeof MediaItem>;

// ---------------------------------------------------------------------------
// Classification (LLM output, Zod-validated; backend re-validates category)
// ---------------------------------------------------------------------------
export const ClassificationResult = z.object({
  triage: TriageOutcome,
  /** Required when triage === SUPPORTED. */
  category: CategoryId.nullable(),
  /** 0..1 — routing signal only. < 0.6 ⇒ clarify. */
  confidence: z.number().min(0).max(1),
  /** One or two sentences describing the observed problem in neutral terms. No invented facts. */
  description: z.string(),
  /** What the photo/text shows that supports the category (for the user + traces). */
  rationale: z.string(),
  /** Why the alternative category was rejected, when relevant (pothole vs repair defect). */
  alternativeConsidered: z.string().nullable(),
  /** Signals of danger that justify EMERGENCY. */
  safetyFlags: z.array(z.string()),
  /** The single most useful clarifying question when triage === UNCLEAR, else null. */
  clarifyingQuestion: z.string().nullable(),
});
export type ClassificationResult = z.infer<typeof ClassificationResult>;

export const CLASSIFY_CONFIDENCE_THRESHOLD = 0.6;

// ---------------------------------------------------------------------------
// Duplicates (NYC Open Data erm2-nwe9)
// ---------------------------------------------------------------------------
export const DuplicateCandidate = z.object({
  /** erm2-nwe9 unique_key == official SR number. */
  uniqueKey: z.string(),
  complaintType: z.string(),
  descriptor: z.string().nullable(),
  status: z.string().nullable(),
  createdDate: z.string(),
  closedDate: z.string().nullable(),
  resolutionDescription: z.string().nullable(),
  incidentAddress: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  distanceMeters: z.number().nullable(),
  ageDays: z.number(),
  /** 0..1 per design doc §12.3 */
  matchScore: z.number(),
  scoreBreakdown: z.object({ location: z.number(), category: z.number(), recency: z.number() }),
});
export type DuplicateCandidate = z.infer<typeof DuplicateCandidate>;

export const DUPLICATE_SEARCH = { radiusMeters: 50, broadRadiusMeters: 150, recencyDays: 90, minScore: 0.55, maxCandidates: 3 } as const;

// ---------------------------------------------------------------------------
// Complaint draft (design doc §8.2) — the central record
// ---------------------------------------------------------------------------
export const ComplaintDraft = z.object({
  id: z.string(),
  telegramChatId: z.string(),
  residentId: z.string(),
  status: ComplaintState,
  category: CategoryId.nullable(),
  triage: TriageOutcome.nullable(),
  description: z.string(),
  /** Everything the user typed, in order (conversation memory). */
  userMessages: z.array(z.string()),
  location: ComplaintLocation,
  media: z.array(MediaItem),
  classification: ClassificationResult.nullable(),
  missingFields: z.array(z.enum(["location", "description", "category"])),
  needsEmergencyReferral: z.boolean(),
  confidence: z.number(),
  duplicates: z.array(DuplicateCandidate),
  /** User chose to continue despite duplicates (or none found). */
  duplicateReviewed: z.boolean(),
  /** `dataAsOf` of the Open Data snapshot used for the last duplicate check (null = unavailable / not checked). */
  duplicatesDataAsOf: z.string().nullable().optional(),
  /** Bumped on every material change to the draft; approval binds to a version. */
  draftVersion: z.number(),
  /** The draftVersion the user approved, or null. */
  approvedVersion: z.number().nullable(),
  approvedAt: z.string().nullable(),
  /** Set after a real filing attempt. */
  activeAttemptId: z.string().nullable(),
  officialRequestNumber: z.string().nullable(),
  /** Short machine-readable reason for terminal/non-happy states. */
  statusReason: z.string().nullable(),
  /** Phoenix trace id of the intake conversation. */
  traceId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ComplaintDraft = z.infer<typeof ComplaintDraft>;

export const Resident = z.object({
  id: z.string(),
  telegramChatId: z.string(),
  telegramUsername: z.string().nullable(),
  preferredLanguage: z.string().nullable(),
  /** Demo controls (set via /mode): which replica-portal behaviour the next filing should hit. */
  demoPortalMode: z.enum(["normal", "captcha", "flaky", "reject"]).default("normal"),
  /** Conversation memory for real filings: the official DOT form requires first + last name. Only ever user-provided. */
  contactName: z.string().nullable().default(null),
  contactEmail: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type Resident = z.infer<typeof Resident>;

// ---------------------------------------------------------------------------
// Filing: payload handed to the isolated worker, and what it returns
// ---------------------------------------------------------------------------
export const FilingTarget = z.enum(["demo", "real"]);
export type FilingTarget = z.infer<typeof FilingTarget>;

export const PortalMode = z.enum(["normal", "captcha", "flaky", "reject"]);
export type PortalMode = z.infer<typeof PortalMode>;

/** Written to /work/payload.json inside the sandbox. Contains NO secrets except the ephemeral CDP URL. */
export const FilingPayload = z.object({
  attemptId: z.string(),
  complaintId: z.string(),
  approvedVersion: z.number(),
  target: FilingTarget,
  category: CategoryId,
  /** Absolute URL the worker is allowed to open first (allowlist root). */
  formUrl: z.string().url(),
  /** Hostnames the worker may navigate within. Anything else ⇒ HUMAN_ACTION_REQUIRED. */
  allowedHosts: z.array(z.string()),
  /** Extra HTTP headers for the target (e.g. Daytona preview-warning skip). */
  extraHeaders: z.record(z.string(), z.string()),
  /** Anchor CDP websocket URL (ephemeral) — or null to launch a local browser (dev). */
  cdpUrl: z.string().nullable(),
  liveViewUrl: z.string().nullable(),
  portalMode: PortalMode,
  form: z.object({
    description: z.string(),
    address: z.string().nullable(),
    borough: z.string().nullable(),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    /** Contact fields are only ever user-provided; null means "leave blank / do not invent". */
    contactName: z.string().nullable(),
    contactEmail: z.string().nullable(),
    contactPhone: z.string().nullable(),
    /** ISO date (YYYY-MM-DD) the problem was observed; defaults to today in the bot. */
    dateObserved: z.string().nullable(),
  }),
  limits: z.object({ totalTimeoutMs: z.number(), stepTimeoutMs: z.number(), maxNavigationRetries: z.number() }),
});
export type FilingPayload = z.infer<typeof FilingPayload>;

export const FilingStatus = z.enum(["SUBMITTED", "HUMAN_ACTION_REQUIRED", "SUBMISSION_UNKNOWN", "FAILED"]);
export type FilingStatus = z.infer<typeof FilingStatus>;

export const FilingErrorCode = z.enum([
  "CAPTCHA",
  "LOGIN_REQUIRED",
  "UNEXPECTED_REQUIRED_FIELD",
  "OFF_ALLOWLIST_NAVIGATION",
  "FORM_REJECTED",
  "NO_CONFIRMATION",
  "CONNECTION_LOST_AFTER_SUBMIT",
  "NAVIGATION_FAILED",
  "TIMEOUT",
  "BROWSER_ERROR",
  "WORKER_CRASH",
  "SANDBOX_ERROR",
]);
export type FilingErrorCode = z.infer<typeof FilingErrorCode>;

export const WorkerStep = z.enum(["navigate", "inspect", "fill", "validate", "submit", "confirm"]);

export const WorkerEvent = z.object({
  ts: z.string(),
  step: WorkerStep,
  level: z.enum(["info", "warn", "error"]),
  message: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type WorkerEvent = z.infer<typeof WorkerEvent>;

export const EvidenceFile = z.object({
  /** Path relative to /work/out inside the sandbox, e.g. "03-before-submit.png". */
  name: z.string(),
  type: z.enum(["screenshot", "html", "log", "json"]),
  step: WorkerStep,
  summary: z.string(),
});

/** Written to /work/out/result.json by the worker. The bot re-validates it. */
export const WorkerResult = z.object({
  attemptId: z.string(),
  status: FilingStatus,
  errorCode: FilingErrorCode.nullable(),
  /** ONLY from a parsed confirmation page. Never synthesized. */
  officialRequestNumber: z.string().nullable(),
  officialReceiptUrl: z.string().nullable(),
  /** Raw text of the confirmation region, for the verifier. */
  confirmationText: z.string().nullable(),
  /** Whether the submit action was actually triggered (matters for SUBMISSION_UNKNOWN). */
  submitClicked: z.boolean(),
  finalUrl: z.string().nullable(),
  steps: z.array(WorkerEvent),
  evidence: z.array(EvidenceFile),
  /** One resident-safe sentence from the worker explaining the outcome. */
  message: z.string().nullable().optional(),
  startedAt: z.string(),
  finishedAt: z.string(),
});
export type WorkerResult = z.infer<typeof WorkerResult>;

export const Evidence = z.object({
  id: z.string(),
  attemptId: z.string(),
  complaintId: z.string(),
  type: z.enum(["screenshot", "html", "log", "json", "live_view", "recording"]),
  step: WorkerStep.nullable(),
  summary: z.string(),
  /** Dashboard-servable reference: /api/evidence/:id or external URL. */
  storageReference: z.string(),
  mime: z.string(),
  createdAt: z.string(),
});
export type Evidence = z.infer<typeof Evidence>;

/** Design doc §15.2 */
export const FilingOutcome = z.object({
  complaintId: z.string(),
  attemptId: z.string(),
  status: FilingStatus,
  officialRequestNumber: z.string().optional(),
  officialReceiptUrl: z.string().optional(),
  evidenceReference: z.string().optional(),
  errorCode: FilingErrorCode.optional(),
  /** Human-readable summary for Telegram. */
  message: z.string(),
});
export type FilingOutcome = z.infer<typeof FilingOutcome>;

export const FilingAttempt = z.object({
  id: z.string(),
  complaintId: z.string(),
  approvedVersion: z.number(),
  target: FilingTarget,
  category: CategoryId,
  sandboxId: z.string().nullable(),
  sandboxProvider: z.enum(["daytona", "local"]).nullable(),
  browserSessionId: z.string().nullable(),
  browserProvider: z.enum(["anchor", "local"]).nullable(),
  liveViewUrl: z.string().nullable(),
  recordingUrl: z.string().nullable(),
  outcome: FilingStatus.nullable(),
  errorCode: FilingErrorCode.nullable(),
  officialRequestNumber: z.string().nullable(),
  verified: z.boolean(),
  verificationNotes: z.string().nullable(),
  evidence: z.array(Evidence),
  workerEvents: z.array(WorkerEvent),
  traceId: z.string().nullable(),
  traceUrl: z.string().nullable(),
  timing: z.object({ sandboxMs: z.number().nullable(), browserMs: z.number().nullable(), workerMs: z.number().nullable(), totalMs: z.number().nullable() }),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type FilingAttempt = z.infer<typeof FilingAttempt>;

export const OfficialRequest = z.object({
  id: z.string(),
  complaintId: z.string(),
  officialRequestNumber: z.string(),
  officialCategory: z.string(),
  status: z.string().nullable(),
  statusSource: z.enum(["confirmation", "open-data", "demo-portal"]),
  lastCheckedAt: z.string(),
  receiptUrl: z.string().nullable(),
});
export type OfficialRequest = z.infer<typeof OfficialRequest>;

/** Workflow memory (design doc §11.3): what we learned from previous filing attempts. */
export const WorkflowPattern = z.object({
  id: z.string(),
  target: FilingTarget,
  category: CategoryId,
  /** e.g. "captcha-after-submit", "address-autocomplete-needs-enter", "confirmation-selector" */
  kind: z.string(),
  description: z.string(),
  /** Structured hint consumed by the worker (never overrides allowlist/safety). */
  hint: z.record(z.string(), z.unknown()),
  observedInAttemptId: z.string().nullable(),
  outcome: FilingStatus.nullable(),
  createdAt: z.string(),
});
export type WorkflowPattern = z.infer<typeof WorkflowPattern>;

// ---------------------------------------------------------------------------
// Transport-agnostic conversation events (lets scripts/demo.ts drive the
// orchestrator without Telegram) and outbound messages.
// ---------------------------------------------------------------------------
export const InboundEvent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("command"), chatId: z.string(), updateId: z.string(), command: z.string(), args: z.string(), username: z.string().nullable() }),
  z.object({ kind: z.literal("text"), chatId: z.string(), updateId: z.string(), text: z.string(), username: z.string().nullable() }),
  z.object({ kind: z.literal("photo"), chatId: z.string(), updateId: z.string(), fileId: z.string(), caption: z.string().nullable(), username: z.string().nullable() }),
  z.object({ kind: z.literal("voice"), chatId: z.string(), updateId: z.string(), fileId: z.string(), durationSec: z.number().nullable(), username: z.string().nullable() }),
  z.object({ kind: z.literal("location"), chatId: z.string(), updateId: z.string(), latitude: z.number(), longitude: z.number(), username: z.string().nullable() }),
  z.object({
    kind: z.literal("callback"),
    chatId: z.string(),
    updateId: z.string(),
    /** Encoded as `${action}:${complaintId}:${draftVersion}` — see callbacks.ts */
    data: z.string(),
    messageId: z.number().nullable(),
    username: z.string().nullable(),
  }),
]);
export type InboundEvent = z.infer<typeof InboundEvent>;

export const CallbackAction = z.enum([
  "approve",
  "edit",
  "cancel",
  "dup_review",
  "dup_continue",
  "status",
  "view_official",
  "confirm_location",
  "retry_location",
]);
export type CallbackAction = z.infer<typeof CallbackAction>;

export type OutboundButton = { text: string; data?: string; url?: string };
export type OutboundMessage = {
  chatId: string;
  text: string;
  /** Rows of inline buttons. */
  buttons?: OutboundButton[][];
  /** Ask Telegram for a location share keyboard. */
  requestLocation?: boolean;
  /** Edit an earlier bot message instead of sending a new one. */
  editMessageId?: number;
  photoPath?: string;
  parseMode?: "Markdown" | "HTML";
};

export interface Transport {
  send(msg: OutboundMessage): Promise<{ messageId: number | null }>;
  /** Download a Telegram file to a local path (photos/voice). */
  downloadFile(fileId: string, destDir: string): Promise<{ path: string; mime: string | null }>;
  /** Acknowledge a callback query (spinner off). */
  ackCallback?(callbackQueryId: string, text?: string): Promise<void>;
  typing?(chatId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Service interfaces (implemented in src/services and src/integrations)
// ---------------------------------------------------------------------------
export interface Classifier {
  classify(input: {
    text: string | null;
    imagePaths: string[];
    priorDescription: string | null;
    locationKnown: boolean;
    conversation: string[];
  }): Promise<{ result: ClassificationResult; model: string; usage: { promptTokens: number | null; completionTokens: number | null; costUsd?: number | null } }>;
  /** Optional voice transcription (P2). */
  transcribe?(audioPath: string): Promise<string>;
}

export interface LocationService {
  fromPin(lat: number, lon: number): Promise<ComplaintLocation>;
  fromText(text: string): Promise<ComplaintLocation | null>;
  withinNyc(lat: number, lon: number): boolean;
}

export interface DuplicateService {
  findPotentialDuplicates(args: { category: CategoryId; latitude: number; longitude: number }): Promise<{ candidates: DuplicateCandidate[]; dataAsOf: string | null; source: "open-data" | "unavailable" }>;
  /** Status lookup by official SR number via Open Data (works for real SRs; demo SRs return null). */
  lookupStatus(uniqueKey: string): Promise<DuplicateCandidate | null>;
}

export interface Store {
  backend: string;
  init(): Promise<void>;
  // residents
  getOrCreateResident(chatId: string, username: string | null): Promise<Resident>;
  updateResident(id: string, patch: Partial<Resident>): Promise<Resident>;
  // complaints
  createComplaint(c: ComplaintDraft): Promise<ComplaintDraft>;
  saveComplaint(c: ComplaintDraft): Promise<ComplaintDraft>;
  getComplaint(id: string): Promise<ComplaintDraft | null>;
  getActiveComplaint(chatId: string): Promise<ComplaintDraft | null>;
  listComplaints(args?: { chatId?: string; limit?: number }): Promise<ComplaintDraft[]>;
  recordTransition(complaintId: string, from: ComplaintState, to: ComplaintState, reason: string, actor: "user" | "system" | "llm"): Promise<void>;
  // graph side-tables
  upsertLocation(loc: ComplaintLocation): Promise<string | null>;
  linkDuplicates(complaintId: string, candidates: DuplicateCandidate[]): Promise<void>;
  // filing
  createAttempt(a: FilingAttempt): Promise<FilingAttempt>;
  saveAttempt(a: FilingAttempt): Promise<FilingAttempt>;
  getAttempt(id: string): Promise<FilingAttempt | null>;
  listAttempts(args?: { complaintId?: string; limit?: number }): Promise<FilingAttempt[]>;
  saveOfficialRequest(r: OfficialRequest): Promise<OfficialRequest>;
  listOfficialRequests(chatId: string): Promise<OfficialRequest[]>;
  // telegram idempotency
  markUpdateProcessed(updateId: string): Promise<boolean>; // false if already processed
  // workflow memory
  recordWorkflowPattern(p: WorkflowPattern): Promise<void>;
  getWorkflowPatterns(args: { target: FilingTarget; category: CategoryId }): Promise<WorkflowPattern[]>;
  /** For the dashboard: nodes + edges of the complaint graph. */
  graph(args?: { complaintId?: string }): Promise<{ nodes: { id: string; kind: string; label: string }[]; edges: { from: string; to: string; rel: string }[] }>;
}

export interface SandboxHandle {
  id: string;
  provider: "daytona" | "local";
  /** Public URL of the demo portal hosted inside the sandbox (demo target), else null. */
  portalUrl: string | null;
  portalHeaders: Record<string, string>;
  /** Run the worker with the payload; resolves when result.json exists or on timeout. */
  runWorker(payload: FilingPayload, onEvent: (e: WorkerEvent) => void): Promise<{ result: WorkerResult | null; stdout: string; exitCode: number }>;
  /** Download an evidence file produced by the worker. */
  downloadEvidence(name: string): Promise<Buffer>;
  destroy(): Promise<void>;
}

export interface SandboxProvider {
  name: "daytona" | "local";
  /** Create the isolated worker: upload apps/worker + apps/portal, install deps, start the portal (demo target). */
  provision(args: { attemptId: string; target: FilingTarget; portalMode: PortalMode; onEvent: (msg: string, data?: Record<string, unknown>) => void }): Promise<SandboxHandle>;
}

export interface BrowserSessionInfo {
  id: string;
  provider: "anchor" | "local";
  cdpUrl: string | null;
  liveViewUrl: string | null;
  close(): Promise<void>;
  getRecordingUrl(): Promise<string | null>;
}

export interface BrowserProvider {
  name: "anchor" | "local";
  createSession(args: { attemptId: string; onEvent: (msg: string, data?: Record<string, unknown>) => void }): Promise<BrowserSessionInfo>;
}

export type SpanMessage = { role: string; content?: string };
export interface SpanHelpers {
  set(k: string, v: string | number | boolean): void;
  input(value: unknown): void;
  output(value: unknown): void;
  llm(opts: {
    provider?: string;
    system?: string;
    modelName?: string;
    invocationParameters?: Record<string, unknown>;
    inputMessages?: SpanMessage[];
    outputMessages?: SpanMessage[];
    tokenCount?: { prompt?: number | null; completion?: number | null; total?: number | null };
    costUsd?: number | null;
  }): void;
  retriever(documents: { id: string; content: string; score?: number; metadata?: Record<string, unknown> }[]): void;
  tool(opts: { name: string; description?: string; parameters?: Record<string, unknown> }): void;
  metadata(meta: Record<string, unknown>): void;
}
export interface Tracer {
  span<T>(name: string, attrs: Record<string, string | number | boolean | null | undefined>, fn: (set: SpanHelpers["set"], oi: SpanHelpers) => Promise<T>): Promise<T>;
  /** One Telegram chat == one Phoenix session; complaint id goes in metadata. */
  withSession<T>(session: { sessionId: string; userId?: string; metadata?: Record<string, unknown>; tags?: string[] }, fn: () => Promise<T>): Promise<T>;
  currentTraceId(): string | null;
  traceUrl(traceId: string): string | null;
  sessionUrl(sessionId: string): string | null;
  /** Attach an evaluation result to the current/root span (design doc §13.2). */
  evaluate(name: string, result: { label: string; score?: number; explanation?: string }): void;
  flush(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
export function nowIso() {
  return new Date().toISOString();
}
export function shortId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
}
export function encodeCallback(action: CallbackAction, complaintId: string, version: number) {
  return `${action}:${complaintId}:${version}`;
}
export function decodeCallback(data: string): { action: CallbackAction; complaintId: string; version: number } | null {
  const [a, id, v] = data.split(":");
  const action = CallbackAction.safeParse(a);
  if (!action.success || !id) return null;
  return { action: action.data, complaintId: id, version: Number(v ?? 0) };
}
export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
