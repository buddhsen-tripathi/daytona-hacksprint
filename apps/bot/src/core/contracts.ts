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
// The registry is data-driven: adding a category = one entry here + one worker
// adapter. Street categories were removed for now (git history keeps them).
// ---------------------------------------------------------------------------
export const CategoryId = z.enum([
  "subway-delay", // Buses and Subways (KA-01014) → MTA customer feedback wizard (contact.mta.info), fully automatable
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
  /** NYC Open Data (erm2-nwe9) complaint_type / descriptor values that map to this category. */
  openData: z.object({ complaintType: z.string(), descriptors: z.array(z.string()) }),
  /** Fields the draft must have before READY_FOR_APPROVAL. "transit" = line + direction (+ optional station/time). */
  requiredFields: z.array(z.enum(["location", "description", "transit"])),
  /** Whether NYC Open Data has records for this category (duplicate check + status). */
  openDataBacked: z.boolean().default(true),
  /** Whether the official form needs the resident's first + last name before approval (/name gate). */
  requiresContactName: z.boolean().default(false),
  /** Short guidance used in prompts + /help. */
  guidance: z.string(),
});
export type CategoryDefinition = z.infer<typeof CategoryDefinition>;

export const CATEGORIES: Record<CategoryId, CategoryDefinition> = {
  "subway-delay": {
    id: "subway-delay",
    label: "Subway delay",
    officialLabel: "MTA Customer Feedback — Subways › Complaint › Service and schedule › Delay",
    articleUrl: "https://portal.311.nyc.gov/article/?kanumber=KA-01014",
    officialFormUrl: "https://contact.mta.info/s/customer-feedback",
    openData: { complaintType: "", descriptors: [] },
    requiredFields: ["transit", "description"],
    openDataBacked: false,
    requiresContactName: false,
    guidance:
      "A subway train or line that was delayed, held, or significantly late. NYC311 does not take these; they go to the MTA's customer feedback form. Needs the line (e.g. A, 7, L), the direction (uptown/downtown or terminal), optionally the nearest station, and when it happened.",
  },
};

// ---------------------------------------------------------------------------
// NYC311 category catalog (#7): every "Report Problems" article, where it is
// filed and how far we can automate it. A routing superset of CATEGORIES:
// CategoryId stays the filing allowlist, and a catalog entry is only fileable
// when `automation` names a worker adapter.
// ---------------------------------------------------------------------------
export const CatalogChannel = z.enum([
  "nyc311-sr-form", // NYC311 service request on portal.311.nyc.gov
  "agency-form", // a City agency's own online form (nyc.gov, *.aspx, …)
  "external-site", // a non-City organization (e.g. MTA contact.mta.info)
  "phone-only", // no online route; call the listed number
  "info-only", // information only, nothing to file
]);
export type CatalogChannel = z.infer<typeof CatalogChannel>;

/** "none" | "handoff" (open the official link, a human submits) | "adapter:<worker adapter id>". */
export const CatalogAutomation = z.string().regex(/^(none|handoff|adapter:[a-z0-9-]+)$/);
export type CatalogAutomation = z.infer<typeof CatalogAutomation>;

