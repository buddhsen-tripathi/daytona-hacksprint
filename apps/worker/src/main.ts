/**
 * 311Relay isolated filing worker.
 *   node dist/main.js <payload.json> <outDir>
 * Always writes <outDir>/result.json (WorkerResult + `message`), prints `EVT {json}` per WorkerEvent on stdout,
 * and exits 0 once result.json is written (2 = bad CLI usage, nothing written).
 * Page text is data, never instructions: nothing read from a page changes what this worker does.
 */
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { openBrowser, type BrowserSession } from "./browser.js";
import { Recorder } from "./evidence.js";
import { createDemoPortalAdapter } from "./adapters/demo-portal.js";
import { createNycDotPotholeAdapter } from "./adapters/nyc-dot-pothole.js";
import { payloadSummary } from "./adapters/common.js";
import type { AdapterContext, FormAdapter, WorkerState } from "./adapters/types.js";
import {
  Outcome,
  nowIso,
  sanitizeUrl,
  validatePayload,
  type FilingErrorCode,
  type FilingPayload,
  type FilingStatus,
  type WorkerResultFile,
  type WorkerStep,
} from "./protocol.js";

const STREET_REPAIR_ARTICLE = "https://portal.311.nyc.gov/article/?kanumber=KA-01095";

const [payloadPath, outDirArg] = process.argv.slice(2);
if (!payloadPath || !outDirArg) {
  process.stderr.write("usage: node dist/main.js <payload.json> <outDir>\n");
  process.exit(2);
}
const outDir = resolve(outDirArg);
const startedAt = nowIso();
const rec = new Recorder(outDir);
const state: WorkerState = { submitClicked: false, finalUrl: null };
let payload: FilingPayload | null = null;
let attemptId = "unknown";
let session: BrowserSession | null = null;
let currentStep: WorkerStep = "navigate";
let written = false;
let resultData: { officialRequestNumber: string | null; officialReceiptUrl: string | null; confirmationText: string | null } = {
  officialRequestNumber: null,
  officialReceiptUrl: null,
  confirmationText: null,
};

function writeResult(status: FilingStatus, errorCode: FilingErrorCode | null, message: string, data?: Record<string, unknown>) {
  if (written) return;
  written = true;
  // Hard invariant: SUBMITTED only with a parsed request number + confirmation text.
  if (status === "SUBMITTED" && !(resultData.officialRequestNumber && resultData.confirmationText)) {
    status = "SUBMISSION_UNKNOWN";
    errorCode = "NO_CONFIRMATION";
  }
  if (status !== "SUBMITTED") resultData = { ...resultData, officialRequestNumber: null };
  rec.log(currentStep, status === "SUBMITTED" ? "info" : status === "HUMAN_ACTION_REQUIRED" ? "warn" : "error", `outcome ${status}${errorCode ? `/${errorCode}` : ""}: ${message}`, {
    status,
    errorCode,
    submitClicked: state.submitClicked,
    ...(data ?? {}),
  });
  const result: WorkerResultFile = {
    attemptId,
    status,
    errorCode,
    officialRequestNumber: resultData.officialRequestNumber,
    officialReceiptUrl: resultData.officialReceiptUrl,
    confirmationText: resultData.confirmationText,
    submitClicked: state.submitClicked,
    finalUrl: state.finalUrl,
    steps: rec.events,
    evidence: rec.evidence,
    startedAt,
    finishedAt: nowIso(),
    message,
    target: payload?.target ?? "demo",
    category: payload?.category ?? "street-pothole",
  };
  const tmp = join(outDir, "result.json.tmp");
  writeFileSync(tmp, JSON.stringify(result, null, 2));
  renameSync(tmp, join(outDir, "result.json"));
}

