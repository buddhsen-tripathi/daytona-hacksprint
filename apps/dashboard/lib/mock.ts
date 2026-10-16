/**
 * Mock data for `?mock=1` — lets the dashboard render before / without the bot API.
 * Shapes follow apps/bot/src/core/contracts.ts exactly.
 */
import { mockCatalog } from "./catalog";
import type {
  ComplaintDetail,
  ComplaintDraft,
  Evidence,
  FilingAttempt,
  GraphResponse,
  Transition,
  WorkerEvent,
  WorkflowPattern,
} from "./types";

const BASE = Date.parse("2026-10-16T14:41:00Z");
const t = (sec: number) => new Date(BASE + sec * 1000).toISOString();

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Fake form screenshot rendered as SVG so mock mode needs no binary assets. */
function shot(opts: { step: string; title: string; fields?: [string, string][]; banner?: { tone: "ok" | "warn"; text: string; big?: string } }) {
  const { step, title, fields = [], banner } = opts;
  let y = 150;
  const rows = fields
    .map(([k, v]) => {
      const r = `<text x="48" y="${y}" font-size="13" fill="#3b3b3b" font-family="Arial">${esc(k)}</text>
<rect x="48" y="${y + 8}" width="544" height="30" rx="3" fill="#fff" stroke="#9aa3ad"/>
<text x="58" y="${y + 28}" font-size="13" fill="#111" font-family="Arial">${esc(v)}</text>`;
      y += 58;
      return r;
    })
    .join("");
  const bannerSvg = banner
    ? `<rect x="48" y="${y + 6}" width="544" height="${banner.big ? 96 : 52}" rx="4" fill="${banner.tone === "ok" ? "#e3f3e8" : "#fff4d6"}" stroke="${banner.tone === "ok" ? "#2e7d4f" : "#c08a12"}"/>
<text x="64" y="${y + 34}" font-size="14" font-weight="bold" fill="${banner.tone === "ok" ? "#1f5e3a" : "#7a5408"}" font-family="Arial">${esc(banner.text)}</text>
${banner.big ? `<text x="64" y="${y + 80}" font-size="26" font-weight="bold" fill="#111" font-family="Courier New, monospace">${esc(banner.big)}</text>` : ""}`
    : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="450" viewBox="0 0 640 450">
<rect width="640" height="450" fill="#f6f7f9"/>
<rect width="640" height="28" fill="#e9ecef"/>
<text x="16" y="18" font-size="11" fill="#444" font-family="Arial">contact.mta.info/s/customer-feedback · mock screenshot</text>
<rect y="28" width="640" height="54" fill="#0039a6"/>
<text x="24" y="62" font-size="20" font-weight="bold" fill="#fff" font-family="Arial">MTA</text>
<text x="84" y="62" font-size="13" fill="#d6e0f5" font-family="Arial">Customer Feedback</text>
<text x="48" y="118" font-size="18" font-weight="bold" fill="#0039a6" font-family="Arial">${esc(title)}</text>
${rows}${bannerSvg}
<rect x="500" y="414" width="128" height="24" rx="12" fill="#111" opacity="0.75"/>
<text x="564" y="430" font-size="11" fill="#fff" text-anchor="middle" font-family="Courier New, monospace">${esc(step)}</text>
</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const SR = "05583120";
const FORM = "https://contact.mta.info/s/customer-feedback";
const TELL_US_MORE =
  "\"The A train sat at 14 St for 25 minutes this morning, downtown\" · Line A · Downtown & Queens · Nearest station 14 St · Delay 25 min";
const TRANSIT_OK = { line: "A", direction: "downtown", station: "14 St", borough: "Manhattan", incidentTime: "2026-10-16T08:20:00-04:00", delayMinutes: 25 };

const okFields: [string, string][] = [
  ["Details", "A / Downtown & Queens / 14 St"],
  ["When did this happen?", "10/16/2026 · 8:20 am"],
  ["Tell us more (Required)", "\"The A train sat at 14 St for 25 minutes…\""],
];

const evidenceOk: Evidence[] = [
  { step: "navigate", title: "Customer Feedback", summary: "Opened allowlisted form contact.mta.info/s/customer-feedback", fields: [] },
  { step: "inspect", title: "Which service?", summary: "Subways › Complaint or issue › Service and schedule › Delay", fields: [["Service", "Subways"], ["I have a…", "Complaint or issue"], ["About…", "Delay"]] },
  { step: "fill", title: "Tell us more", summary: "Line A, Downtown & Queens, 14 St; description and time filled; contact left blank", fields: okFields },
  { step: "validate", title: "Contact details", summary: "Breadcrumb Details: A / Downtown & Queens / 14 St matches approved draft v3", fields: okFields, banner: { tone: "ok" as const, text: "All required fields complete" } },
  { step: "submit", title: "Contact details", summary: "Clicked Submit your feedback once", fields: okFields.slice(0, 2), banner: { tone: "ok" as const, text: "Submitting…" } },
  { step: "confirm", title: "Thank you for your feedback", summary: `Parsed confirmation: case number ${SR}`, fields: [], banner: { tone: "ok" as const, text: "We received your feedback. Case number:", big: SR } },
].map((e, i) => ({
  id: `ev_ok_${i + 1}`,
  attemptId: "att_ok7f2",
  complaintId: "mock",
  type: "screenshot" as const,
  step: e.step as Evidence["step"],
  summary: e.summary,
  storageReference: shot({ step: `0${i + 1}-${e.step}`, title: e.title, fields: e.fields as [string, string][], banner: e.banner }),
  mime: "image/svg+xml",
  createdAt: t(300 + i * 6),
}));

const evidenceHandoff: Evidence[] = [
  { step: "navigate", summary: "Opened allowlisted form contact.mta.info/s/customer-feedback", banner: undefined },
  { step: "inspect", summary: "Direction \"Brooklyn-bound\" matches neither A option; asked the rider, no answer in 180 s", banner: { tone: "warn" as const, text: "Which direction?  Uptown (Inwood-207 St) / Downtown & Queens" } },
].map((e, i) => ({
  id: `ev_ho_${i + 1}`,
  attemptId: "att_ho91",
  complaintId: "mock-handoff",
  type: "screenshot" as const,
  step: e.step as Evidence["step"],
  summary: e.summary,
  storageReference: shot({ step: `0${i + 1}-${e.step}`, title: "Which direction?", fields: [["Service", "Subways"], ["Line", "A Line"]], banner: e.banner }),
  mime: "image/svg+xml",
  createdAt: t(1300 + i * 5),
}));

const ev = (ts: number, step: WorkerEvent["step"], message: string, level: WorkerEvent["level"] = "info", data?: Record<string, unknown>): WorkerEvent => ({ ts: t(ts), step, level, message, data });

const attemptOk: FilingAttempt = {
  id: "att_ok7f2",
  complaintId: "mock",
  approvedVersion: 3,
  target: "real",
  category: "subway-delay",
  sandboxId: "dtn-5c1e9a42",
  sandboxProvider: "daytona",
  browserSessionId: "anc_8d03f1b7",
  browserProvider: "anchor",
  liveViewUrl: "https://live.anchorbrowser.io/?sessionId=anc_8d03f1b7",
  recordingUrl: "https://storage.anchorbrowser.io/recordings/anc_8d03f1b7.mp4",
  outcome: "SUBMITTED",
  errorCode: null,
  officialRequestNumber: SR,
  verified: true,
  verificationNotes: "Reference matches [A-Z0-9-]{5,}; confirmation text present; confirmation screenshot 06-confirm.png present.",
  evidence: evidenceOk,
  workerEvents: [
    ev(296, "navigate", "connectOverCDP ok (anchor)"),
    ev(298, "navigate", `GET ${FORM} → 200`),
    ev(300, "inspect", "Subways › Complaint or issue › Service and schedule › Delay"),
    ev(303, "inspect", "workflow memory: continue-disabled-until-choice applied", "info", { pattern: "wp_continue_wait" }),
    ev(306, "fill", "line ← A Line"),
    ev(307, "fill", "direction ← A Train-Downtown & Queens (matched \"downtown\")"),
    ev(308, "fill", "station ← 14 St (unique match)"),
    ev(309, "fill", "tell us more ← (148 chars) · when ← 10/16/2026 8:20 am"),
    ev(310, "fill", "contact fields left blank (not user-provided)", "warn"),
    ev(312, "validate", "breadcrumb Details: A / Downtown & Queens / 14 St matches approved draft v3"),
    ev(318, "submit", "click button[aria-label=\"Submit your feedback\"] (once)"),
    ev(321, "confirm", `parsed case number = ${SR}`),
    ev(322, "confirm", "result.json written · 6 evidence files"),
  ],
  traceId: "6f1a0c2be81d4a7f",
  traceUrl: "https://app.phoenix.arize.com/projects/311relay/traces/6f1a0c2be81d4a7f",
  timing: { sandboxMs: 14820, browserMs: 2210, workerMs: 26340, totalMs: 44960 },
  createdAt: t(280),
  finishedAt: t(325),
};

const attemptHandoff: FilingAttempt = {
  id: "att_ho91",
  complaintId: "mock-handoff",
  approvedVersion: 2,
  target: "real",
  category: "subway-delay",
  sandboxId: "dtn-a7730be0",
  sandboxProvider: "daytona",
  browserSessionId: "anc_1f9e22c4",
  browserProvider: "anchor",
  liveViewUrl: "https://live.anchorbrowser.io/?sessionId=anc_1f9e22c4",
  recordingUrl: "https://storage.anchorbrowser.io/recordings/anc_1f9e22c4.mp4",
  outcome: "HUMAN_ACTION_REQUIRED",
  errorCode: "UNEXPECTED_REQUIRED_FIELD",
  officialRequestNumber: null,
  verified: true,
  verificationNotes: "Worker stopped at the direction step before submit; submitClicked=false. Nothing was filed.",
  evidence: evidenceHandoff,
  workerEvents: [
    ev(1296, "navigate", "connectOverCDP ok (anchor)"),
    ev(1298, "navigate", `GET ${FORM} → 200`),
    ev(1300, "fill", "line ← A Line"),
    ev(1301, "inspect", "direction \"Brooklyn-bound\" matches neither \"Uptown (Inwood-207 St)\" nor \"Downtown & Queens\"", "warn"),
    ev(1302, "inspect", "question sent to rider (direction); waiting up to 180 s", "info", { question: { id: "q_dir", field: "direction" } }),
    ev(1482, "inspect", "STOP: HUMAN_ACTION_REQUIRED / UNEXPECTED_REQUIRED_FIELD (no answer)", "error"),
  ],
  traceId: "b29e44d0c3f7a118",
  traceUrl: "https://app.phoenix.arize.com/projects/311relay/traces/b29e44d0c3f7a118",
  timing: { sandboxMs: 13110, browserMs: 1980, workerMs: 186120, totalMs: 202400 },
  createdAt: t(1280),
  finishedAt: t(1483),
};

const attemptLive: FilingAttempt = {
  ...attemptOk,
  id: "att_run3c",
  complaintId: "mock-live",
  approvedVersion: 1,
  sandboxId: "dtn-0e44c8d1",
  browserSessionId: "anc_c7a1903e",
  liveViewUrl: "https://live.anchorbrowser.io/?sessionId=anc_c7a1903e",
  recordingUrl: null,
  outcome: null,
  officialRequestNumber: null,
  verified: false,
  verificationNotes: null,
  evidence: [],
  workerEvents: [ev(1810, "navigate", "connectOverCDP ok (anchor)"), ev(1812, "inspect", "Subways › Complaint or issue › Service and schedule › Delay")],
  traceId: null,
  traceUrl: null,
  timing: { sandboxMs: 12950, browserMs: 2050, workerMs: null, totalMs: null },
  createdAt: t(1795),
  finishedAt: null,
};

const NO_LOCATION: ComplaintDraft["location"] = { latitude: null, longitude: null, address: null, borough: null, rawInput: null, source: "none", userConfirmed: false, withinNyc: null };

const complaintOk: ComplaintDraft = {
  id: "mock",
  telegramChatId: "51829931",
  residentId: "res_maya",
  status: "SUBMITTED",
  category: "subway-delay",
  triage: "SUPPORTED",
  description: TELL_US_MORE,
  userMessages: [
    "The A train sat at 14 St for 25 minutes this morning, downtown",
    "[button] Approve and file",
  ],
  location: NO_LOCATION,
  media: [],
  classification: {
    triage: "SUPPORTED",
    category: "subway-delay",
    confidence: 0.94,
    description: "Downtown A train held at 14 St for about 25 minutes this morning.",
    rationale: "Rider describes a subway train held in a station for 25 minutes; line, direction and station are stated.",
    alternativeConsidered: "Planned service change rejected: no mention of a posted change or reroute.",
    safetyFlags: [],
    clarifyingQuestion: null,
  },
  transit: TRANSIT_OK,
  missingFields: [],
  needsEmergencyReferral: false,
  confidence: 0.94,
  duplicates: [],
  duplicateReviewed: true,
  draftVersion: 3,
  approvedVersion: 3,
  approvedAt: t(270),
  activeAttemptId: "att_ok7f2",
  officialRequestNumber: SR,
  statusReason: null,
  traceId: "a10f5e7d2c9b4410",
  createdAt: t(0),
  updatedAt: t(326),
};

const complaintHandoff: ComplaintDraft = {
  ...complaintOk,
  id: "mock-handoff",
  residentId: "res_jon",
  telegramChatId: "77310245",
  status: "HUMAN_ACTION_REQUIRED",
  description: "\"A train stuck outside Jay St for 20 min, Brooklyn-bound\" · Line A · Direction Brooklyn-bound · Nearest station Jay St-MetroTech · Delay 20 min",
  userMessages: ["A train stuck outside Jay St for 20 min, Brooklyn-bound", "[button] Approve and file"],
  classification: {
    ...complaintOk.classification!,
    confidence: 0.88,
    description: "A train held outside Jay St-MetroTech for about 20 minutes.",
    rationale: "Rider describes a train held between stations; line and station stated, direction given as \"Brooklyn-bound\".",
    alternativeConsidered: "Rerouting rejected: the train stayed on its line.",
  },
  transit: { line: "A", direction: "Brooklyn-bound", station: "Jay St-MetroTech", borough: "Brooklyn", incidentTime: null, delayMinutes: 20 },
  draftVersion: 2,
  approvedVersion: 2,
  approvedAt: t(1270),
  activeAttemptId: "att_ho91",
  officialRequestNumber: null,
  statusReason: "UNEXPECTED_REQUIRED_FIELD",
  createdAt: t(1100),
  updatedAt: t(1484),
};

const complaintLive: ComplaintDraft = {
  ...complaintOk,
  id: "mock-live",
  residentId: "res_maya",
  status: "FILING",
  description: "\"7 train has been holding at Queensboro Plaza forever, Manhattan-bound\" · Line 7 · Direction Manhattan-bound · Nearest station Queensboro Plaza",
  userMessages: ["7 train has been holding at Queensboro Plaza forever, Manhattan-bound", "[button] Approve and file"],
  transit: { line: "7", direction: "Manhattan-bound", station: "Queensboro Plaza", borough: "Queens", incidentTime: null, delayMinutes: null },
  draftVersion: 1,
  approvedVersion: 1,
  approvedAt: t(1790),
  activeAttemptId: "att_run3c",
  officialRequestNumber: null,
  createdAt: t(1700),
  updatedAt: t(1812),
};

const complaintNeeds: ComplaintDraft = {
  ...complaintOk,
  id: "mock-needs",
  residentId: "res_ade",
  status: "NEEDS_INFORMATION",
  description: "Rider reports a subway delay; line not yet provided.",
  userMessages: ["train's been stuck for 15 minutes again"],
  transit: { line: null, direction: null, station: null, borough: null, incidentTime: null, delayMinutes: 15 },
  missingFields: ["transit"],
  draftVersion: 1,
  approvedVersion: null,
  approvedAt: null,
  activeAttemptId: null,
  officialRequestNumber: null,
  createdAt: t(1900),
  updatedAt: t(1906),
};

const complaintEmergency: ComplaintDraft = {
  ...complaintNeeds,
  id: "mock-911",
  residentId: "res_ade",
  status: "EMERGENCY_REFERRAL",
  category: null,
  triage: "EMERGENCY",
  description: "Person on the tracks at 59 St-Columbus Circle, downtown platform.",
  userMessages: ["someone just jumped down onto the tracks at columbus circle"],
  transit: null,
  needsEmergencyReferral: true,
  missingFields: [],
  statusReason: "safety: person on the tracks",
  createdAt: t(600),
  updatedAt: t(612),
};

const COMPLAINTS = [complaintNeeds, complaintLive, complaintHandoff, complaintEmergency, complaintOk];
const ATTEMPTS = [attemptLive, attemptHandoff, attemptOk];

const tr = (complaintId: string, from: Transition["from"], to: Transition["to"], sec: number, actor: Transition["actor"], reason: string): Transition => ({ complaintId, from, to, at: t(sec), actor, reason });

const TRANSITIONS: Transition[] = [
  tr("mock", "RECEIVED", "TRIAGING", 2, "system", "message received"),
  tr("mock", "TRIAGING", "READY_FOR_APPROVAL", 9, "llm", "classified subway-delay (0.94); line A, downtown, 14 St; live MTA alert checked"),
  tr("mock", "READY_FOR_APPROVAL", "APPROVED", 270, "user", "approve:mock:3"),
  tr("mock", "APPROVED", "FILING", 279, "system", "attempt att_ok7f2 created"),
  tr("mock", "FILING", "SUBMITTED", 325, "system", `receipt verified ${SR}`),
  tr("mock-handoff", "RECEIVED", "TRIAGING", 1101, "system", "message received"),
  tr("mock-handoff", "TRIAGING", "READY_FOR_APPROVAL", 1140, "llm", "classified subway-delay (0.88)"),
  tr("mock-handoff", "READY_FOR_APPROVAL", "APPROVED", 1270, "user", "approve:mock-handoff:2"),
  tr("mock-handoff", "APPROVED", "FILING", 1279, "system", "attempt att_ho91 created"),
  tr("mock-handoff", "FILING", "HUMAN_ACTION_REQUIRED", 1483, "system", "direction unresolved; rider did not answer; nothing filed"),
];

const PATTERNS: WorkflowPattern[] = [
  {
    id: "wp_continue_wait",
    target: "real",
    category: "subway-delay",
    kind: "continue-disabled-until-choice",
    description: "Continue stays disabled until a choice button is clicked; wait for it to enable before clicking.",
    hint: { button: "Continue", wait: "enabled" },
    observedInAttemptId: "att_old01",
    outcome: "FAILED",
    createdAt: t(-3600),
  },
  {
    id: "wp_confirm_ref",
    target: "real",
    category: "subway-delay",
    kind: "confirmation-reference",
    description: "Case number appears in the thank-you text after Submit your feedback; 8 digits, zero-padded.",
    hint: { pattern: "case number [0-9]{8}" },
    observedInAttemptId: "att_ok7f2",
    outcome: "SUBMITTED",
    createdAt: t(325),
  },
  {
    id: "wp_direction_ask",
    target: "real",
    category: "subway-delay",
    kind: "ask-before-approval",
    description: "Direction words like \"Brooklyn-bound\" can match neither A option; ask the rider before approval.",
    hint: { field: "direction", action: "ask" },
    observedInAttemptId: "att_ho91",
    outcome: "HUMAN_ACTION_REQUIRED",
    createdAt: t(1483),
  },
];

function graph(): GraphResponse {
  const nodes: GraphResponse["nodes"] = [
    { id: "res_maya", kind: "resident", label: "@maya.bk" },
    { id: "res_jon", kind: "resident", label: "@jon_hk" },
    { id: "res_ade", kind: "resident", label: "@ade" },
  ];
  const edges: GraphResponse["edges"] = [];
  const add = (n: GraphResponse["nodes"][number]) => {
    if (!nodes.some((x) => x.id === n.id)) nodes.push(n);
  };
  for (const c of COMPLAINTS) {
    add({ id: c.id, kind: "complaint", label: `${c.category ?? "uncategorized"} · ${c.status}` });
    edges.push({ from: c.residentId, to: c.id, rel: "reported" });
    if (c.category) {
      add({ id: `category_${c.category}`, kind: "category", label: c.category });
      edges.push({ from: c.id, to: `category_${c.category}`, rel: "classified_as" });
    }
    if (c.location.address) {
      const lid = `loc_${c.location.borough?.toLowerCase()}`;
      add({ id: lid, kind: "location", label: c.location.address });
      edges.push({ from: c.id, to: lid, rel: "located_at" });
    }
    for (const d of c.duplicates) {
      add({ id: `sr_${d.uniqueKey}`, kind: "open_data_request", label: `${d.uniqueKey} (${d.status})` });
      edges.push({ from: c.id, to: `sr_${d.uniqueKey}`, rel: "possible_duplicate_of" });
    }
  }
  for (const a of ATTEMPTS) {
    add({ id: a.id, kind: "filing_attempt", label: a.outcome ?? "running" });
    edges.push({ from: a.complaintId, to: a.id, rel: "filing_attempt" });
  }
  add({ id: "or_1", kind: "official_request", label: SR });
  edges.push({ from: "mock", to: "or_1", rel: "filed_as" });
  for (const p of PATTERNS) {
    add({ id: p.id, kind: "workflow_pattern", label: p.kind });
    if (p.observedInAttemptId && nodes.some((n) => n.id === p.observedInAttemptId)) edges.push({ from: p.observedInAttemptId, to: p.id, rel: "learned" });
  }
  edges.push({ from: "wp_continue_wait", to: "att_ok7f2", rel: "applied_in" });
  return { nodes, edges, patterns: PATTERNS };
}

export function mockFetch(path: string): unknown {
  const p = path.split("?")[0];
  if (p === "/api/health")
    return {
      ok: true,
      startedAt: t(-600),
      store: "surrealdb",
      telegram: true,
      filingTarget: "real",
      providers: { store: "surrealdb (surrealdb)", tracer: "phoenix (app.phoenix.arize.com)", classifier: "openrouter (anthropic/claude-sonnet-4.5)", sandbox: "daytona", browser: "anchor" },
    };
  if (p === "/api/complaints") return { complaints: COMPLAINTS };
  if (p === "/api/attempts") return { attempts: ATTEMPTS };
  if (p === "/api/graph") return graph();
  if (p === "/api/official-requests") return { officialRequests: [] };
  if (p === "/api/catalog" || p.startsWith("/api/catalog/")) return mockCatalog(path);
  const cm = p.match(/^\/api\/complaints\/(.+)$/);
  if (cm) {
    const id = decodeURIComponent(cm[1]);
    const complaint = COMPLAINTS.find((c) => c.id === id);
    if (!complaint) throw new Error("HTTP 404 — complaint not found");
    const attempts = ATTEMPTS.filter((a) => a.complaintId === id);
    const detail: ComplaintDetail = {
      complaint,
      attempts,
      evidence: attempts.flatMap((a) => a.evidence),
      transitions: TRANSITIONS.filter((x) => x.complaintId === id),
      duplicatesDataAsOf: "2026-10-16T06:00:00Z",
      traceUrl: complaint.traceId ? `https://app.phoenix.arize.com/projects/311relay/traces/${complaint.traceId}` : null,
      sessionUrl: `https://app.phoenix.arize.com/projects/311relay/sessions/${complaint.telegramChatId}`,
    };
    return detail;
  }
  const am = p.match(/^\/api\/attempts\/(.+)$/);
  if (am) return { attempt: ATTEMPTS.find((a) => a.id === decodeURIComponent(am[1])) ?? null };
  throw new Error(`mock: no route for ${p}`);
}