export const CatalogEntry = z.object({
  /** Stable slug ("noise-from-neighbor"); equals the CategoryId for entries in CATEGORIES. */
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string(),
  kaNumber: z.string().regex(/^KA-\d+$/),
  /** NYC311 knowledge article. */
  articleUrl: z.string().url(),
  summary: z.string(),
  /** DOT, DSNY, HPD, MTA, NYPD, …; null when the article names none. */
  agency: z.string().nullable(),
  /** The "All A–Z" / "All by category" group the article sits in. */
  topic: z.string().nullable(),
  channel: CatalogChannel,
  /** The actual submission link, resolved from the article's "Report"/"File" buttons. */
  officialUrl: z.string().url().nullable(),
  requiresLogin: z.boolean().nullable(),
  hasCaptcha: z.boolean().nullable(),
  /** null until learned from runs (#11). */
  requiredFields: z.array(z.string()).nullable(),
  automation: CatalogAutomation,
  lastVerifiedAt: z.string(),
  /** A "Call 911" article (gas leak, fire, overdose, …): route to the 911 referral, never to a form. */
  emergency: z.boolean().default(false),
  /** Merged form structure learned from filing runs (#11, structure only); absent until a run reported one. */
  formSchema: z.lazy(() => FormSchema).nullable().optional(),
});
export type CatalogEntry = z.infer<typeof CatalogEntry>;

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
  DUPLICATE_REVIEW: ["READY_FOR_APPROVAL", "NEEDS_INFORMATION", "TRACKING", "CANCELLED"],
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
  /** #5: "Add me to the existing report" — the resident joins another resident's report; nothing is filed. */
  "DUPLICATE_REVIEW->TRACKING",
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
// Transit details (subway categories). Values must come from the user.
// ---------------------------------------------------------------------------
export const SUBWAY_LINES = ["1", "2", "3", "4", "5", "6", "7", "A", "C", "E", "B", "D", "F", "M", "N", "Q", "R", "W", "G", "L", "J", "Z", "S-42 Street Shuttle", "S-Franklin Av Shuttle", "S-Rockaway Park Shuttle", "Staten Island Railway"] as const;
export const TransitDetails = z.object({
  /** One of SUBWAY_LINES (canonical), or null if the user has not said. */
  line: z.string().nullable(),
  /** Free text as the user said it, e.g. "downtown", "uptown", "Manhattan-bound", "toward Coney Island". */
  direction: z.string().nullable(),
  /** Nearest station as the user said it, or null. */
  station: z.string().nullable(),
  borough: z.string().nullable(),
  /** ISO datetime of the incident if the user gave a time ("this morning at 8:30"), else null. */
  incidentTime: z.string().nullable(),
  /** Minutes delayed if stated. */
  delayMinutes: z.number().nullable(),
});
export type TransitDetails = z.infer<typeof TransitDetails>;
export const EMPTY_TRANSIT: TransitDetails = { line: null, direction: null, station: null, borough: null, incidentTime: null, delayMinutes: null };

// ---------------------------------------------------------------------------
// Classification (LLM output, Zod-validated; backend re-validates category)
// ---------------------------------------------------------------------------
/** Stage 2 of the router: the LLM's pick among retrieved catalog candidates. The catalog is the allowlist. */
export const CatalogRoute = z.object({
  /** A CatalogEntry id, or null when no candidate fits (EMERGENCY / UNCLEAR / nothing matches). */
  catalogId: z.string().nullable(),
  /** 0..1 for catalogId; < ROUTE_CONFIDENCE_THRESHOLD ⇒ ask "Which of these is it?" with the top 3. */
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
  /** Up to 3 other candidate ids, best first. */
  alternatives: z.array(z.string()),
});
export type CatalogRoute = z.infer<typeof CatalogRoute>;

export const ROUTE_CONFIDENCE_THRESHOLD = 0.6;

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
  /** Why the alternative category was rejected, when relevant (e.g. one category vs a similar one, or vs OUT_OF_SCOPE). */
  alternativeConsidered: z.string().nullable(),
  /** Signals of danger that justify EMERGENCY. */
  safetyFlags: z.array(z.string()),
  /** The single most useful clarifying question when triage === UNCLEAR, else null. */
  clarifyingQuestion: z.string().nullable(),
  /** Transit details extracted from the text for subway categories; null when not applicable or not mentioned. Never invented. */
  transit: TransitDetails.nullable().optional(),
  /** Two-stage router (#8): the NYC311 catalog entry this report belongs to. Optional for older rows / fallbacks. */
  route: CatalogRoute.nullable().optional(),
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
  /** Transit details for subway categories (merged across messages; conversation memory). */
  transit: TransitDetails.nullable().optional(),
  /** Answers to questions learned from earlier filings (workflow memory, "ask-before-approval"); field → user's answer. */
  extraFields: z.record(z.string(), z.string()).optional(),
  missingFields: z.array(z.enum(["location", "description", "category", "transit"])),
  needsEmergencyReferral: z.boolean(),
  confidence: z.number(),
  duplicates: z.array(DuplicateCandidate),
  /** User chose to continue despite duplicates (or none found). */
  duplicateReviewed: z.boolean(),
  /** `dataAsOf` of the Open Data snapshot used for the last duplicate check (null = unavailable / not checked). */
  duplicatesDataAsOf: z.string().nullable().optional(),
  /** #5: this complaint is a supporter of another resident's report (`complaint->same_issue_as->complaint`); never filed. */
  sameIssueAs: z.string().nullable().optional(),
  /** #5: how many residents joined this report via "Add me to the existing report" (count of incoming same_issue_as edges). */
  supporters: z.number().optional(),
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
  /** Conversation memory for real filings: some official forms require first + last name (CategoryDefinition.requiresContactName). Only ever user-provided. */
  contactName: z.string().nullable().default(null),
  contactEmail: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type Resident = z.infer<typeof Resident>;