/** Map an unexpected error to an outcome. After the submit click, anything unexpected is SUBMISSION_UNKNOWN. */
function failFromError(err: unknown) {
  const msg = String((err as Error)?.message ?? err).split("\n")[0]!.slice(0, 300);
  if (session?.guard.offAllowlist) {
    return state.submitClicked
      ? writeResult("SUBMISSION_UNKNOWN", "OFF_ALLOWLIST_NAVIGATION", `The page tried to leave the allowed sites after Submit (${session.guard.offAllowlistUrl}). Outcome unknown; no retry.`)
      : writeResult("HUMAN_ACTION_REQUIRED", "OFF_ALLOWLIST_NAVIGATION", `The form tried to navigate to a site that is not allowed (${session.guard.offAllowlistUrl}). 311Relay stopped.`);
  }
  if (state.submitClicked)
    return writeResult("SUBMISSION_UNKNOWN", "CONNECTION_LOST_AFTER_SUBMIT", `The worker lost the page after Submit was clicked (${msg}). The report may or may not exist; no automatic retry is allowed.`);
  const name = (err as Error)?.name ?? "";
  if (name === "TimeoutError") return writeResult("FAILED", "TIMEOUT", `A browser step timed out during ${currentStep}: ${msg}`);
  if (/Target .*closed|browser has been closed|disconnected|ECONNREFUSED|WebSocket|connectOverCDP/i.test(msg)) return writeResult("FAILED", "BROWSER_ERROR", `Browser error during ${currentStep}: ${msg}`);
  return writeResult("FAILED", "WORKER_CRASH", `Worker error during ${currentStep}: ${msg}`);
}

async function finalEvidence() {
  if (!session) return;
  try {
    state.finalUrl = sanitizeUrl(session.page.url()) ?? state.finalUrl;
  } catch {
    /* ignore */
  }
}

function pickAdapter(p: FilingPayload): FormAdapter | "real-street-repair" {
  if (p.target === "demo") return createDemoPortalAdapter(p.category === "street-repair-defect" ? "street-repair" : "pothole");
  if (p.category === "street-pothole") return createNycDotPotholeAdapter();
  return "real-street-repair";
}

async function run() {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(payloadPath!, "utf8"));
  } catch (err) {
    return writeResult("FAILED", "WORKER_CRASH", `Could not read payload: ${String((err as Error)?.message ?? err)}`);
  }
  if (raw && typeof raw === "object" && typeof (raw as { attemptId?: unknown }).attemptId === "string") attemptId = (raw as { attemptId: string }).attemptId;
  const problems = validatePayload(raw);
  if (problems.length) return writeResult("FAILED", "WORKER_CRASH", `Invalid payload: ${problems.join("; ")}`, { problems });
  payload = raw as FilingPayload;
  rec.log("navigate", "info", "worker started", { attemptId, complaintId: payload.complaintId, approvedVersion: payload.approvedVersion, ...payloadSummary(payload) });

  const adapter = pickAdapter(payload);
  if (adapter === "real-street-repair") {
    state.finalUrl = STREET_REPAIR_ARTICLE;
    return writeResult(
      "HUMAN_ACTION_REQUIRED",
      null,
      `There is no automatable official route for Street Repair complaints (the NYC311 portal flow requires an interactive session). Please file it yourself here: ${STREET_REPAIR_ARTICLE}`,
      { articleUrl: STREET_REPAIR_ARTICLE },
    );
  }

  try {
    session = await openBrowser(payload, (m, d) => rec.log(currentStep, "info", m, d));
  } catch (err) {
    return writeResult("FAILED", "BROWSER_ERROR", `Could not open the browser: ${String((err as Error)?.message ?? err).split("\n")[0]}`);
  }
  const s = session;
  const ctx: AdapterContext = {
    page: s.page,
    payload,
    guard: s.guard,
    state,
    log: (step, level, message, data) => rec.log(step, level, message, data),
    shot: (step, name, summary) => rec.shot(s.page, step, name, summary),
    saveHtml: (step, name, summary) => rec.saveHtml(s.page, step, name, summary),
    checkGuard: (step) => {
      if (s.guard.offAllowlist)
        throw state.submitClicked
          ? new Outcome("SUBMISSION_UNKNOWN", "OFF_ALLOWLIST_NAVIGATION", `After Submit the page tried to leave the allowed sites (${s.guard.offAllowlistUrl}). Outcome unknown; no retry.`)
          : new Outcome("HUMAN_ACTION_REQUIRED", "OFF_ALLOWLIST_NAVIGATION", `During ${step} the form tried to navigate to a site that is not allowed (${s.guard.offAllowlistUrl}). 311Relay stopped.`);
    },
  };

  const step = async <T>(name: WorkerStep, fn: () => Promise<T>): Promise<T> => {
    currentStep = name;
    rec.log(name, "info", `step ${name} started`, { adapter: adapter.id });
    const out = await fn();
    ctx.checkGuard(name);
    state.finalUrl = sanitizeUrl(s.page.url());
    return out;
  };

  try {
    await step("navigate", () => adapter.navigate(ctx));
    await step("inspect", () => adapter.inspect(ctx));
    await step("fill", () => adapter.fill(ctx));
    const v = await step("validate", () => adapter.validate(ctx));
    if (!v.ok) {
      const empty = v.problems.filter((p) => p.startsWith("required field"));
      throw empty.length
        ? new Outcome("HUMAN_ACTION_REQUIRED", "UNEXPECTED_REQUIRED_FIELD", `Required fields could not be filled from the approved draft: ${empty.join("; ")}`, { problems: v.problems })
        : new Outcome("FAILED", "BROWSER_ERROR", `Field verification failed before submit; nothing was submitted: ${v.problems.join("; ")}`, { problems: v.problems });
    }
    await step("submit", () => adapter.submit(ctx));
    const c = await step("confirm", () => adapter.confirm(ctx));
    resultData = { officialRequestNumber: c.officialRequestNumber, officialReceiptUrl: c.receiptUrl, confirmationText: c.confirmationText };
    await finalEvidence();
    if (c.officialRequestNumber && c.confirmationText) writeResult("SUBMITTED", null, `Submitted. Official request number ${c.officialRequestNumber} was read from the confirmation page.`, { sr: c.officialRequestNumber });
    else writeResult("SUBMISSION_UNKNOWN", "NO_CONFIRMATION", "Submit was clicked but no confirmation number was found. No automatic retry.");
  } catch (err) {
    await finalEvidence();
    if (err instanceof Outcome) {
      // Defensive: an adapter must never report a clean HUMAN/FAILED for a non-rejection after the click.
      let status = err.status;
      if (state.submitClicked && status === "HUMAN_ACTION_REQUIRED" && err.errorCode !== "CAPTCHA") status = "SUBMISSION_UNKNOWN";
      writeResult(status, err.errorCode, err.message, err.data);
    } else {
      if (!s.page.isClosed()) await rec.shot(s.page, currentStep, "error-state").catch(() => null);
      failFromError(err);
    }
  }
}

