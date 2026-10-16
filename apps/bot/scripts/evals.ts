/**
 * 311Relay hackathon evaluation suite (design doc §13.2 / §13.3).
 *
 * Drives every scenario in fixtures/example-complaints.json through the bot
 * API (POST /api/event, fresh chatId per scenario), reads the final
 * complaint state, scores it with the category-aware scorer
 * (src/evals/scoring.ts) and pushes each score to Phoenix as a trace
 * annotation (scenario's root trace, from complaint.traceId) and a session
 * annotation (session = chatId).
 *
 *   pnpm --filter @311relay/bot evals                    # all scenarios, annotate Phoenix
 *   pnpm --filter @311relay/bot evals -- --offline       # skip Phoenix
 *   pnpm --filter @311relay/bot evals -- --only subway-delay-a-train,user-cancels
 *   pnpm --filter @311relay/bot evals -- --skip-filing   # don't press "Approve" on approve-flow scenarios
 *   pnpm --filter @311relay/bot evals -- --api http://localhost:3399
 *   pnpm --filter @311relay/bot evals -- --only subway-delay-a-train --with-dry-run subway-delay-a-train
 *
 * Requires the bot API running (`pnpm --filter @311relay/bot dev`, or for a local copy next to the live bot:
 * `TELEGRAM_BOT_TOKEN= PORT_API=3399 pnpm --filter @311relay/bot start` + `--api http://localhost:3399`).
 *
 * Transit categories (subway-delay → MTA): the runner answers the bot's line / direction / time follow-ups
 * like a resident would and STOPS AT THE APPROVAL CARD — nothing is filed by default. `--with-dry-run <id>`
 * taps Approve for that ONE scenario, which runs the real Daytona sandbox + Anchor browser against the MTA
 * form and stops before Submit. It refuses to run when ALLOW_REAL_SUBMIT is set (the bot must run without it too).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import type { ComplaintDraft, FilingAttempt } from "../src/core/contracts.js";
import { REPO_ROOT, RUNS_DIR, env } from "../src/integrations/env.js";
import { logPhoenixAnnotation, phoenixBaseUrl } from "../src/integrations/arize.js";
import {
  DIMENSIONS,
  type EvalMsg,
  type EvalScenario,
  type Score,
  type Transcript,
  asksLocation,
  classifyAsk,
  emptyTranscript,
  hasButton,
  isTransitScenario,
  passed,
  score,
} from "../src/evals/scoring.js";

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
/** The one scenario that performs the real Daytona + Anchor dry run (approve tapped). */
const DRY_RUN = opt("with-dry-run");
const FILING_TIMEOUT_MS = Number(opt("filing-timeout") ?? 900_000);

if (flag("with-dry-run") && !DRY_RUN) {
  console.error("✗ --with-dry-run needs a scenario id, e.g. --with-dry-run subway-delay-a-train");
  process.exit(2);
}
if (DRY_RUN && env.ALLOW_REAL_SUBMIT) {
  // env reads process.env + the root .env: a real submit must never happen from an eval.
  console.error(`✗ Refusing --with-dry-run: ALLOW_REAL_SUBMIT is set (${JSON.stringify(env.ALLOW_REAL_SUBMIT)}). Unset it here and in the bot process.`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
function loadScenarios(): EvalScenario[] {
  const p = resolve(REPO_ROOT, "fixtures/example-complaints.json");
  const list = JSON.parse(readFileSync(p, "utf8")) as EvalScenario[];
  // skipEvals: cases the scorer does not model.
  const runnable = list.filter((s) => !s.skipEvals);
  return ONLY ? runnable.filter((s) => ONLY.includes(s.id)) : runnable;
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------
type Msg = EvalMsg & { messageId: number };
type EventBody =
  | { kind: "command"; command: string; args: string }
  | { kind: "text"; text: string }
  | { kind: "photo"; fileId: string; caption: string | null }
  | { kind: "location"; latitude: number; longitude: number }
  | { kind: "callback"; data: string; messageId: number | null };
type EventResponse = {
  messages: Msg[];
  questions?: { options: { text: string; data: string }[] }[];
  filingStillRunning?: boolean;
  activeComplaint?: Pick<ComplaintDraft, "id" | "status" | "statusReason"> | null;
};

class ApiDown extends Error {}

async function http<T>(path: string, init?: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause?.code ?? (err as Error).name;
    if (cause === "ECONNREFUSED" || cause === "ENOTFOUND") throw new ApiDown(`${API} not reachable (${cause})`);
    throw err;
  }
  const body = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body) as T;
}

async function send(chatId: string, ev: EventBody, timeoutMs?: number): Promise<EventResponse> {
  const r = await http<EventResponse>(
    "/api/event",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chatId, username: "eval_bot", ...ev }) },
    timeoutMs,
  );
  return { ...r, messages: r.messages ?? [] };
}