// ---------------------------------------------------------------------------
// Filing: payload handed to the isolated worker, and what it returns
// ---------------------------------------------------------------------------
/** Every filing targets the official form (today: the MTA Customer Feedback wizard for subway delays). */
export const FilingTarget = z.literal("real");
export type FilingTarget = z.infer<typeof FilingTarget>;

/**
 * Declarative form recipe (#9) run by the worker's recipe adapter (apps/worker/src/adapters/recipe.ts documents the
 * step grammar and validates it strictly). Stored in procedural memory / fixtures/recipes/<categoryId>.json.
 */
export const FormRecipe = z.object({
  id: z.string(),
  /** Must equal FilingPayload.category. */
  categoryId: z.string().regex(/^[a-z0-9-]+$/),
  version: z.number(),
  description: z.string().optional(),
  /** One key per step: open | click | choose | continue | inspect | pick | fill | when | submitIf | confirm. */
  steps: z.array(z.record(z.string(), z.unknown())).min(1),
});
export type FormRecipe = z.infer<typeof FormRecipe>;

/** Written to /work/payload.json inside the sandbox. Contains NO secrets except the ephemeral CDP URL. */
export const FilingPayload = z.object({
  attemptId: z.string(),
  complaintId: z.string(),
  approvedVersion: z.number(),
  target: FilingTarget,
  category: CategoryId,
  /**
   * Optional (#9): how the worker should file this category, as in CatalogEntry.automation. Absent ⇒ the worker's
   * registry default for `category` (subway-delay → adapter:mta-subway-delay). "handoff" ⇒ open formUrl, prefill, never submit.
   */
  automation: CatalogAutomation.optional(),
  /** Optional (#9): the recipe for `automation: "adapter:recipe"`. */
  recipe: FormRecipe.optional(),
  /** Absolute URL the worker is allowed to open first (allowlist root). */
  formUrl: z.string().url(),
  /** Hostnames the worker may navigate within. Anything else ⇒ HUMAN_ACTION_REQUIRED. */
  allowedHosts: z.array(z.string()),
  /** Extra HTTP headers for the target (currently always {}). */
  extraHeaders: z.record(z.string(), z.string()),
  /** Anchor CDP websocket URL (ephemeral) — or null to launch a local browser (dev). */
  cdpUrl: z.string().nullable(),
  liveViewUrl: z.string().nullable(),
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
    /** Subway categories only. */
    transit: TransitDetails.nullable().optional(),
    /** User answers to questions learned from earlier filings (field → answer); the worker may use them for unexpected required inputs by label match. */
    extraFields: z.record(z.string(), z.string()).optional(),
  }),
  /**
   * True ONLY when the resident explicitly approved AND env ALLOW_REAL_SUBMIT=1.
   * Real-site adapters must never click the final Submit unless this is true.
   */
  realSubmitAuthorized: z.boolean().optional(),
  /**
   * questionTimeoutMs: how long the worker's ctx.ask() waits for the resident (worker default 180000).
   * 0 ⇒ no live questions (the original HUMAN_ACTION_REQUIRED outcome is returned immediately).
   */
  limits: z.object({ totalTimeoutMs: z.number(), stepTimeoutMs: z.number(), maxNavigationRetries: z.number(), questionTimeoutMs: z.number().optional() }),
});
export type FilingPayload = z.infer<typeof FilingPayload>;

export const DEFAULT_QUESTION_TIMEOUT_MS = 180_000;

/**
 * Live follow-up question from the worker (design: "pause, ask the resident, continue in the same browser").
 * The worker writes <out>/question-<id>.json and emits `EVT {"message":"question","data":{"question":…}}`;
 * the bot answers by writing <out>/answer-<id>.json (SandboxHandle.answerQuestion).
 */
export const WorkerQuestion = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,24}$/),
  field: z.enum(["direction", "station", "contact_name", "contact_email", "free_text"]),
  /** Resident-facing, no PII. */
  prompt: z.string(),
  options: z.array(z.string()).optional(),
  required: z.boolean(),
});
export type WorkerQuestion = z.infer<typeof WorkerQuestion>;
export const WorkerAnswer = z.object({ value: z.string(), optionIndex: z.number().int().optional() });
export type WorkerAnswer = z.infer<typeof WorkerAnswer>;

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
  "NO_ADAPTER", // #9: the worker has no adapter for this category/automation; nothing was opened
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

