/**
 * Seed SurrealDB with the 311Relay graph (design doc §11): categories, two
 * example residents + complaints (from fixtures/example-complaints.json),
 * nearby NYC Open Data requests as possible duplicates, filing attempts,
 * official requests and three workflow-memory patterns. Then prints a graph
 * summary and runs a location-aware SurrealQL query.
 *
 *   pnpm --filter @311relay/bot seed                 # SURREALDB_URL from .env (Cloud) or embedded if empty
 *   pnpm --filter @311relay/bot seed -- --embedded   # force embedded mem://
 *   pnpm --filter @311relay/bot seed -- --reset      # wipe 311Relay tables first
 *
 * Idempotent: fixed ids, UPSERT + INSERT RELATION IGNORE.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ComplaintDraft, DuplicateCandidate, FilingAttempt, OfficialRequest, WorkflowPattern } from "../src/core/contracts.js";
import { CATEGORIES, haversineMeters } from "../src/core/contracts.js";
import { REPO_ROOT } from "../src/integrations/env.js";
import { createSurrealStore } from "../src/integrations/surrealdb.js";

const argv = process.argv.slice(2).filter((a) => a !== "--");
const embedded = argv.includes("--embedded");
const reset = argv.includes("--reset");

type Fixture = {
  id: string;
  scenario: string;
  inputText: string | null;
  location: { latitude: number; longitude: number; address: string; borough: string } | null;
  expected: { category: string | null };
};
type OpenDataRow = {
  unique_key: string;
  created_date: string;
  closed_date?: string;
  complaint_type: string;
  descriptor?: string;
  status?: string;
  incident_address?: string;
  latitude?: string;
  longitude?: string;
  resolution_description?: string;
};

const readJson = <T>(rel: string, fallback: T): T => {
  const p = resolve(REPO_ROOT, rel);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : fallback;
};

const fixtures = readJson<Fixture[]>("fixtures/example-complaints.json", []);
const openData = readJson<OpenDataRow[]>("fixtures/sample-311-records.json", []);
const pick = (id: string, fallback: Fixture): Fixture => fixtures.find((f) => f.id === id) ?? fallback;

const f1 = pick("clear-pothole-with-location", {
  id: "clear-pothole-with-location",
  scenario: "Clear pothole photo and location",
  inputText: "Big pothole in the road here, cars keep swerving around it.",
  location: { latitude: 40.7576, longitude: -73.9858, address: "1515 Broadway, Manhattan", borough: "Manhattan" },
  expected: { category: "street-pothole" },
});
const f2 = pick("pothole-in-repaired-patch", {
  id: "pothole-in-repaired-patch",
  scenario: "Pothole on repaired street patch",
  inputText: "There's a hole in the road here and it keeps getting worse.",
  location: { latitude: 40.6831, longitude: -73.9792, address: "32 4th Avenue, Brooklyn", borough: "Brooklyn" },
  expected: { category: "street-repair-defect" },
});

const NOW = new Date();
const iso = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

function candidatesNear(lat: number, lon: number, category: keyof typeof CATEGORIES): DuplicateCandidate[] {
  const descriptors = CATEGORIES[category].openData.descriptors.map((d) => d.toLowerCase());
  return openData
    .filter((r) => r.latitude && r.longitude)
    .map((r) => {
      const la = Number(r.latitude);
      const lo = Number(r.longitude);
      const d = haversineMeters(lat, lon, la, lo);
      const ageDays = Math.max(0, Math.round((NOW.getTime() - Date.parse(r.created_date)) / 86_400_000));
      const location = Math.max(0, 1 - d / 150);
      const cat = descriptors.includes((r.descriptor ?? "").toLowerCase()) ? 1 : 0.4;
      const recency = Math.max(0, 1 - ageDays / 90);
      return {
        uniqueKey: r.unique_key,
        complaintType: r.complaint_type,
        descriptor: r.descriptor ?? null,
        status: r.status ?? null,
        createdDate: r.created_date,
        closedDate: r.closed_date ?? null,
        resolutionDescription: r.resolution_description ?? null,
        incidentAddress: r.incident_address ?? null,
        latitude: la,
        longitude: lo,
        distanceMeters: Math.round(d),
        ageDays,
        matchScore: Number((0.5 * location + 0.3 * cat + 0.2 * recency).toFixed(2)),
        scoreBreakdown: { location: Number(location.toFixed(2)), category: cat, recency: Number(recency.toFixed(2)) },
      } satisfies DuplicateCandidate;
    })
    .filter((c) => (c.distanceMeters ?? 1e9) <= 150)
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, 3);
}

function complaint(id: string, chatId: string, f: Fixture, over: Partial<ComplaintDraft>): ComplaintDraft {
  const loc = f.location!;
  const category = (f.expected.category ?? "street-pothole") as ComplaintDraft["category"];
  return {
    id,
    telegramChatId: chatId,
    residentId: `res_${chatId}`,
    status: "READY_FOR_APPROVAL",
    category,
    triage: "SUPPORTED",
    description: f.inputText ?? "Road surface defect",
    userMessages: [f.inputText ?? ""].filter(Boolean),
    location: { latitude: loc.latitude, longitude: loc.longitude, address: loc.address, borough: loc.borough, rawInput: null, source: "pin", userConfirmed: true, withinNyc: true },
    media: [],
    classification: null,
    missingFields: [],
    needsEmergencyReferral: false,
    confidence: 0.9,
    duplicates: [],
    duplicateReviewed: true,
    draftVersion: 2,
    approvedVersion: 2,
    approvedAt: iso(30),
    activeAttemptId: null,
    officialRequestNumber: null,
    statusReason: null,
    traceId: null,
    createdAt: iso(60),
    updatedAt: iso(20),
    ...over,
  };
}

function attempt(id: string, c: ComplaintDraft, over: Partial<FilingAttempt>): FilingAttempt {
  return {
    id,
    complaintId: c.id,
    approvedVersion: c.approvedVersion ?? 1,
    target: "demo",
    category: c.category!,
    sandboxId: `sbx-seed-${id}`,
    sandboxProvider: "daytona",
    browserSessionId: `anchor-seed-${id}`,
    browserProvider: "anchor",
    liveViewUrl: null,
    recordingUrl: null,
    outcome: "SUBMITTED",
    errorCode: null,
    officialRequestNumber: null,
    verified: false,
    verificationNotes: null,
    evidence: [],
    workerEvents: [],
    traceId: null,
    traceUrl: null,
    timing: { sandboxMs: 9000, browserMs: 2500, workerMs: 14000, totalMs: 26000 },
    createdAt: iso(25),
    finishedAt: iso(24),
    ...over,
  };
}

// ---------------------------------------------------------------------------
const store = createSurrealStore(embedded ? { url: "mem://" } : {});
const t0 = Date.now();
await store.init();
console.log(`SurrealDB ${store.backend} · ns=${store.namespace} db=${store.database} (connected in ${Date.now() - t0} ms)`);
if (reset) {
  await store.reset();
  console.log("reset: cleared 311Relay tables");
}

// residents
const alice = await store.getOrCreateResident("seed-chat-1", "seed_alice");
const bob = await store.getOrCreateResident("seed-chat-2", "seed_bob");
await store.updateResident(bob.id, { demoPortalMode: "captcha" });

// complaint 1: filed + confirmed on the demo portal, now tracking
const c1 = complaint("cmp_seed_pothole", "seed-chat-1", f1, { residentId: alice.id, status: "TRACKING", officialRequestNumber: "DEMO-20261016-SEED01", activeAttemptId: "att_seed_1" });
const d1 = candidatesNear(c1.location.latitude!, c1.location.longitude!, "street-pothole");
await store.createComplaint({ ...c1, duplicates: d1 });
await store.linkDuplicates(c1.id, d1);
const a1 = attempt("att_seed_1", c1, { outcome: "SUBMITTED", officialRequestNumber: "DEMO-20261016-SEED01", verified: true, verificationNotes: "SR parsed from confirmation page" });
await store.createAttempt(a1);
const or1: OfficialRequest = {
  id: "or_seed_1",
  complaintId: c1.id,
  officialRequestNumber: "DEMO-20261016-SEED01",
  officialCategory: CATEGORIES["street-pothole"].officialLabel,
  status: "Open",
  statusSource: "demo-portal",
  lastCheckedAt: iso(5),
  receiptUrl: null,
};
await store.saveOfficialRequest(or1);
for (const [from, to] of [["RECEIVED", "TRIAGING"], ["TRIAGING", "DUPLICATE_REVIEW"], ["DUPLICATE_REVIEW", "READY_FOR_APPROVAL"], ["READY_FOR_APPROVAL", "APPROVED"], ["APPROVED", "FILING"], ["FILING", "SUBMITTED"], ["SUBMITTED", "TRACKING"]] as const) {
  await store.recordTransition(c1.id, from, to, "seed", from === "READY_FOR_APPROVAL" || from === "DUPLICATE_REVIEW" ? "user" : "system");
}

// complaint 2: street repair defect, first attempt hit a CAPTCHA → human action
const c2 = complaint("cmp_seed_repair", "seed-chat-2", f2, { residentId: bob.id, status: "HUMAN_ACTION_REQUIRED", statusReason: "CAPTCHA", activeAttemptId: "att_seed_2" });
const d2 = candidatesNear(c2.location.latitude!, c2.location.longitude!, "street-repair-defect");
await store.createComplaint({ ...c2, duplicates: d2 });
await store.linkDuplicates(c2.id, d2);
const a2 = attempt("att_seed_2", c2, { outcome: "HUMAN_ACTION_REQUIRED", errorCode: "CAPTCHA", verificationNotes: "reCAPTCHA shown on submit; stopped without bypass" });
await store.createAttempt(a2);

// workflow memory (§11.3)
const patterns: WorkflowPattern[] = [
  {
    id: "wp_seed_borough_first",
    target: "demo",
    category: "street-pothole",
    kind: "address-needs-borough-first",
    description: "demo-portal: the address field validates only after the borough select is set; choose borough first.",
    hint: { fieldOrder: ["borough", "address", "description"] },
    observedInAttemptId: "att_seed_1",
    outcome: "SUBMITTED",
    createdAt: iso(24),
  },
  {
    id: "wp_seed_real_dot_name",
    target: "real",
    category: "street-pothole",
    kind: "requires-contact-name",
    description: "real-dot: step 1 of the DOT pothole form requires first + last name; ask the user before filing (never invent).",
    hint: { requiredUserFields: ["contactName"] },
    observedInAttemptId: null,
    outcome: "HUMAN_ACTION_REQUIRED",
    createdAt: iso(120),
  },
  {
    id: "wp_seed_captcha_stop",
    target: "demo",
    category: "street-repair-defect",
    kind: "captcha-seen-on-submit",
    description: "captcha-seen-on-submit → stop: hand the URL to the resident instead of retrying.",
    hint: { onCaptcha: "stop", retry: false },
    observedInAttemptId: "att_seed_2",
    outcome: "HUMAN_ACTION_REQUIRED",
    createdAt: iso(23),
  },
];
for (const p of patterns) await store.recordWorkflowPattern(p);

// ---------------------------------------------------------------------------
const g = await store.graph();
const count = <T>(xs: T[], key: (x: T) => string) => xs.reduce<Record<string, number>>((acc, x) => ((acc[key(x)] = (acc[key(x)] ?? 0) + 1), acc), {});
console.log(`\nGraph: ${g.nodes.length} nodes, ${g.edges.length} edges`);
console.log("  nodes:", count(g.nodes, (n) => n.kind));
console.log("  edges:", count(g.edges, (e) => e.rel));
const one = await store.graph({ complaintId: c1.id });
console.log(`\n1-hop neighbourhood of ${c1.id}:`);
const label = new Map(one.nodes.map((n) => [n.id, `${n.kind}:${n.label}`]));
for (const e of one.edges) console.log(`  ${label.get(e.from)}  -[${e.rel}]->  ${label.get(e.to)}`);

const memory = await store.getWorkflowPatterns({ target: "demo", category: "street-repair-defect" });
console.log(`\nWorkflow memory for demo/street-repair-defect: ${memory.map((p) => p.kind).join(", ") || "(none)"}`);

// The query a judge should see: location-aware + graph traversal in one statement.
const SAMPLE = `-- Complaints within 100 m of Times Square, with their official requests and nearby 311 reports
LET $here = (-73.9855, 40.7580);
SELECT
  record::id(id)                                         AS complaint,
  category, status,
  ->located_at->location.address                         AS address,
  math::round(geo::distance((->located_at->location.point)[0], $here)) AS meters,
  ->resulted_in->official_request.officialRequestNumber AS filed_as,
  ->possibly_duplicates->official_request.{ sr: officialRequestNumber, status, category: officialCategory } AS nearby_311,
  <-attempted<-filing_attempt.{ outcome, errorCode }     AS attempts,
  <-attempted<-filing_attempt->learned->workflow_pattern.kind AS learned
FROM complaint
WHERE geo::distance((->located_at->location.point)[0], $here) < 100
ORDER BY meters;`;
console.log(`\nSample SurrealQL (paste into Surrealist, ns=${store.namespace} db=${store.database}):\n${SAMPLE}\n`);
const res = await store.query<unknown[]>(SAMPLE.split("\n").filter((l) => !l.startsWith("--")).join("\n"));
const rows = res[res.length - 1];
console.log(JSON.stringify(rows, null, 2));

await store.close();
console.log(`\nSeeded in ${Date.now() - t0} ms.`);