const button = (msgs: EvalMsg[], action: string, suffix?: string): string | null => {
  for (const m of [...msgs].reverse()) for (const row of m.buttons ?? []) for (const b of row) if (b.data?.startsWith(`${action}:`) && (!suffix || b.data.endsWith(suffix))) return b.data;
  return null;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
type Result = {
  id: string;
  scenario: string;
  chatId: string;
  status: string;
  complaintId: string | null;
  traceId: string | null;
  traceUrl: string | null;
  sessionUrl: string | null;
  asks?: string[];
  scores: Record<string, Score>;
  pass: boolean;
  error?: string;
  annotated?: number;
};

async function runScenario(s: EvalScenario, runId: string): Promise<Result> {
  const chatId = `eval-${s.id}-${runId}`;
  const transit = isTransitScenario(s);
  const t: Transcript = emptyTranscript();
  const step = async (ev: EventBody, timeoutMs?: number) => {
    const r = await send(chatId, ev, timeoutMs);
    t.all.push(...r.messages);
    if (button(r.messages, "dup_continue") || button(r.messages, "dup_review")) t.dupOffered = true;
    const card = [...r.messages].reverse().find((m) => hasButton(m, "approve"));
    if (card && !t.draftOffered) t.card = card;
    if (card) t.draftOffered = true;
    if (!t.draftOffered && r.messages.some(asksLocation)) t.locationAskedBeforeDraft = true;
    return r;
  };

  await step({ kind: "command", command: "start", args: "" });
  // Location-based forms require first + last name (the bot gates approval on /name); the MTA form does not.
  if (!transit) await step({ kind: "command", command: "name", args: "Eval Resident" });

  let r: EventResponse;
  if (s.imageFixture) {
    const name = basename(s.imageFixture, extname(s.imageFixture));
    r = await step({ kind: "photo", fileId: `fixture:${name}`, caption: s.inputText });
  } else r = await step({ kind: "text", text: s.inputText ?? "" });
  if (s.location) r = await step({ kind: "location", latitude: s.location.latitude, longitude: s.location.longitude });

  if (transit) r = await answerTransitFollowUps(s, t, r, step);

  // duplicate review was offered (recorded in t.dupOffered); the resident chooses to continue with a new report
  const dup = button(r.messages, "dup_continue");
  if (dup) r = await step({ kind: "callback", data: dup, messageId: null });

  if (s.flow?.afterDraft === "cancel") {
    t.cancelled = true;
    await step({ kind: "command", command: "cancel", args: "" });
  } else if (transit && DRY_RUN === s.id) {
    // The ONE real Daytona + Anchor dry run (ALLOW_REAL_SUBMIT asserted unset at startup).
    const approve = button(t.all, "approve");
    if (approve) {
      t.approvedTapped = true;
      t.dryRun = true;
      r = await step({ kind: "callback", data: approve, messageId: null }, FILING_TIMEOUT_MS);
      await waitForFiling(chatId, t, r, step);
    }
  } else if (!transit && s.flow?.afterDraft === "approve" && !SKIP_FILING) {
    const approve = button(t.all, "approve");
    if (approve) {
      t.approvedTapped = true;
      await step({ kind: "callback", data: approve, messageId: null });
    }
  }
  // Transit default: stop at the approval card — nothing is filed.

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
  const scores = score(s, t, latest, attempts, { skipFiling: SKIP_FILING });
  return {
    id: s.id,
    scenario: s.scenario,
    chatId,
    status: latest?.status ?? "NONE",
    complaintId: latest?.id ?? null,
    traceId: latest?.traceId ?? null,
    traceUrl,
    sessionUrl,
    ...(transit ? { asks: t.asks } : {}),
    scores,
    pass: passed(scores),
  };
}

/** Answer line / direction / time (and learned) follow-ups like a resident, until the approval card shows up. */
async function answerTransitFollowUps(s: EvalScenario, t: Transcript, r: EventResponse, step: (ev: EventBody) => Promise<EventResponse>): Promise<EventResponse> {
  const e = s.expected.transit ?? {};
  for (let i = 0; i < 6 && !button(r.messages, "approve"); i++) {
    const status = r.activeComplaint?.status;
    if (status !== "NEEDS_INFORMATION") break;
    const ask = classifyAsk(r.messages[r.messages.length - 1], r.activeComplaint?.statusReason);
    if (!ask) break;
    t.asks.push(ask);
    if (ask === "line") r = await step({ kind: "text", text: s.followUps?.line ?? `The ${e.line ?? "A"} train` });
    else if (ask === "direction") {
      const want = (s.followUps?.direction ?? e.directionResolvedIncludes ?? e.directionIncludes ?? "").toLowerCase();
      const opts = r.messages.flatMap((m) => (m.buttons ?? []).flat()).filter((b) => b.data?.startsWith("set_direction:"));
      const pick = opts.find((b) => want && b.text.toLowerCase().includes(want)) ?? opts[0];
      r = pick?.data ? await step({ kind: "callback", data: pick.data, messageId: null }) : await step({ kind: "text", text: s.followUps?.direction ?? e.directionIncludes ?? "downtown" });
    } else if (ask === "time") {
      const now = button(r.messages, "set_time", ":now");
      r = now ? await step({ kind: "callback", data: now, messageId: null }) : await step({ kind: "text", text: "just now" });
    } else if (ask.startsWith("learned:")) r = await step({ kind: "text", text: "skip" });
    else break; // location / clarify / other: an unexpected question — scored by information_completeness
  }
  return r;
}

/** After the approve tap: answer any live worker question once, then poll until the attempt finishes. */
async function waitForFiling(chatId: string, t: Transcript, r: EventResponse, step: (ev: EventBody, timeoutMs?: number) => Promise<EventResponse>) {
  const deadline = Date.now() + FILING_TIMEOUT_MS;
  let answered = 0;
  while (r.filingStillRunning && r.questions?.length && answered < 3 && Date.now() < deadline) {
    const q = r.questions[r.questions.length - 1]!;
    const choice = q.options[0];
    if (!choice) break;
    answered++;
    r = await step({ kind: "callback", data: choice.data, messageId: null }, FILING_TIMEOUT_MS);
  }
  while (Date.now() < deadline) {
    const { complaints } = await http<{ complaints: ComplaintDraft[] }>(`/api/complaints?chatId=${encodeURIComponent(chatId)}&limit=1`);
    const st = complaints[0]?.status;
    if (st && st !== "APPROVED" && st !== "FILING") return;
    await sleep(3000);
  }
  t.all.push({ chatId, text: "(eval: filing did not finish before --filing-timeout)" });
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
const scenarios = loadScenarios();
if (DRY_RUN) {
  const target = scenarios.find((s) => s.id === DRY_RUN);
  if (!target || !isTransitScenario(target) || target.flow?.afterDraft === "cancel") {
    console.error(`✗ --with-dry-run ${DRY_RUN}: must name one runnable transit scenario that is not a cancel flow${ONLY ? " (and be included in --only)" : ""}.`);
    process.exit(2);
  }
}
const runId = Date.now().toString(36);
console.log(
  `311Relay evals · ${scenarios.length} scenarios · API ${API} · Phoenix ${OFFLINE ? "offline" : (phoenixBaseUrl() ?? "disabled")}${SKIP_FILING ? " · skip-filing" : ""} · ${DRY_RUN ? `dry run: ${DRY_RUN} (Daytona + Anchor, ALLOW_REAL_SUBMIT unset)` : "transit: stop at the approval card"}`,
);

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
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.status.padEnd(22)} ${((Date.now() - t0) / 1000).toFixed(1)}s${r.asks ? `  asked [${r.asks.join(",")}]` : ""}`);
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
const SHORT: Record<string, string> = {
  category_accuracy: "category",
  information_completeness: "info",
  location_validity: "location",
  transit_extraction: "transit",
  submission_safety: "safety",
  outcome_accuracy: "outcome",
  duplicate_relevance: "dupes",
  alert_corroboration: "alerts",
};
const cell = (v: Score | undefined) => (v == null ? "  -  " : v.score >= 1 ? " ok  " : v.score > 0 ? ` ${v.score.toFixed(1)} ` : " ✗   ");
console.log(`\n${"scenario".padEnd(30)} ${DIMENSIONS.map((d) => SHORT[d]!.padEnd(9)).join("")}result  status`);
console.log("-".repeat(30 + DIMENSIONS.length * 9 + 24));
for (const r of results) console.log(`${r.id.padEnd(30)} ${DIMENSIONS.map((d) => cell(r.scores[d]).padEnd(9)).join("")}${(r.pass ? "PASS" : "FAIL").padEnd(8)}${r.status}`);
const passedCount = results.filter((r) => r.pass).length;
console.log(`\n${passedCount}/${results.length} scenarios passed`);
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
writeFileSync(out, JSON.stringify({ runId, api: API, at: new Date().toISOString(), dryRun: DRY_RUN, results }, null, 2));
console.log(`\nResults: ${out}`);
process.exit(passedCount === results.length ? 0 : 1);