/** The question carried by a worker `question` event, or null for any other event. */
export function questionFromEvent(e: WorkerEvent): WorkerQuestion | null {
  if (e.message !== "question") return null;
  const q = WorkerQuestion.safeParse(e.data?.question);
  return q.success ? q.data : null;
}

export const EvidenceFile = z.object({
  /** Path relative to /work/out inside the sandbox, e.g. "03-before-submit.png". */
  name: z.string(),
  type: z.enum(["screenshot", "html", "log", "json"]),
  step: WorkerStep,
  summary: z.string(),
});

/**
 * Observed structure of one form control (procedural memory input, issue #11). STRUCTURE ONLY: never a value the
 * resident typed or chose. `options` are the form's own labels (choice buttons / select / radio).
 */
export const FormFieldType = z.enum(["text", "textarea", "select", "radio", "checkbox", "button-choice", "date", "time", "file", "unknown"]);
export type FormFieldType = z.infer<typeof FormFieldType>;
export const FormField = z.object({
  label: z.string(),
  type: FormFieldType,
  required: z.boolean(),
  options: z.array(z.string()).optional(),
  /** Attribute maxlength, or the visible "0/4000" counter; null when unknown. */
  maxLength: z.number().nullable().optional(),
  /** Title of the wizard step / page section this field was seen on. */
  step: z.string(),
  /** Playwright selector that found it (role/label/placeholder based), e.g. `role=textbox[name="Email (optional)"]`. */
  selectorHint: z.string().optional(),
});
export type FormField = z.infer<typeof FormField>;
/** Merged, ordered per-step schema observed during one run. Emitted per step as `EVT {"step":"inspect","message":"form_schema"}`. */
export const FormSchema = z.object({
  steps: z.array(z.object({ title: z.string(), fields: z.array(FormField) })),
  capturedAt: z.string(),
});
export type FormSchema = z.infer<typeof FormSchema>;

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
  /** Form structure observed during this run (additive; null/absent when nothing was captured). */
  formSchema: FormSchema.nullable().optional(),
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
  statusSource: z.enum(["confirmation", "open-data"]),
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
// Transport-agnostic conversation events (lets the scripted runner drive the
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
  "dup_join", // #5: "Add me to the existing report" (same issue already raised by another resident)
  "view_official",
  "confirm_location",
  "retry_location",
  "set_direction", // subway: data `set_direction:<id>:<version>:d=0|1` (MTA form direction option index)
  "set_time", // subway: data `set_time:<id>:<version>:now|later`
  "answer_q", // live worker question: data `answer_q:<id>:<version>:<questionId>:<optionIndex>`
  "set_field", // #12 learned form field: data `set_field:<id>:<version>:<fieldIndex>:<optionIndex|t|s>` (t = today, s = skip an optional field)
  "route_pick", // router (#8) "Which of these is it?": data `route_pick:<id>:<version>:<i>` (index into route choices; ids can exceed Telegram's 64-byte limit)
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
  /** Local MP4 to upload with sendVideo (≤ 50 MB); used for the filing session recording. */
  videoPath?: string;
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
  /** Status lookup by official SR number via Open Data (NYC311 SRs; MTA references return null). */
  lookupStatus(uniqueKey: string): Promise<DuplicateCandidate | null>;
}

/** Remembered issues (design doc §8.1 context collector). */
export type RelatedComplaintsQuery = {
  /** The draft being reviewed (excluded from results). */
  complaintId: string;
  chatId: string;
  category: CategoryId;
  /** Subway: canonical line (filters doc.transit.line). */
  line?: string | null;
  /** Street categories: point to search around (geo::distance). */
  lat?: number | null;
  lon?: number | null;
  radiusMeters?: number;
  /** The resident's own reports newer than this (default 24 h). */
  sinceMs?: number;
  /** Other residents' reports newer than this (default 2 h). */
  othersSinceMs?: number;
};
export type RelatedComplaint = {
  id: string;
  status: ComplaintState;
  createdAt: string;
  officialRequestNumber: string | null;
  statusReason: string | null;
  line: string | null;
  distanceMeters: number | null;
};
export type RelatedComplaints = {
  mine: RelatedComplaint[];
  /** Other residents: counts only (no PII leaves the store layer except complaint ids for graph edges). */
  others: { reports: number; residents: number; latestAt: string | null; oldestAt: string | null; ids: string[] };
};

