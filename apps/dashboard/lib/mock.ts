/**
 * Mock data for `?mock=1` — lets the dashboard render before / without the bot API.
 * Shapes follow apps/bot/src/core/contracts.ts exactly.
 */
import type {
  ComplaintDetail,
  ComplaintDraft,
  DuplicateCandidate,
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

/** Fake portal screenshot rendered as SVG so mock mode needs no binary assets. */
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
<rect width="640" height="28" fill="#fbe9a6"/>
<text x="16" y="18" font-size="11" fill="#5a4a00" font-family="Arial">NYC311 Demo Portal — not the official site</text>
<rect y="28" width="640" height="54" fill="#12355b"/>
<text x="24" y="62" font-size="20" font-weight="bold" fill="#fff" font-family="Arial">NYC311</text>
<text x="104" y="62" font-size="13" fill="#c9d6e6" font-family="Arial">Report a Problem</text>
<text x="48" y="118" font-size="18" font-weight="bold" fill="#12355b" font-family="Arial">${esc(title)}</text>
${rows}${bannerSvg}
<rect x="500" y="414" width="128" height="24" rx="12" fill="#111" opacity="0.75"/>
<text x="564" y="430" font-size="11" fill="#fff" text-anchor="middle" font-family="Courier New, monospace">${esc(step)}</text>
</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const SR = "DEMO-20261016-ABC123";
const ADDRESS = "214 Nostrand Avenue, Brooklyn, NY 11205";

const okFields: [string, string][] = [
  ["Address *", ADDRESS],
  ["Borough *", "Brooklyn"],
  ["Description *", "Pothole roughly 40 cm wide in the northbound lane near the bus stop."],
];

const evidenceOk: Evidence[] = [
  { step: "navigate", title: "Pothole or Cave-In on Street", summary: "Opened allowlisted form /report/pothole", fields: [] },
  { step: "inspect", title: "Pothole or Cave-In on Street", summary: "Found 3 required fields, 3 optional contact fields", fields: [["Address *", ""], ["Borough *", "Select…"], ["Description *", ""]] },
  { step: "fill", title: "Pothole or Cave-In on Street", summary: "Filled address, borough, description; contact left blank", fields: okFields },
  { step: "validate", title: "Pothole or Cave-In on Street", summary: "Re-read fields; values match approved draft v3", fields: okFields, banner: { tone: "ok" as const, text: "All required fields complete" } },
  { step: "submit", title: "Pothole or Cave-In on Street", summary: "Clicked Submit Report once", fields: okFields.slice(0, 2), banner: { tone: "ok" as const, text: "Submitting…" } },
  { step: "confirm", title: "Service Request Submitted", summary: `Parsed confirmation: ${SR}`, fields: [], banner: { tone: "ok" as const, text: "Your service request has been submitted.", big: SR } },
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

const evidenceCaptcha: Evidence[] = [
  { step: "navigate", summary: "Opened allowlisted form /report/street-repair", banner: undefined },
  { step: "inspect", summary: "Detected div.g-recaptcha[data-sitekey] — stopping, no bypass attempted", banner: { tone: "warn" as const, text: "Verify you are human  [ reCAPTCHA ]" } },
].map((e, i) => ({
  id: `ev_cap_${i + 1}`,
  attemptId: "att_cap91",
  complaintId: "mock-captcha",
  type: "screenshot" as const,
  step: e.step as Evidence["step"],
  summary: e.summary,
  storageReference: shot({ step: `0${i + 1}-${e.step}`, title: "Street Repair Complaint", fields: [["Address *", "W 47th St & 10th Ave, Manhattan"], ["Restoration type *", "Street cut"]], banner: e.banner }),
  mime: "image/svg+xml",
  createdAt: t(1300 + i * 5),
}));

const ev = (ts: number, step: WorkerEvent["step"], message: string, level: WorkerEvent["level"] = "info", data?: Record<string, unknown>): WorkerEvent => ({ ts: t(ts), step, level, message, data });

const attemptOk: FilingAttempt = {
  id: "att_ok7f2",
  complaintId: "mock",
  approvedVersion: 3,
  target: "real",
  category: "street-pothole",
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
  verificationNotes: "SR matches DEMO-\\d{8}-[A-Z0-9]{6}; confirmation text present; confirmation screenshot 06-confirm.png present.",
  evidence: evidenceOk,
  workerEvents: [
    ev(296, "navigate", "connectOverCDP ok (anchor)"),
    ev(298, "navigate", "GET https://3311-dtn-5c1e9a42.proxy.daytona.works/report/pothole → 200"),
    ev(300, "inspect", "required: address, borough, description · optional: contact_name, contact_email, contact_phone"),
    ev(303, "inspect", "workflow memory: address-autocomplete-needs-enter applied", "info", { pattern: "wp_addr_enter" }),
    ev(306, "fill", "address ← 214 Nostrand Avenue, Brooklyn, NY 11205"),
    ev(307, "fill", "borough ← Brooklyn"),
    ev(308, "fill", "description ← (84 chars)"),
    ev(309, "fill", "contact_* left blank (not user-provided)", "warn"),
    ev(312, "validate", "3/3 required fields match approved draft v3"),
    ev(318, "submit", "click [data-testid=submit] (once)"),
    ev(321, "confirm", `parsed [data-testid=sr-number] = ${SR}`),
    ev(322, "confirm", "result.json written · 6 evidence files"),
  ],
  traceId: "6f1a0c2be81d4a7f",
  traceUrl: "https://app.phoenix.arize.com/projects/311relay/traces/6f1a0c2be81d4a7f",
  timing: { sandboxMs: 14820, browserMs: 2210, workerMs: 26340, totalMs: 44960 },
  createdAt: t(280),
  finishedAt: t(325),
};

const attemptCaptcha: FilingAttempt = {
  id: "att_cap91",
  complaintId: "mock-captcha",
  approvedVersion: 2,
  target: "real",
  category: "street-repair-defect",
  sandboxId: "dtn-a7730be0",
  sandboxProvider: "daytona",
  browserSessionId: "anc_1f9e22c4",
  browserProvider: "anchor",
  liveViewUrl: "https://live.anchorbrowser.io/?sessionId=anc_1f9e22c4",
  recordingUrl: "https://storage.anchorbrowser.io/recordings/anc_1f9e22c4.mp4",
  outcome: "HUMAN_ACTION_REQUIRED",
  errorCode: "CAPTCHA",
  officialRequestNumber: null,
  verified: true,
  verificationNotes: "Worker stopped at CAPTCHA before submit; submitClicked=false. Nothing was filed.",
  evidence: evidenceCaptcha,
  workerEvents: [
    ev(1296, "navigate", "connectOverCDP ok (anchor)"),
    ev(1298, "navigate", "GET /report/street-repair?mode=captcha → 200"),
    ev(1301, "inspect", "found .g-recaptcha[data-sitekey] — human verification required", "warn"),
    ev(1302, "inspect", "STOP: HUMAN_ACTION_REQUIRED / CAPTCHA (no bypass attempted)", "error"),
  ],
  traceId: "b29e44d0c3f7a118",
  traceUrl: "https://app.phoenix.arize.com/projects/311relay/traces/b29e44d0c3f7a118",
  timing: { sandboxMs: 13110, browserMs: 1980, workerMs: 6120, totalMs: 22400 },
  createdAt: t(1280),
  finishedAt: t(1303),
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
  workerEvents: [ev(1810, "navigate", "connectOverCDP ok (anchor)"), ev(1812, "inspect", "required: address, borough, description")],
  traceId: null,
  traceUrl: null,
  timing: { sandboxMs: 12950, browserMs: 2050, workerMs: null, totalMs: null },
  createdAt: t(1795),
  finishedAt: null,
};

const dups: DuplicateCandidate[] = [
  {
    uniqueKey: "63318872",
    complaintType: "Street Condition",
    descriptor: "Pothole",
    status: "Closed",
    createdDate: "2026-08-29T09:14:00.000",
    closedDate: "2026-09-03T15:02:00.000",
    resolutionDescription: "The Department of Transportation inspected this complaint and repaired the problem.",
    incidentAddress: "210 NOSTRAND AVENUE",
    latitude: 40.6931,
    longitude: -73.9529,
    distanceMeters: 18,
    ageDays: 48,
    matchScore: 0.71,
    scoreBreakdown: { location: 0.92, category: 1, recency: 0.47 },
  },
  {
    uniqueKey: "63540017",
    complaintType: "Street Condition",
    descriptor: "Rough, Pitted or Cracked Roads",
    status: "Open",
    createdDate: "2026-10-02T17:40:00.000",
    closedDate: null,
    resolutionDescription: null,
    incidentAddress: "NOSTRAND AVENUE and MYRTLE AVENUE",
    latitude: 40.6942,
    longitude: -73.9531,
    distanceMeters: 41,
    ageDays: 14,
    matchScore: 0.62,
    scoreBreakdown: { location: 0.59, category: 0.6, recency: 0.84 },
  },
];

const complaintOk: ComplaintDraft = {
  id: "mock",
  telegramChatId: "51829931",
  residentId: "res_maya",
  status: "SUBMITTED",
  category: "street-pothole",
  triage: "SUPPORTED",
  description: "Pothole roughly 40 cm wide in the northbound lane near the bus stop.",
  userMessages: [
    "[photo] there's a huge pothole by the B44 stop, cars keep swerving",
    "[location pin] 40.69318, -73.95301",
    "it's in the right lane going north, maybe 40cm across",
    "[button] Continue with new report",
    "[button] Approve and file",
  ],
  location: {
    latitude: 40.69318,
    longitude: -73.95301,
    address: ADDRESS,
    borough: "Brooklyn",
    rawInput: null,
    source: "pin",
    userConfirmed: true,
    withinNyc: true,
  },
  media: [{ id: "med_p1", type: "photo", telegramFileId: "AgACAgEAAxkBAAIB", localPath: null, mime: "image/jpeg", createdAt: t(0) }],
  classification: {
    triage: "SUPPORTED",
    category: "street-pothole",
    confidence: 0.91,
    description: "Pothole roughly 40 cm wide in the northbound lane near the bus stop.",
    rationale: "Photo shows a shallow, irregular hole in asphalt with loose aggregate, in an unpatched section of the travel lane.",
    alternativeConsidered: "Street repair defect rejected: no square patch, trench or utility-cut outline around the hole.",
    safetyFlags: [],
    clarifyingQuestion: null,
  },
  missingFields: [],
  needsEmergencyReferral: false,
  confidence: 0.91,
  duplicates: dups,
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

const complaintCaptcha: ComplaintDraft = {
  ...complaintOk,
  id: "mock-captcha",
  residentId: "res_jon",
  telegramChatId: "77310245",
  status: "HUMAN_ACTION_REQUIRED",
  category: "street-repair-defect",
  description: "Sunken square patch from recent utility work, about 2 inches below the road surface.",
  userMessages: ["[photo] this patch the gas company left is sinking again", "W 47th St & 10th Ave", "[button] Approve and file"],
  location: { ...complaintOk.location, latitude: 40.7616, longitude: -73.9936, address: "W 47th St & 10th Ave, Manhattan, NY 10036", borough: "Manhattan", source: "text", rawInput: "W 47th St & 10th Ave" },
  classification: {
    ...complaintOk.classification!,
    category: "street-repair-defect",
    confidence: 0.84,
    rationale: "Square, saw-cut patch outline visible; patch has sunk below surrounding asphalt.",
    alternativeConsidered: "Pothole rejected: damage is inside a previously repaired area.",
  },
  duplicates: [],
  draftVersion: 2,
  approvedVersion: 2,
  approvedAt: t(1270),
  activeAttemptId: "att_cap91",
  officialRequestNumber: null,
  statusReason: "CAPTCHA",
  createdAt: t(1100),
  updatedAt: t(1304),
};

const complaintLive: ComplaintDraft = {
  ...complaintOk,
  id: "mock-live",
  residentId: "res_maya",
  status: "FILING",
  description: "Cave-in forming along the curb lane after rain.",
  userMessages: ["[photo] road is collapsing near the curb", "[location pin]"],
  location: { ...complaintOk.location, address: "1180 Grand Concourse, Bronx, NY 10456", borough: "Bronx" },
  duplicates: [],
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
  category: "street-pothole",
  description: "Pothole reported; location not yet provided.",
  userMessages: ["[photo]"],
  location: { latitude: null, longitude: null, address: null, borough: null, rawInput: null, source: "none", userConfirmed: false, withinNyc: null },
  missingFields: ["location"],
  duplicates: [],
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
  description: "Open manhole with no cover in the crosswalk.",
  needsEmergencyReferral: true,
  missingFields: [],
  statusReason: "safety: uncovered opening",
  createdAt: t(600),
  updatedAt: t(612),
};

const COMPLAINTS = [complaintNeeds, complaintLive, complaintCaptcha, complaintEmergency, complaintOk];
const ATTEMPTS = [attemptLive, attemptCaptcha, attemptOk];

const tr = (complaintId: string, from: Transition["from"], to: Transition["to"], sec: number, actor: Transition["actor"], reason: string): Transition => ({ complaintId, from, to, at: t(sec), actor, reason });

const TRANSITIONS: Transition[] = [
  tr("mock", "RECEIVED", "TRIAGING", 2, "system", "photo received"),
  tr("mock", "TRIAGING", "NEEDS_INFORMATION", 9, "llm", "classified street-pothole (0.91); location missing"),
  tr("mock", "NEEDS_INFORMATION", "DUPLICATE_REVIEW", 41, "system", "pin in NYC; 2 Open Data candidates ≥ 0.55"),
  tr("mock", "DUPLICATE_REVIEW", "READY_FOR_APPROVAL", 118, "user", "Continue with new report"),
  tr("mock", "READY_FOR_APPROVAL", "APPROVED", 270, "user", "approve:mock:3"),
  tr("mock", "APPROVED", "FILING", 279, "system", "attempt att_ok7f2 created"),
  tr("mock", "FILING", "SUBMITTED", 325, "system", `receipt verified ${SR}`),
  tr("mock-captcha", "RECEIVED", "TRIAGING", 1101, "system", "photo received"),
  tr("mock-captcha", "TRIAGING", "READY_FOR_APPROVAL", 1140, "llm", "classified street-repair-defect (0.84)"),
  tr("mock-captcha", "READY_FOR_APPROVAL", "APPROVED", 1270, "user", "approve:mock-captcha:2"),
  tr("mock-captcha", "APPROVED", "FILING", 1279, "system", "attempt att_cap91 created"),
  tr("mock-captcha", "FILING", "HUMAN_ACTION_REQUIRED", 1303, "system", "CAPTCHA detected; no bypass"),
];

const PATTERNS: WorkflowPattern[] = [
  {
    id: "wp_addr_enter",
    target: "real",
    category: "street-pothole",
    kind: "address-autocomplete-needs-enter",
    description: "Address field opens an autocomplete list; press Enter after typing or the value is dropped.",
    hint: { field: "address", after: "press:Enter" },
    observedInAttemptId: "att_old01",
    outcome: "FAILED",
    createdAt: t(-3600),
  },
  {
    id: "wp_confirm_sel",
    target: "real",
    category: "street-pothole",
    kind: "confirmation-selector",
    description: "SR number is rendered in [data-testid=sr-number] on /confirmation/<sr>.",
    hint: { selector: "[data-testid=sr-number]" },
    observedInAttemptId: "att_ok7f2",
    outcome: "SUBMITTED",
    createdAt: t(325),
  },
  {
    id: "wp_captcha",
    target: "real",
    category: "street-repair-defect",
    kind: "captcha-on-form",
    description: "Street repair form showed reCAPTCHA on load; hand off to the resident immediately.",
    hint: { detect: ".g-recaptcha", action: "handoff" },
    observedInAttemptId: "att_cap91",
    outcome: "HUMAN_ACTION_REQUIRED",
    createdAt: t(1303),
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
  edges.push({ from: "wp_addr_enter", to: "att_ok7f2", rel: "applied_in" });
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
      filingTarget: "demo",
      providers: { store: "surrealdb (surrealdb)", tracer: "phoenix (app.phoenix.arize.com)", classifier: "openrouter (anthropic/claude-sonnet-4.5)", sandbox: "daytona", browser: "anchor" },
    };
  if (p === "/api/complaints") return { complaints: COMPLAINTS };
  if (p === "/api/attempts") return { attempts: ATTEMPTS };
  if (p === "/api/graph") return graph();
  if (p === "/api/official-requests") return { officialRequests: [] };
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
