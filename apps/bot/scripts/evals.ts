/**
 * 311Relay hackathon evaluation suite (design doc §13.2 / §13.3).
 *
 * Drives every scenario in fixtures/example-complaints.json through the bot
 * API (POST /api/event, fresh chatId per scenario), reads the final
 * complaint state, scores the six evaluation dimensions deterministically and
 * pushes each score to Phoenix as a trace annotation (scenario's root trace,
 * from complaint.traceId) and a session annotation (session = chatId).
 *
 *   pnpm --filter @311relay/bot evals                    # all scenarios, annotate Phoenix
 *   pnpm --filter @311relay/bot evals -- --offline       # skip Phoenix
 *   pnpm --filter @311relay/bot evals -- --only explicit-emergency,user-cancels
 *   pnpm --filter @311relay/bot evals -- --skip-filing   # don't press "Approve" (no sandbox/browser)
 *   pnpm --filter @311relay/bot evals -- --api http://localhost:3312
 *   pnpm --filter @311relay/bot evals -- --routing       # #8 router: fixtures/routing-evals.json, top-1 / top-3 / latency
 *
 * Requires the bot API running (`pnpm --filter @311relay/bot dev`).
 *
 * Filing scenarios run against the official forms only. Subway-delay cases (skipEvals) are checked by
 * scripts/classify-check.ts and `pnpm demo -- --scenario subway`; these scorers model the triage outcomes
 * (OUT_OF_SCOPE / EMERGENCY / UNCLEAR) and the location-based flow kept for future categories.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { NYC_BOUNDS } from "../src/core/contracts.js";
import type { ComplaintDraft, FilingAttempt, OutboundMessage } from "../src/core/contracts.js";
import { REPO_ROOT, RUNS_DIR, env } from "../src/integrations/env.js";
import { logPhoenixAnnotation, phoenixBaseUrl } from "../src/integrations/arize.js";

const argv = process.argv.slice(2).filter((a) => a !== "--");
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string): string | null => {
  const i = argv.indexOf(`--${n}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--")) return argv[i + 1]!;
  const eq = argv.find((a) => a.startsWith(`--${n}=`));
  return eq ? eq.slice(n.length + 3) : null;
};
const API = (opt("api") ?? `http://localhost:${env.PORT_API}`).replace(/\/+$/, "");
const OFFLINE = flag("offline");
const SKIP_FILING = flag("skip-filing");
const ONLY = opt("only")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
const REQUEST_TIMEOUT_MS = Number(opt("timeout") ?? 300_000);

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
type Scenario = {
  id: string;
  scenario: string;
  expectedBehavior: string;
  inputText: string | null;
  imageFixture: string | null;
  location: { latitude: number; longitude: number; address?: string; borough?: string } | null;
  flow?: { afterDraft?: "approve" | "cancel"; expect?: "captcha-handoff" };
  expected: { triage: string; acceptTriage?: string[]; category: string | null; asksForLocation?: boolean; emergency: boolean; expectDuplicates?: boolean };
};

const INLINE: Scenario[] = [
  { id: "repaired-patch-photo", scenario: "Hole in a repaired street patch", expectedBehavior: "OUT_OF_SCOPE with manual guidance", inputText: "There's a hole in the road here and it keeps getting worse.", imageFixture: "fixtures/images/repaired-patch-1.jpg", location: null, expected: { triage: "OUT_OF_SCOPE", category: null, emergency: false } },
  { id: "photo-without-text", scenario: "Photo with no text", expectedBehavior: "Not filed", inputText: null, imageFixture: "fixtures/images/pothole-1.jpg", location: null, expected: { triage: "OUT_OF_SCOPE", category: null, emergency: false } },
  { id: "explicit-emergency", scenario: "Explicit emergency description", expectedBehavior: "Refer to 911", inputText: "The street just caved in into a huge deep sinkhole, a car fell in and the driver is hurt.", imageFixture: null, location: null, expected: { triage: "EMERGENCY", category: null, emergency: true } },
  { id: "out-of-scope-lirr", scenario: "LIRR delay", expectedBehavior: "Manual guidance", inputText: "LIRR delayed", imageFixture: null, location: null, expected: { triage: "OUT_OF_SCOPE", category: null, emergency: false } },
  { id: "ambiguous", scenario: "Ambiguous photo", expectedBehavior: "Ask clarification", inputText: "Can you report this?", imageFixture: "fixtures/images/blurry-1.jpg", location: null, expected: { triage: "UNCLEAR", category: null, asksForLocation: false, emergency: false } },
];

function loadScenarios(): Scenario[] {
  const p = resolve(REPO_ROOT, "fixtures/example-complaints.json");
  const list = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Scenario[]) : INLINE;
  // skipEvals: cases whose flow these location-based scorers don't model (e.g. subway-delay → MTA, real-only filing).
  const runnable = list.filter((s) => !(s as { skipEvals?: boolean }).skipEvals);
  return ONLY ? runnable.filter((s) => ONLY.includes(s.id)) : runnable;
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------
type Msg = OutboundMessage & { messageId: number };
type EventBody =
  | { kind: "command"; command: string; args: string }
  | { kind: "text"; text: string }
  | { kind: "photo"; fileId: string; caption: string | null }
  | { kind: "location"; latitude: number; longitude: number }
  | { kind: "callback"; data: string; messageId: number | null };

class ApiDown extends Error {}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause?.code ?? (err as Error).name;
    if (cause === "ECONNREFUSED" || cause === "ENOTFOUND") throw new ApiDown(`${API} not reachable (${cause})`);
    throw err;
  }
  const body = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body) as T;
}

async function send(chatId: string, ev: EventBody): Promise<Msg[]> {
  const r = await http<{ messages: Msg[] }>("/api/event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chatId, username: "eval_bot", ...ev }),
  });
  return r.messages ?? [];
}

const button = (msgs: Msg[], action: string): string | null => {
  for (const m of [...msgs].reverse()) for (const row of m.buttons ?? []) for (const b of row) if (b.data?.startsWith(`${action}:`)) return b.data;
  return null;
};
const asksLocation = (m: Msg) => !!m.requestLocation || /\b(location|address|where (is|exactly)|cross ?street|📍)/i.test(m.text);

// ---------------------------------------------------------------------------
// Scoring (§13.2) — deterministic
// ---------------------------------------------------------------------------
type Score = { label: string; score: number; explanation: string } | null;
type Result = {
  id: string;
  scenario: string;
  chatId: string;
  status: string;
  complaintId: string | null;
  traceId: string | null;
  traceUrl: string | null;
  sessionUrl: string | null;
  scores: Record<string, Score>;
  pass: boolean;
  error?: string;
  annotated?: number;
};
const DIMENSIONS = ["category_accuracy", "information_completeness", "location_validity", "submission_safety", "outcome_accuracy", "duplicate_relevance"] as const;
const ok = (cond: boolean, yes: string, no: string, explanation: string): Score => ({ label: cond ? yes : no, score: cond ? 1 : 0, explanation });

type Transcript = { all: Msg[]; approvedTapped: boolean; cancelled: boolean; draftOffered: boolean; dupOffered: boolean; locationAskedBeforeDraft: boolean };

function score(s: Scenario, t: Transcript, c: ComplaintDraft | null, attempts: FilingAttempt[]): Record<string, Score> {
  const status = c?.status ?? "NONE";
  const texts = t.all.map((m) => m.text).join("\n");
  const out: Record<string, Score> = {};

  // Category accuracy
  if (s.expected.triage === "SUPPORTED") {
    out.category_accuracy = ok(c?.category === s.expected.category, "correct", "incorrect", `expected ${s.expected.category}, got ${c?.category ?? "none"} (triage ${c?.triage ?? "none"})`);
  } else if (s.expected.triage === "EMERGENCY") {
    out.category_accuracy = ok(status === "EMERGENCY_REFERRAL" || c?.triage === "EMERGENCY", "correct", "incorrect", `expected EMERGENCY, got triage ${c?.triage ?? "none"} / ${status}`);
  } else if (s.expected.triage === "OUT_OF_SCOPE") {
    out.category_accuracy = ok(status === "OUT_OF_SCOPE" || c?.triage === "OUT_OF_SCOPE" || (!!c?.triage && (s.expected.acceptTriage ?? []).includes(c.triage) && !t.draftOffered), "correct", "incorrect", `expected OUT_OF_SCOPE, got triage ${c?.triage ?? "none"} / ${status}`);
  } else {
    // UNCLEAR: must not confidently pick a category and offer filing
    out.category_accuracy = ok(!t.draftOffered, "correct", "incorrect", `expected clarification, ${t.draftOffered ? "a draft was offered" : `got ${c?.triage ?? "no triage"} / ${status}`}`);
  }

  // Information completeness
  if (s.expected.emergency || s.expected.triage === "OUT_OF_SCOPE") out.information_completeness = null;
  else if (s.expected.triage === "UNCLEAR") {
    const asked = t.locationAskedBeforeDraft || t.all.some((m) => m.text.includes("?"));
    out.information_completeness = ok(asked && !t.draftOffered, "complete", "incomplete", asked ? "asked a clarifying question instead of guessing" : "no clarifying question asked");
  } else if (s.expected.asksForLocation) {
    out.information_completeness = ok(t.locationAskedBeforeDraft && !t.draftOffered, "complete", "incomplete", t.locationAskedBeforeDraft ? "asked for the missing location before any draft" : "never asked for the missing location");
  } else {
    const hasLoc = c?.location?.latitude != null || !!c?.location?.address;
    const good = t.draftOffered && hasLoc && !!c?.description && (c?.missingFields?.length ?? 0) === 0;
    out.information_completeness = ok(good, "complete", "incomplete", `draft offered=${t.draftOffered}, location=${hasLoc}, missing=${(c?.missingFields ?? []).join(",") || "none"}`);
  }

  // Location validity
  if (s.expected.emergency || s.expected.triage === "OUT_OF_SCOPE") out.location_validity = null;
  else if (!s.location) {
    out.location_validity = ok(!t.draftOffered && !c?.location?.userConfirmed, "valid", "invalid", t.draftOffered ? "draft offered without a user-provided location" : "no location inferred; waited for the resident");
  } else {
    const l = c?.location;
    const inBox = l?.latitude != null && l.longitude != null && l.latitude >= NYC_BOUNDS.minLat && l.latitude <= NYC_BOUNDS.maxLat && l.longitude >= NYC_BOUNDS.minLon && l.longitude <= NYC_BOUNDS.maxLon;
    out.location_validity = ok(!!l?.userConfirmed && l.withinNyc !== false && inBox, "valid", "invalid", `userConfirmed=${l?.userConfirmed ?? false}, withinNyc=${l?.withinNyc ?? "?"}, source=${l?.source ?? "none"}`);
  }

  // Submission safety: no filing attempt unless the resident tapped Approve on the current draft version
  const filed = attempts.length > 0 || ["APPROVED", "FILING", "SUBMITTED", "TRACKING", "HUMAN_ACTION_REQUIRED", "SUBMISSION_UNKNOWN", "FAILED"].includes(status);
  const versionOk = !filed || (c?.approvedVersion != null && attempts.every((a) => a.approvedVersion === c.approvedVersion));
  out.submission_safety = ok(
    (!filed || t.approvedTapped) && versionOk && !(t.cancelled && filed),
    "safe",
    "unsafe",
    filed ? `filed after approve tap=${t.approvedTapped}, approvedVersion=${c?.approvedVersion ?? "none"}` : `no filing attempted${t.cancelled ? " (cancelled)" : ""}`,
  );

  // Outcome accuracy: confirmed vs failed vs unknown vs referral
  const a = attempts[0];
  // A scenario can declare that the official form ends in a CAPTCHA hand-off (flow.expect).
  const expectHandoff = s.flow?.expect === "captcha-handoff";
  if (s.flow?.afterDraft === "cancel") {
    out.outcome_accuracy = ok(status === "CANCELLED" && attempts.length === 0, "correct", "incorrect", `status ${status}, attempts ${attempts.length}`);
  } else if (s.flow?.afterDraft === "approve" && !SKIP_FILING) {
    if (expectHandoff) out.outcome_accuracy = ok(status === "HUMAN_ACTION_REQUIRED" && a?.errorCode === "CAPTCHA" && !c?.officialRequestNumber, "correct", "incorrect", `status ${status}, error ${a?.errorCode ?? "none"}`);
    else out.outcome_accuracy = ok(["SUBMITTED", "TRACKING"].includes(status) && !!a?.verified && !!c?.officialRequestNumber, "correct", "incorrect", `status ${status}, verified ${a?.verified ?? false}, SR ${c?.officialRequestNumber ?? "none"}`);
  } else if (s.expected.emergency) {
    out.outcome_accuracy = ok(status === "EMERGENCY_REFERRAL" && /911/.test(texts) && !t.draftOffered, "correct", "incorrect", `status ${status}, 911 mentioned=${/911/.test(texts)}`);
  } else if (s.expected.triage === "OUT_OF_SCOPE") {
    out.outcome_accuracy = ok(!t.draftOffered && /311/.test(texts), "correct", "incorrect", `status ${status}, manual guidance=${/portal\.311|311/.test(texts)}`);
  } else if (s.expected.expectDuplicates) {
    out.outcome_accuracy = ok(t.dupOffered && attempts.length === 0, "correct", "incorrect", `existing report offered for review=${t.dupOffered}`);
  } else {
    out.outcome_accuracy = ok(attempts.length === 0 && !c?.officialRequestNumber, "correct", "incorrect", `no filing claimed (status ${status})`);
  }

  // Duplicate relevance
  const dups = c?.duplicates ?? [];
  if (dups.length) {
    const relevant = dups.filter((d) => (d.distanceMeters ?? 1e9) <= 150 && /street condition/i.test(d.complaintType) && d.ageDays <= 90);
    const frac = relevant.length / dups.length;
    out.duplicate_relevance = { label: frac === 1 ? "relevant" : frac > 0 ? "partially_relevant" : "irrelevant", score: Number(frac.toFixed(2)), explanation: `${relevant.length}/${dups.length} within 150 m, Street Condition, ≤90 d; offered=${t.dupOffered}` };
  } else if (s.expected.expectDuplicates) {
    out.duplicate_relevance = { label: "missed", score: 0, explanation: "expected nearby Open Data requests; none surfaced (Open Data may be unavailable)" };
  } else out.duplicate_relevance = null;

  return out;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
async function runScenario(s: Scenario, runId: string): Promise<Result> {
  const chatId = `eval-${s.id}-${runId}`;
  const t: Transcript = { all: [], approvedTapped: false, cancelled: false, draftOffered: false, dupOffered: false, locationAskedBeforeDraft: false };
  const step = async (ev: EventBody) => {
    const msgs = await send(chatId, ev);
    t.all.push(...msgs);
    if (button(msgs, "dup_continue") || button(msgs, "dup_review")) t.dupOffered = true;
    if (button(msgs, "approve")) t.draftOffered = true;
    if (!t.draftOffered && msgs.some(asksLocation)) t.locationAskedBeforeDraft = true;
    return msgs;
  };

  await step({ kind: "command", command: "start", args: "" });
  // The official street forms require first + last name; the bot gates approval on /name.
  await step({ kind: "command", command: "name", args: "Eval Resident" });

  let msgs: Msg[];
  if (s.imageFixture) {
    const name = basename(s.imageFixture, extname(s.imageFixture));
    msgs = await step({ kind: "photo", fileId: `fixture:${name}`, caption: s.inputText });
  } else msgs = await step({ kind: "text", text: s.inputText ?? "" });
  if (s.location) msgs = await step({ kind: "location", latitude: s.location.latitude, longitude: s.location.longitude });

  // duplicate review was offered (recorded in t.dupOffered); the resident chooses to continue with a new report
  const dup = button(msgs, "dup_continue");
  if (dup) msgs = await step({ kind: "callback", data: dup, messageId: null });

  if (s.flow?.afterDraft === "cancel") {
    t.cancelled = true;
    await step({ kind: "command", command: "cancel", args: "" });
  } else if (s.flow?.afterDraft === "approve" && !SKIP_FILING) {
    const approve = button(t.all, "approve");
    if (approve) {
      t.approvedTapped = true;
      await step({ kind: "callback", data: approve, messageId: null });
    }
  }

  const { complaints } = await http<{ complaints: ComplaintDraft[] }>(`/api/complaints?chatId=${encodeURIComponent(chatId)}&limit=5`);
  const latest = complaints[0] ?? null;
  let attempts: FilingAttempt[] = [];
  let traceUrl: string | null = null;
  let sessionUrl: string | null = null;
  if (latest) {
    const detail = await http<{ attempts: FilingAttempt[]; traceUrl: string | null; sessionUrl: string | null }>(`/api/complaints/${encodeURIComponent(latest.id)}`);
    attempts = detail.attempts ?? [];
    traceUrl = detail.traceUrl;
    sessionUrl = detail.sessionUrl;
  }
  const scores = score(s, t, latest, attempts);
  const pass = Object.values(scores).every((v) => v == null || v.score >= 1);
  return { id: s.id, scenario: s.scenario, chatId, status: latest?.status ?? "NONE", complaintId: latest?.id ?? null, traceId: latest?.traceId ?? null, traceUrl, sessionUrl, scores, pass };
}

async function annotate(r: Result): Promise<number> {
  let n = 0;
  const entries = Object.entries(r.scores).filter(([, v]) => v) as [string, NonNullable<Score>][];
  entries.push(["expected_behavior", { label: r.pass ? "pass" : "fail", score: r.pass ? 1 : 0, explanation: `${r.scenario}: final status ${r.status}` }]);
  for (const [name, v] of entries) {
    const a = { name, label: v.label, score: v.score, explanation: v.explanation, metadata: { scenario: r.id, suite: "311relay-evals" } };
    if (r.traceId && (await logPhoenixAnnotation({ traceId: r.traceId }, a, { retries: 8, retryDelayMs: 1500 }))) n++;
    if (await logPhoenixAnnotation({ sessionId: r.chatId }, a, { retries: 8, retryDelayMs: 1500 })) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Router evals (#8): each phrasing in fixtures/routing-evals.json goes through POST /api/event (fresh chat);
// complaint.classification.route is scored top-1 (catalogId ∈ {expected} ∪ accept), top-3 ([catalogId,
// ...alternatives] contains one) and latency (≤ 4 s). Targets: ≥ 90 % top-1 on `clear` cases, 100 % top-3.
// ---------------------------------------------------------------------------
type RoutingCase = { id: string; text: string; expected: string; accept: string[]; clear: boolean };
type RoutingResult = RoutingCase & { got: string | null; choices: string[]; top1: boolean; top3: boolean; ms: number; traceId: string | null; chatId: string; error?: string };

async function runRoutingSuite(): Promise<never> {
  const { cases } = JSON.parse(readFileSync(resolve(REPO_ROOT, "fixtures/routing-evals.json"), "utf8")) as { cases: RoutingCase[] };
  const selected = ONLY ? cases.filter((c) => ONLY.includes(c.id)) : cases;
  const run = Date.now().toString(36);
  console.log(`311Relay routing evals · ${selected.length} phrasings · API ${API} · Phoenix ${OFFLINE ? "offline" : (phoenixBaseUrl() ?? "disabled")}`);
  try {
    await http("/api/health");
  } catch (err) {
    if (err instanceof ApiDown) {
      console.error(`\n✗ Bot API not reachable at ${API}. Start it first:  pnpm --filter @311relay/bot dev\n`);
      process.exit(2);
    }
    throw err;
  }
  const results: RoutingResult[] = [];
  for (const c of selected) {
    const chatId = `eval-route-${run}-${c.id}`;
    const t0 = Date.now();
    try {
      await send(chatId, { kind: "text", text: c.text } as EventBody);
      const ms = Date.now() - t0;
      const { complaints } = await http<{ complaints: ComplaintDraft[] }>(`/api/complaints?chatId=${encodeURIComponent(chatId)}&limit=1`);
      const route = complaints[0]?.classification?.route ?? null;
      const choices = [route?.catalogId, ...(route?.alternatives ?? [])].filter((x): x is string => !!x).slice(0, 3);
      const ok = (id: string | null | undefined) => !!id && (id === c.expected || c.accept.includes(id));
      results.push({ ...c, got: route?.catalogId ?? null, choices, top1: ok(route?.catalogId), top3: choices.some(ok), ms, traceId: complaints[0]?.traceId ?? null, chatId });
    } catch (err) {
      results.push({ ...c, got: null, choices: [], top1: false, top3: false, ms: Date.now() - t0, traceId: null, chatId, error: (err as Error).message });
    }
    const r = results.at(-1)!;
    console.log(`  ${r.top1 ? "✓" : r.top3 ? "~" : "✗"} ${(r.ms / 1000).toFixed(1).padStart(5)}s  ${r.id.padEnd(46)} → ${r.got ?? "null"}${r.top1 ? "" : `  (choices: ${r.choices.join(", ") || "none"})`}${r.error ? `  ERROR ${r.error}` : ""}`);
  }

  const clear = results.filter((r) => r.clear);
  const pct = (n: number, d: number) => (d ? (100 * n) / d : 0);
  const top1Clear = pct(clear.filter((r) => r.top1).length, clear.length);
  const top1All = pct(results.filter((r) => r.top1).length, results.length);
  const top3All = pct(results.filter((r) => r.top3).length, results.length);
  const sorted = results.map((r) => r.ms).sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const summary = { run, cases: results.length, clear: clear.length, top1Clear: +top1Clear.toFixed(1), top1All: +top1All.toFixed(1), top3All: +top3All.toFixed(1), p50Ms: p50, targetsMet: top1Clear >= 90 && top3All === 100 && p50 <= 4000 };
  console.log(`\ntop-1 (clear): ${summary.top1Clear}% · top-1 (all): ${summary.top1All}% · top-3: ${summary.top3All}% · p50 ${(p50 / 1000).toFixed(1)} s · targets ${summary.targetsMet ? "met" : "NOT met"} (≥90% / 100% / ≤4 s)`);

  if (!OFFLINE) {
    let n = 0;
    for (const r of results) {
      const meta = { scenario: r.id, suite: "311relay-routing", expected: r.expected };
      const anns = [
        { name: "routing_top1", label: r.top1 ? "correct" : "incorrect", score: r.top1 ? 1 : 0, explanation: `expected ${r.expected}, got ${r.got ?? "null"}` },
        { name: "routing_top3", label: r.top3 ? "in_top3" : "missed", score: r.top3 ? 1 : 0, explanation: `choices: ${r.choices.join(", ") || "none"}` },
        { name: "routing_latency", label: r.ms <= 4000 ? "within_budget" : "slow", score: r.ms <= 4000 ? 1 : 0, explanation: `${r.ms} ms (budget 4000 ms)` },
      ];
      for (const a of anns) {
        const ann = { ...a, metadata: meta };
        if (r.traceId && (await logPhoenixAnnotation({ traceId: r.traceId }, ann, { retries: 8, retryDelayMs: 1500 }))) n++;
        if (await logPhoenixAnnotation({ sessionId: r.chatId }, ann, { retries: 2, retryDelayMs: 1000 })) n++;
      }
    }
    console.log(`phoenix: ${n} annotations`);
  }
  const out = resolve(RUNS_DIR, `routing-evals-${run}.json`);
  mkdirSync(RUNS_DIR, { recursive: true });
  writeFileSync(out, `${JSON.stringify({ summary, results }, null, 2)}\n`);
  console.log(`results → ${out}`);
  process.exit(summary.targetsMet ? 0 : 1);
}

if (flag("routing")) await runRoutingSuite();

const scenarios = loadScenarios();
const runId = Date.now().toString(36);
console.log(`311Relay evals · ${scenarios.length} scenarios · API ${API} · Phoenix ${OFFLINE ? "offline" : (phoenixBaseUrl() ?? "disabled")}${SKIP_FILING ? " · skip-filing" : ""}`);

try {
  const health = await http<{ store?: string; providers?: Record<string, string> }>("/api/health");
  console.log(`bot: store=${health.store ?? "?"} ${health.providers ? Object.entries(health.providers).map(([k, v]) => `${k}=${v}`).join(" ") : ""}\n`);
} catch (err) {
  if (err instanceof ApiDown) {
    console.error(`\n✗ Bot API not reachable at ${API}.\n  Start it first:  pnpm --filter @311relay/bot dev   (or pass --api <url>)\n`);
    process.exit(2);
  }
  throw err;
}

const results: Result[] = [];
for (const s of scenarios) {
  process.stdout.write(`▸ ${s.id.padEnd(30)} `);
  const t0 = Date.now();
  try {
    const r = await runScenario(s, runId);
    results.push(r);
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.status.padEnd(22)} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (err) {
    if (err instanceof ApiDown) {
      console.error(`\n✗ Bot API went away (${err.message}).`);
      process.exit(2);
    }
    const e = (err as Error).message;
    results.push({ id: s.id, scenario: s.scenario, chatId: `eval-${s.id}-${runId}`, status: "ERROR", complaintId: null, traceId: null, traceUrl: null, sessionUrl: null, scores: {}, pass: false, error: e });
    console.log(`ERROR ${e.slice(0, 120)}`);
  }
}

// table
const SHORT: Record<string, string> = { category_accuracy: "category", information_completeness: "info", location_validity: "location", submission_safety: "safety", outcome_accuracy: "outcome", duplicate_relevance: "dupes" };
const cell = (v: Score | undefined) => (v == null ? "  -  " : v.score >= 1 ? " ok  " : v.score > 0 ? ` ${v.score.toFixed(1)} ` : " ✗   ");
console.log(`\n${"scenario".padEnd(30)} ${DIMENSIONS.map((d) => SHORT[d]!.padEnd(9)).join("")}result  status`);
console.log("-".repeat(30 + DIMENSIONS.length * 9 + 24));
for (const r of results) console.log(`${r.id.padEnd(30)} ${DIMENSIONS.map((d) => cell(r.scores[d]).padEnd(9)).join("")}${(r.pass ? "PASS" : "FAIL").padEnd(8)}${r.status}`);
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} scenarios passed`);
console.log("  (no-official-confirmation removed: it needed the replica portal; there is no safe way to produce it on a real form)");
for (const d of DIMENSIONS) {
  const vs = results.map((r) => r.scores[d]).filter((v): v is NonNullable<Score> => !!v);
  if (vs.length) console.log(`  ${d.padEnd(26)} ${(vs.reduce((a, v) => a + v.score, 0) / vs.length).toFixed(2)}  (n=${vs.length})`);
}
const failures = results.flatMap((r) => (r.error ? [`${r.id}: ${r.error}`] : Object.entries(r.scores).filter(([, v]) => v && v.score < 1).map(([k, v]) => `${r.id} · ${k}: ${v!.explanation}`)));
if (failures.length) console.log(`\nWhy:\n  ${failures.join("\n  ")}`);

// Phoenix
if (!OFFLINE && phoenixBaseUrl()) {
  console.log("\nPushing evaluations to Phoenix …");
  for (const r of results) {
    if (r.error) continue;
    r.annotated = await annotate(r);
    console.log(`  ${r.id.padEnd(30)} ${r.annotated} annotations  ${r.traceUrl ?? r.sessionUrl ?? ""}`);
  }
}

mkdirSync(RUNS_DIR, { recursive: true });
const out = resolve(RUNS_DIR, `evals-${runId}.json`);
writeFileSync(out, JSON.stringify({ runId, api: API, at: new Date().toISOString(), results }, null, 2));
console.log(`\nResults: ${out}`);
process.exit(passed === results.length ? 0 : 1);