/** #5 duplicate awareness across residents: the same-issue edges around one complaint (complaint ids only, never chat ids). */
export type IssueLinks = {
  /** This complaint joined that original (`->same_issue_as->`), or null. */
  sameIssueAs: string | null;
  /** Supporters that joined this complaint (`<-same_issue_as<-`), oldest first. */
  joined: string[];
  /** The resident said this is different from these (`->not_same_as->`); never prompted about them again. */
  notSameAs: string[];
  /** `joined.length` (also cached on the original as `ComplaintDraft.supporters`). */
  supporters: number;
};

// ---------------------------------------------------------------------------
// Agent memory (issue #4): one memory stream of episodic / semantic / procedural
// items, recalled by relevance × recency × importance (services/agent-memory.ts).
// `text` is always neutral (classifier description, form prompts, official
// labels); never contact fields or a resident's free-typed answer.
// ---------------------------------------------------------------------------
export const MemoryKind = z.enum([
  "episodic", // what happened: drafts ready for approval, filing outcomes, live questions + answers
  "semantic", // facts about the world: categories, agencies, required fields
  "procedural", // how to do things: form recipes, ask-before-approval rules, reflection lessons (#24)
]);
export type MemoryKind = z.infer<typeof MemoryKind>;

/** Graph targets of `memory->about->…` (SurrealDB relation; the memory store keeps them as plain refs). */
export type MemoryAboutTable = "complaint" | "complaint_category" | "filing_attempt";
export type MemoryAboutRef = { table: MemoryAboutTable; id: string };

/** What a caller hands to `AgentMemory.remember()`. */
export type MemoryItem = {
  /** Deterministic id ⇒ idempotent upsert (e.g. `mem_seed_<category>`); omitted ⇒ generated. */
  id?: string;
  kind: MemoryKind;
  /** Neutral, PII-free text: what gets embedded and shown in explanations. */
  text: string;
  /** Category id (string so catalog categories from #7 fit without a contract change). */
  category?: string | null;
  /** Owning resident (Telegram chat id); null for world facts. Never shown to other residents. */
  chatId?: string | null;
  /** Subway line, for `scope.line` filtering. */
  line?: string | null;
  /** Point, for `scope.geo` filtering. */
  geo?: { lat: number; lon: number } | null;
  /** 0..1, set at write time (a confirmed filing > a cancelled draft). Default 0.5. */
  importance?: number;
  /** Structured payload (ids, counts, option labels). JSON-safe, PII-free. */
  data?: Record<string, unknown>;
  /** `complaint:<id>` | `attempt:<id>` | `trace:<id>` | `seed`. */
  source: string;
  /** Edges `memory->about->(complaint|complaint_category|filing_attempt)`. */
  about?: MemoryAboutRef[];
  /** ISO time; default now. */
  createdAt?: string;
};

/** A persisted memory row (Store layer). */
export type MemoryRecord = Required<Omit<MemoryItem, "id" | "createdAt">> & {
  id: string;
  createdAt: string;
  /** Embedding vector (null when no embedder was available at write time). */
  embedding: number[] | null;
  /** Model that produced `embedding` (vectors are only compared within one model). */
  embedModel: string | null;
};

/** Low-level search (Store layer): structural filters + cosine similarity; ranking happens in AgentMemory. */
export type MemorySearch = {
  embedding?: number[] | null;
  embedModel?: string | null;
  kind?: MemoryKind;
  category?: string | null;
  /** Set ⇒ only this resident's items + world facts (chatId null). Never other residents'. */
  chatId?: string | null;
  line?: string | null;
  geo?: { lat: number; lon: number; radiusMeters: number } | null;
  /** Only items created within the last `sinceMs`. */
  sinceMs?: number;
  /** Only items with an `about` edge to this ref. */
  about?: MemoryAboutRef | null;
  /** Clock for `sinceMs` (default Date.now()). */
  nowMs?: number;
  limit: number;
};
/** Search hit: the row (without the vector) + cosine similarity when comparable (same model + dims), else null. */
export type MemoryHit = Omit<MemoryRecord, "embedding"> & { similarity: number | null };