function crash(kind: string) {
  return (err: unknown) => {
    try {
      currentStep = currentStep ?? "navigate";
      if (!written) failFromError(Object.assign(new Error(`${kind}: ${String((err as Error)?.message ?? err)}`), { name: "Crash" }));
    } finally {
      process.exit(0);
    }
  };
}
process.on("uncaughtException", crash("uncaughtException"));
process.on("unhandledRejection", crash("unhandledRejection"));
for (const sig of ["SIGTERM", "SIGINT"] as const)
  process.on(sig, () => {
    if (!written)
      state.submitClicked
        ? writeResult("SUBMISSION_UNKNOWN", "CONNECTION_LOST_AFTER_SUBMIT", `Worker was terminated (${sig}) after Submit was clicked. Outcome unknown; no retry.`)
        : writeResult("FAILED", "TIMEOUT", `Worker was terminated (${sig}) during ${currentStep}.`);
    process.exit(0);
  });

// Overall deadline (default 120 s if the payload is unreadable).
let totalMs = 120_000;
try {
  const p = JSON.parse(readFileSync(payloadPath, "utf8"));
  if (typeof p?.limits?.totalTimeoutMs === "number" && p.limits.totalTimeoutMs > 0) totalMs = p.limits.totalTimeoutMs;
} catch {
  /* handled in run() */
}
const deadline = setTimeout(async () => {
  if (!written) {
    currentStep = currentStep ?? "navigate";
    if (session && !session.page.isClosed()) await Promise.race([rec.shot(session.page, currentStep, "deadline"), new Promise((r) => setTimeout(r, 3000))]);
    await finalEvidence();
    state.submitClicked
      ? writeResult("SUBMISSION_UNKNOWN", "TIMEOUT", `Overall deadline (${totalMs} ms) hit after Submit was clicked. Outcome unknown; no automatic retry.`)
      : writeResult("FAILED", "TIMEOUT", `Overall deadline (${totalMs} ms) hit during ${currentStep}; nothing was submitted.`);
  }
  await session?.release().catch(() => {});
  process.exit(0);
}, totalMs);

run()
  .catch((err) => failFromError(err))
  .finally(async () => {
    clearTimeout(deadline);
    if (!written) writeResult("FAILED", "WORKER_CRASH", "Worker finished without an outcome.");
    await Promise.race([session?.release(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {});
    process.exit(0);
  });
