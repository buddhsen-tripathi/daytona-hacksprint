/**
 * Filing smoke test: runs filing.executeFiling end-to-end on a fake APPROVED complaint.
 *
 *   tsx scripts/filing-smoke.ts --mode normal|captcha|flaky|reject [--local] [--target real] [--hold <sec>]
 *
 * Default: Daytona sandbox + Anchor cloud browser (needs DAYTONA_API_KEY + ANCHOR_API_KEY).
 * --local: local child-process portal/worker + local Chrome.
 * --hold: keep browser+sandbox for a human handoff (default 0 here so cleanup can be verified).
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ComplaintDraft, PortalMode, Resident, SpanHelpers, Tracer } from "../src/core/contracts.js";
import { EMPTY_LOCATION, nowIso, shortId } from "../src/core/contracts.js";
import { REPO_ROOT } from "../src/integrations/env.js";

const envFile = resolve(REPO_ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const mode = (opt("mode") ?? "normal") as PortalMode;
const local = flag("local");
const target = opt("target") === "real" ? "real" : "demo";
const holdSec = Number(opt("hold") ?? 0);

const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

/** Console tracer: prints each span with its duration (stands in for Phoenix here). */
function consoleTracer(): Tracer & { spans: { name: string; ms: number; ok: boolean }[] } {
  const spans: { name: string; ms: number; ok: boolean }[] = [];
  const noop: SpanHelpers = { set() {}, input() {}, output() {}, llm() {}, retriever() {}, tool() {}, metadata() {} };
  return {
    spans,
    async span(name, _attrs, fn) {
      const s = Date.now();
      try {
        const r = await fn(noop.set, noop);
        spans.push({ name, ms: Date.now() - s, ok: true });
        console.log(`  [span] ${name} ${Date.now() - s} ms`);
        return r;
      } catch (err) {
        spans.push({ name, ms: Date.now() - s, ok: false });
        console.log(`  [span] ${name} FAILED after ${Date.now() - s} ms: ${(err as Error).message}`);
        throw err;
      }
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

async function loadStore() {
  try {
    const m = await import("../src/integrations/memory-store.js");
    return m.createMemoryStore();
  } catch {
    throw new Error("memory store missing (apps/bot/src/integrations/memory-store.ts)");
  }
}

async function main() {
  const { createFilingService } = await import("../src/services/filing.js");
  const { resolveEvidencePath } = await import("../src/services/evidence-registry.js");
  let sandbox, browser;
  if (local) {
    sandbox = (await import("../src/integrations/local-sandbox.js")).createLocalSandboxProvider();
    browser = (await import("../src/integrations/local-browser.js")).createLocalBrowserProvider();
  } else {
    sandbox = (await import("../src/integrations/daytona.js")).createDaytonaSandboxProvider();
    browser = (await import("../src/integrations/anchor.js")).createAnchorBrowserProvider();
  }
  const store = await loadStore();
  const tracer = consoleTracer();
  const filing = createFilingService({ store, tracer, sandboxProvider: sandbox, browserProvider: browser, target, handoffHoldMs: holdSec * 1000 });

  const now = nowIso();
  const resident: Resident = {
    id: shortId("res"),
    telegramChatId: "smoke-chat",
    telegramUsername: "smoke",
    preferredLanguage: "en",
    demoPortalMode: mode,
    contactName: "Ada Lovelace",
    contactEmail: null,
    createdAt: now,
  };
  const complaint: ComplaintDraft = {
    id: shortId("cmp"),
    telegramChatId: resident.telegramChatId,
    residentId: resident.id,
    status: "APPROVED",
    category: "street-pothole",
    triage: "SUPPORTED",
    description: "Pothole about 40 cm wide and 8 cm deep in the right lane, in front of the building entrance.",
    userMessages: ["big pothole in front of 1515 Broadway"],
    location: { ...EMPTY_LOCATION, latitude: 40.758, longitude: -73.9855, address: "1515 Broadway, Manhattan", borough: "Manhattan", rawInput: "1515 Broadway", source: "text", userConfirmed: true, withinNyc: true },
    media: [],
    classification: null,
    missingFields: [],
    needsEmergencyReferral: false,
    confidence: 0.92,
    duplicates: [],
    duplicateReviewed: true,
    draftVersion: 1,
    approvedVersion: 1,
    approvedAt: now,
    activeAttemptId: null,
    officialRequestNumber: null,
    statusReason: null,
    traceId: null,
    createdAt: now,
    updatedAt: now,
  };
  await store.createComplaint(complaint);

  console.log(`== filing smoke: mode=${mode} target=${target} providers=${sandbox.name}+${browser.name}`);
  const outcome = await filing.executeFiling(complaint, { resident, onProgress: (t) => console.log(`${stamp()} > ${t}`) });
  console.log(`${stamp()} executeFiling returned`);

  console.log("\n== outcome");
  console.log(JSON.stringify(outcome, null, 2));

  const attempt = await store.getAttempt(outcome.attemptId);
  if (attempt) {
    console.log("\n== worker events");
    for (const e of attempt.workerEvents) console.log(`  ${e.ts.slice(11, 23)} ${e.step.padEnd(8)} ${e.level.padEnd(5)} ${e.message}`);
    console.log("\n== evidence");
    for (const e of attempt.evidence) {
      const local = resolveEvidencePath(e.id);
      console.log(`  ${e.type.padEnd(10)} ${String(e.step ?? "-").padEnd(8)} ${local?.path ?? e.storageReference}`);
    }
    console.log("\n== attempt");
    console.log(JSON.stringify({ sandboxId: attempt.sandboxId, browserSessionId: attempt.browserSessionId, liveViewUrl: attempt.liveViewUrl, recordingUrl: attempt.recordingUrl, outcome: attempt.outcome, errorCode: attempt.errorCode, sr: attempt.officialRequestNumber, verified: attempt.verified, notes: attempt.verificationNotes, timing: attempt.timing }, null, 2));
  }
  const after = await store.getComplaint(complaint.id);
  console.log(`\n== complaint status: ${after?.status} (reason ${after?.statusReason}, SR ${after?.officialRequestNumber})`);
  console.log("== transitions:", (store as unknown as { transitions: { from: string; to: string }[] }).transitions.map((t) => `${t.from}->${t.to}`).join(", "));
  console.log("== workflow patterns:", (await store.getWorkflowPatterns({ target, category: "street-pothole" })).map((p) => p.kind).join(", "));
  console.log("== spans:", tracer.spans.map((s) => `${s.name}=${s.ms}ms`).join(" "));

  // Second call must refuse after SUBMISSION_UNKNOWN (never auto-retry).
  if (outcome.status === "SUBMISSION_UNKNOWN") {
    const again = await filing.executeFiling({ ...(after ?? complaint), status: "APPROVED" }, { resident, onProgress: () => {} });
    console.log(`== retry guard: second executeFiling ⇒ ${again.status} attempt=${again.attemptId} (same attempt: ${again.attemptId === outcome.attemptId})`);
  }

  console.log(`\n${stamp()} waiting for background cleanup/recording…`);
  await filing.drain();
  const final = attempt ? await store.getAttempt(attempt.id) : null;
  console.log(`== recording: ${final?.recordingUrl ?? "(none)"}`);
  if (!local && final?.sandboxId) {
    const { daytonaSandboxGone } = await import("../src/integrations/daytona.js");
    const g = await daytonaSandboxGone(final.sandboxId);
    console.log(`== daytona sandbox ${final.sandboxId}: ${g.gone ? "GONE" : "STILL PRESENT"} (state ${g.state ?? "not found"})`);
  }
  console.log(`${stamp()} done`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