export type MemoryScoreBreakdown = {
  /** 0..1: cosine similarity (clamped) or keyword overlap, 0 when there is no query text. */
  relevance: number;
  relevanceKind: "cosine" | "keyword" | "none";
  /** 0..1: 0.5^(age / halfLife), halfLife = 7 days. */
  recency: number;
  importance: number;
  ageMs: number;
  /** The weights used: score = w.relevance·relevance + w.recency·recency + w.importance·importance. */
  weights: { relevance: number; recency: number; importance: number };
};
export type ScoredMemory = Omit<MemoryRecord, "embedding"> & { score: number; breakdown: MemoryScoreBreakdown };

export type MemoryRecallQuery = {
  text?: string;
  kind?: MemoryKind;
  scope?: { chatId?: string | null; category?: string | null; line?: string | null; geo?: { lat: number; lon: number; radiusMeters?: number } | null };
  sinceMs?: number;
  /** Only items about this complaint / attempt / category. */
  about?: MemoryAboutRef;
  limit?: number;
  /**
   * #22: max wait for the query embedding. Past it, recall proceeds without a query vector (keyword relevance);
   * the embedding finishes in the background and is cached, so the next recall of the same text is semantic.
   */
  embedBudgetMs?: number;
};

export interface AgentMemory {
  /** Persist one item (embedded when an embedder is configured). Returns its id. */
  remember(item: MemoryItem): Promise<string>;
  /** Scored recall: score = 0.5·relevance + 0.3·recency + 0.2·importance, highest first, with the breakdown. */
  recall(q: MemoryRecallQuery): Promise<ScoredMemory[]>;
  /**
   * Reflexion-style lesson after an attempt: shared, category-scoped procedural item (chatId null), source
   * `attempt:<id>`, about→filing_attempt. Dropped with a warning if the attempt/category can't be resolved or the
   * lesson carries PII or quotes a resident field (#24).
   */
  reflect(attemptId: string, lesson: string, data?: Record<string, unknown>): Promise<void>;
  /** Resolves when every in-flight remember() has settled (tests / scripts). */
  flush(): Promise<void>;
  /** Fire-and-forget: embed `text` now so a later recall() for the same text is served from cache. Never throws. */
  warm?(text: string): void;
}

/** Text → vectors. `model` labels the vectors so different models are never compared. */
export interface Embedder {
  readonly model: string;
  readonly dim: number;
  embed(texts: string[]): Promise<{ model: string; vectors: number[][] }>;
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
  /** Remembered issues: related complaints (same category; same line / within 100 m). Optional so test doubles stay small. */
  findRelatedComplaints?(args: RelatedComplaintsQuery): Promise<RelatedComplaints>;
  /** complaint->similar_to->complaint edges (dashboard cluster). */
  linkSimilarComplaints?(complaintId: string, similarIds: string[]): Promise<void>;
  /** NYC311 category catalog (#7): upsert complaint_category rows by id; returns the count written. */
  upsertCatalog?(entries: CatalogEntry[]): Promise<number>;
  listCatalog?(): Promise<CatalogEntry[]>;
  /**
   * #11: write the form structure learned from filing runs onto `complaint_category:<id>` (requiredFields = union of
   * the form's required labels, merged formSchema, lastVerifiedAt). Later catalog upserts / boot seeds keep a learned
   * requiredFields list.
   */
  updateCategorySchema?(id: string, learned: { requiredFields: string[]; formSchema: FormSchema; lastVerifiedAt: string }): Promise<void>;
  /** #5: RELATE supporter->same_issue_as->original and refresh `supporters` on the original. Returns the new count. */
  linkSameIssue?(supporterId: string, originalId: string): Promise<number>;
  /** #5: RELATE complaint->not_same_as->other (the resident said it's a different issue). */
  linkNotSameIssue?(complaintId: string, otherId: string): Promise<void>;
  /** #5: same_issue_as / not_same_as edges around one complaint. */
  getIssueLinks?(complaintId: string): Promise<IssueLinks>;
  /** For the dashboard: nodes + edges of the complaint graph. */
  graph(args?: { complaintId?: string }): Promise<{ nodes: { id: string; kind: string; label: string }[]; edges: { from: string; to: string; rel: string }[] }>;
  // agent memory (#4) — low-level; use AgentMemory (services/agent-memory.ts). Optional so test doubles stay small.
  /** Upsert by id + RELATE memory->about->… */
  insertMemory?(row: MemoryRecord): Promise<void>;
  /** Structural filters + cosine similarity (same embedModel + dims), most similar first, else newest first. */
  searchMemory?(q: MemorySearch): Promise<MemoryHit[]>;
  /** Newest first (no vectors). */
  listMemory?(args?: { kind?: MemoryKind; category?: string; chatId?: string; source?: string; about?: MemoryAboutRef; limit?: number }): Promise<Omit<MemoryRecord, "embedding">[]>;
  /** #22: rows not embedded by `model` (fallback vectors / none), oldest first — candidates for re-embedding. */
  listMemoryNeedingEmbedding?(args: { model: string; limit: number }): Promise<{ id: string; text: string; embedModel: string | null }[]>;
  /** #22: replace one row's vector (re-embedding); everything else on the row is unchanged. */
  setMemoryEmbedding?(id: string, embedding: number[], embedModel: string): Promise<void>;
  /** Post-mortem repair proposals (#13). Optional so existing stores/test doubles keep compiling. */
  saveRepairProposal?(p: RepairProposal): Promise<RepairProposal>;
  getRepairProposal?(id: string): Promise<RepairProposal | null>;
  listRepairProposals?(args?: { status?: RepairProposal["status"]; limit?: number }): Promise<RepairProposal[]>;
}

export interface SandboxHandle {
  id: string;
  provider: "daytona" | "local";
  /** Run the worker with the payload; resolves when result.json exists or on timeout. */
  runWorker(payload: FilingPayload, onEvent: (e: WorkerEvent) => void): Promise<{ result: WorkerResult | null; stdout: string; exitCode: number }>;
  /** Answer a live worker question (writes <out>/answer-<id>.json). Absent ⇒ questions are disabled for this sandbox. */
  answerQuestion?(questionId: string, answer: WorkerAnswer): Promise<void>;
  /** Download an evidence file produced by the worker. */
  downloadEvidence(name: string): Promise<Buffer>;
  destroy(): Promise<void>;
}

export interface SandboxProvider {
  name: "daytona" | "local";
  /** Create the isolated worker: upload apps/worker, install deps (+ the CDP relay to Anchor where needed). */
  provision(args: { attemptId: string; onEvent: (msg: string, data?: Record<string, unknown>) => void }): Promise<SandboxHandle>;
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
  /** string[] for list attributes (e.g. `form.required_fields`, #11). */
  set(k: string, v: string | number | boolean | string[]): void;
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

// ---------------------------------------------------------------------------
// Post-mortem self-repair (#13). Additive. A failed/ambiguous attempt is
// diagnosed by the LLM into a RepairProposal; proposals are applied only after
// human approval, except `requiredField` additions with confidence >= 0.9.

export const RepairCause = z.enum(["missing_required_field", "selector_changed", "new_step", "confirmation_pattern", "captcha", "unknown"]);
export type RepairCause = z.infer<typeof RepairCause>;

export const RepairChange = z.object({
  kind: z.enum(["requiredField", "recipeStep", "confirmRegex", "questionText"]),
  /** Previous value (null when the change is an addition). */
  before: z.string().nullable(),
  after: z.string(),
  /** Evidence ids (Evidence.id) backing this change. */
  evidence: z.array(z.string()),
});
export type RepairChange = z.infer<typeof RepairChange>;

/** Strict LLM output for the post-mortem diagnosis. */
export const RepairDiagnosis = z.object({
  cause: RepairCause,
  proposedChanges: z.array(RepairChange),
  confidence: z.number().min(0).max(1),
});
export type RepairDiagnosis = z.infer<typeof RepairDiagnosis>;

export const RepairProposal = RepairDiagnosis.extend({
  id: z.string(),
  attemptId: z.string(),
  complaintId: z.string(),
  category: CategoryId,
  status: z.enum(["pending", "approved", "rejected"]),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  /** Who decided: the deterministic auto-apply guard or an operator on the dashboard (absent ⇒ pending / legacy rows). */
  decidedBy: z.enum(["auto", "operator"]).nullable().optional(),
  /** `requiredField` labels actually written to the catalog (auto-apply or approval). Other kinds stay proposal-only. */
  applied: z.array(z.string()).optional(),
});
export type RepairProposal = z.infer<typeof RepairProposal>;

/** Auto-apply threshold for `requiredField` additions (never for anything affecting submit). */
export const REPAIR_AUTO_APPLY_CONFIDENCE = 0.9;
