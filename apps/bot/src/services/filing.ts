/**
 * Filing service (design doc §6.6–6.7, §9.2–9.4, §10, §15.2, §18.4, §19).
 *
 * executeFiling(approved complaint):
 *   guard (APPROVED + approvedVersion === draftVersion; never re-run after SUBMISSION_UNKNOWN)
 *   → FilingAttempt + complaint → FILING
 *   → Anchor session ‖ Daytona sandbox (worker + CDP relay to Anchor)
 *   → FilingPayload → sandbox.runWorker (EVT stream → Telegram progress + browser.* spans)
 *   → evidence download to .runs/<attemptId>/ → receipts.verifyReceipt
 *   → persist attempt / complaint transition / official request / workflow pattern
 *   → ALWAYS destroy sandbox + close browser (deferred only for an explicit human handoff
 *     with a live view, so the user can finish in the same browser).
 *
 * officialRequestNumber is only ever taken from a verified confirmation page.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type {
  AgentMemory,
  BrowserProvider,
  BrowserSessionInfo,
  CategoryId,
  ComplaintDraft,
  Evidence,
  FilingAttempt,
  FilingErrorCode,
  FilingOutcome,
  FilingPayload,
  FilingStatus,
  FilingTarget,
  Resident,
  SandboxHandle,
  SandboxProvider,
  Store,
  Tracer,
  WorkerAnswer,
  WorkerEvent,
  WorkerQuestion,
  WorkerResult,
  WorkflowPattern,
} from "../core/contracts.js";
import { CATEGORIES, DEFAULT_QUESTION_TIMEOUT_MS, nowIso, questionFromEvent, shortId } from "../core/contracts.js";
import { transition } from "../core/state-machine.js";
import { askFromOutcome, recordAskPattern } from "./memory.js";
import { askPatternItem, filingOutcomeItem, liveQuestionItem } from "./agent-memory.js";
import { RUNS_DIR, env } from "../integrations/env.js";
import { isRealOnly } from "../core/knowledge.js";
import { registerEvidenceFile } from "./evidence-registry.js";
import { verifyReceipt, type ReceiptVerification } from "./receipts.js";
import { downloadAnchorRecording } from "../integrations/anchor.js";

/** Recording polling (Anchor finalizes recordings 10–90 s after the session ends). */
const RECORDING_POLL_MS = 10_000;
const RECORDING_DEADLINE_MS = 3 * 60_000;
const RECORDING_MAX_BYTES = 200 * 1024 * 1024;

export type FilingOpts = {
  resident: Resident;
  onProgress: (text: string) => void;
  /** Background callback once the session recording is downloaded to .runs/<attemptId>/recording.mp4 (Anchor only). */
  onRecording?: (localPath: string, evidence: Evidence) => Promise<void>;
  /**
   * Live follow-up question from the worker (the browser holds the page). Resolve with the resident's answer,
   * or null to give up (the worker then times out into the usual hand-off). Absent ⇒ questions are disabled
   * (limits.questionTimeoutMs = 0) and the worker behaves exactly as before.
   */
  onQuestion?: (q: WorkerQuestion & { attemptId: string; timeoutMs: number }) => Promise<WorkerAnswer | null>;
};

export const WAITING_FOR_ANSWER = "⏸ Waiting for your answer — the browser is holding the page";

type WorkerStep = WorkerEvent["step"];

export type FilingServiceDeps = {
  store: Store;
  tracer: Tracer;
  /** Agent memory (#4): filing outcomes, live questions + answers, learned ask-before-approval rules. Absent ⇒ no memory writes. */
  memory?: AgentMemory | null;
  /** Either naming is accepted (integrations/index.ts passes `sandbox` / `browser`). */
  sandboxProvider?: SandboxProvider | null;
  sandbox?: SandboxProvider | null;
  browserProvider?: BrowserProvider | null;
  browser?: BrowserProvider | null;
  evidenceRegistry?: { registerEvidenceFile(evidence: Evidence, localPath: string): string | void };
  /** Always "real" (official forms); kept optional for older callers. */
  target?: FilingTarget;
  limits?: Partial<FilingPayload["limits"]>;
};

export type FilingService = {
  executeFiling(complaint: ComplaintDraft, opts: FilingOpts): Promise<FilingOutcome>;
  /** Resolves when deferred cleanups + background recording lookups are done (scripts/tests). */
  drain(): Promise<void>;
};

/** Official hosts per category (navigation allowlist). Adding a category = add its official hosts here. */
const REAL_ALLOWED_HOSTS: Record<CategoryId, string[]> = {
  "subway-delay": ["contact.mta.info", "mta.info", "new.mta.info"],
};

const DEFAULT_LIMITS: FilingPayload["limits"] = { totalTimeoutMs: 150_000, stepTimeoutMs: 20_000, maxNavigationRetries: 1 };

// ---------------------------------------------------------------------------
// User-facing text (§6.7). Never claims a submission that was not verified.
// ---------------------------------------------------------------------------
const REASONS: Partial<Record<FilingErrorCode, string>> = {
  CAPTCHA: "The form asks you to prove you're human (CAPTCHA). I never bypass those.",
  LOGIN_REQUIRED: "The form asks you to sign in. I don't log in on your behalf.",
  UNEXPECTED_REQUIRED_FIELD: "The form asked for information I don't have from you.",
  OFF_ALLOWLIST_NAVIGATION: "The form tried to send the browser to a site outside the official allowlist, so I stopped.",
  FORM_REJECTED: "The portal rejected the report details (it could not locate the street).",
  NO_CONFIRMATION: "No official confirmation number was shown.",
  CONNECTION_LOST_AFTER_SUBMIT: "The connection dropped right after the report was submitted.",
  NAVIGATION_FAILED: "The official form could not be opened.",
  TIMEOUT: "The filing took too long and was stopped.",
  BROWSER_ERROR: "The cloud browser could not be started.",
  WORKER_CRASH: "The isolated filing worker stopped unexpectedly.",
  SANDBOX_ERROR: "The isolated filing environment could not be started.",
};
const reasonFor = (code: FilingErrorCode | null | undefined) => (code ? (REASONS[code] ?? code) : "Unknown error.");

export const FILING_MESSAGES = {
  submitted: (sr: string) => `Your NYC311 report was accepted.\n\nService request: ${sr}\n\nI'll keep this reference here so you can check its status later.`,
  humanAction: (code: FilingErrorCode | null, liveViewUrl: string | null, workerMessage?: string | null) =>
    [
      "Your report is prepared, but I couldn't complete the official submission automatically.",
      "",
      "You can finish it on NYC311. I haven't filed anything on your behalf.",
      "",
      workerMessage || reasonFor(code),
      liveViewUrl ? `\nYou can take over the same browser session here (live for a few minutes): ${liveViewUrl}` : null,
    ]
      .filter((l) => l !== null)
      .join("\n"),
  unknown: (workerMessage?: string | null) =>
    "The filing attempt finished without a reliable confirmation.\n\nI'm not submitting again automatically because that could create a duplicate. Please check the official portal before retrying." +
    (workerMessage ? `\n\n${workerMessage}` : ""),
  failed: (code: FilingErrorCode | null, workerMessage?: string | null) => (workerMessage ? `${workerMessage}${/nothing was submitted/i.test(workerMessage) ? "" : " Nothing was submitted."}` : `${reasonFor(code)} Nothing was submitted.`),
  /** MTA Customer Feedback (subway-delay). */
  mtaSubmitted: (sr: string) => `The MTA accepted your complaint. Reference: ${sr}. They usually reply by email if you provided one.`,
  mtaDryRun: (liveViewUrl: string | null) =>
    "Dry run: I filled the MTA form completely and stopped before Submit (ALLOW_REAL_SUBMIT is off). Screenshot attached." +
    (liveViewUrl ? `\n\nIf you want to send it yourself, the same browser is open for a few minutes: ${liveViewUrl}` : ""),
  notApproved: () => "This report isn't approved in its current version, so I didn't file anything. Please review and approve the latest draft.",
};

function messageFor(status: FilingStatus, sr: string | null, code: FilingErrorCode | null, liveViewUrl: string | null, workerMessage: string | null, category?: CategoryId): string {
  if (category && isRealOnly(category)) {
    if (status === "SUBMITTED") return FILING_MESSAGES.mtaSubmitted(sr!);
    if (status === "HUMAN_ACTION_REQUIRED" && !code) return FILING_MESSAGES.mtaDryRun(liveViewUrl);
  }
  switch (status) {
    case "SUBMITTED":
      return FILING_MESSAGES.submitted(sr!);
    case "HUMAN_ACTION_REQUIRED":
      return FILING_MESSAGES.humanAction(code, liveViewUrl, workerMessage);
    case "SUBMISSION_UNKNOWN":
      return FILING_MESSAGES.unknown(workerMessage);
    default:
      return FILING_MESSAGES.failed(code, workerMessage);
  }
}

/** Progress lines sent to Telegram at the first event of each worker step. */
const STEP_PROGRESS: Partial<Record<WorkerStep, string>> = {
  inspect: "Opened the form",
  validate: "Filled your details",
  submit: "Submitting…",
  confirm: "Reading confirmation…",
};

/** Hide the signed part of Daytona preview hostnames (`<port>-<signed>.<domain>`) in exported traces. */
export function redactPreview(s: string): string {
  return s.replace(/\b(\d{2,5})-[a-z0-9-]{8,}\.([a-z0-9.-]+)/gi, "$1-***.$2");
}
const redactJson = (v: unknown) => JSON.parse(redactPreview(JSON.stringify(v ?? null)));

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".html": "text/html", ".log": "text/plain", ".txt": "text/plain", ".json": "application/json" };

function todayNyc(): string {
  return nycDate(new Date().toISOString());
}

function nycDate(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(Number.isFinite(d.getTime()) ? d : new Date());
}

function patternFor(_target: FilingTarget, status: FilingStatus, code: FilingErrorCode | null, result: WorkerResult | null): { kind: string; description: string; hint: Record<string, unknown> } {
  if (status === "SUBMITTED")
    return {
      kind: "confirmation-parsed",
      description: "Confirmation page exposed a parseable service request number.",
      hint: { finalUrlPath: result?.finalUrl ? new URL(result.finalUrl).pathname.replace(/[A-Z0-9-]{10,}$/, ":sr") : null },
    };
  switch (code) {
    case "CAPTCHA":
      return { kind: "captcha-on-step1", description: "Official form shows a CAPTCHA; hand off to the resident in the live view.", hint: { handoff: "live_view", detectBeforeClick: true } };
    case "CONNECTION_LOST_AFTER_SUBMIT":
      return { kind: "flaky-submit", description: "Connection dropped after submit; outcome unknown. Never auto-retry; ask the resident to check the portal.", hint: { autoRetry: false } };
    case "FORM_REJECTED":
      return { kind: "form-rejected-location", description: "Portal rejected the submitted location text.", hint: { checkCrossStreets: true } };
    default:
      return { kind: `outcome-${(code ?? status).toLowerCase().replace(/_/g, "-")}`, description: `Attempt ended ${status}${code ? `/${code}` : ""}.`, hint: {} };
  }
}

/** Every category files against its official form. */
export function targetFor(_category?: CategoryId, _configured?: FilingTarget): FilingTarget {
  return "real";
}

export function allowedHostsFor(category: CategoryId, formUrl: string, _target?: FilingTarget): string[] {
  return [...new Set([new URL(formUrl).hostname, ...(REAL_ALLOWED_HOSTS[category] ?? [])])];
}

export function realSubmitAuthorizedFor(complaint: Pick<ComplaintDraft, "approvedVersion" | "draftVersion">, target: FilingTarget): boolean {
  return target === "real" && env.ALLOW_REAL_SUBMIT === "1" && complaint.approvedVersion != null && complaint.approvedVersion === complaint.draftVersion;
}

/** The `form` block of the FilingPayload. Contact fields are only ever user-provided. */
export function buildForm(complaint: ComplaintDraft, resident: Resident, _target?: FilingTarget): FilingPayload["form"] {
  const category = complaint.category;
  return {
    description: complaint.description,
    address: complaint.location.address,
    borough: complaint.location.borough,
    latitude: complaint.location.latitude,
    longitude: complaint.location.longitude,
    // Only ever user-provided (categories with requiresContactName are gated on /name before approval).
    contactName: resident.contactName ?? null,
    contactEmail: resident.contactEmail ?? null,
    contactPhone: null,
    dateObserved: complaint.transit?.incidentTime ? nycDate(complaint.transit.incidentTime) : todayNyc(),
    ...(complaint.transit ? { transit: complaint.transit } : {}),
    // [memory] answers to questions learned from earlier filings (workflow memory, services/memory.ts)
    ...(complaint.extraFields && Object.keys(complaint.extraFields).length ? { extraFields: complaint.extraFields } : {}),
  };
}

/** What the worker would receive for this complaint, minus the per-attempt browser/sandbox fields (scripts, previews). */
export function previewPayload(complaint: ComplaintDraft, resident: Resident, _configured?: FilingTarget) {
  if (!complaint.category) return null;
  const category = complaint.category;
  const target = targetFor(category);
  const cat = CATEGORIES[category];
  const formUrl = cat.officialFormUrl;
  return {
    approvedVersion: complaint.approvedVersion,
    target,
    category,
    formUrl,
    allowedHosts: allowedHostsFor(category, formUrl, target),
    form: buildForm(complaint, resident, target),
    realSubmitAuthorized: realSubmitAuthorizedFor(complaint, target),
    limits: DEFAULT_LIMITS,
  };
}

export function createFilingService(deps: FilingServiceDeps): FilingService {
  const { store, tracer } = deps;
  const memory = deps.memory ?? null;
  const sandboxProvider = deps.sandboxProvider ?? deps.sandbox ?? null;
  const browserProvider = deps.browserProvider ?? deps.browser ?? null;
  const register = deps.evidenceRegistry?.registerEvidenceFile ?? registerEvidenceFile;
  const background = new Set<Promise<unknown>>();
  const track = (p: Promise<unknown>) => {
    const q = p.catch(() => {}).finally(() => background.delete(q));
    background.add(q);
  };

  async function executeFiling(complaint: ComplaintDraft, opts: FilingOpts): Promise<FilingOutcome> {
    const t0 = Date.now();
    // Every category files against its official site (subway: the MTA wizard).
    const target: FilingTarget = "real";
    const progress = (text: string) => {
      try {
        opts.onProgress(text);
      } catch {
        /* transport problems never break filing */
      }
    };

    // (a) guards ------------------------------------------------------------
    const prior = await store.listAttempts({ complaintId: complaint.id });
    const unknown = prior.find((a) => a.outcome === "SUBMISSION_UNKNOWN");
    if (unknown) {
      return {
        complaintId: complaint.id,
        attemptId: unknown.id,
        status: "SUBMISSION_UNKNOWN",
        errorCode: unknown.errorCode ?? "NO_CONFIRMATION",
        message: FILING_MESSAGES.unknown(),
      };
    }
    if (complaint.status !== "APPROVED" || complaint.approvedVersion == null || complaint.approvedVersion !== complaint.draftVersion || !complaint.category) {
      return { complaintId: complaint.id, attemptId: "none", status: "FAILED", message: FILING_MESSAGES.notApproved() };
    }
    const category: CategoryId = complaint.category;
    const cat = CATEGORIES[category];

    // (b) attempt + FILING -----------------------------------------------------
    const traceId = tracer.currentTraceId();
    const attempt: FilingAttempt = {
      id: shortId("att"),
      complaintId: complaint.id,
      approvedVersion: complaint.approvedVersion,
      target,
      category,
      sandboxId: null,
      sandboxProvider: sandboxProvider?.name ?? null,
      browserSessionId: null,
      browserProvider: browserProvider?.name ?? null,
      liveViewUrl: null,
      recordingUrl: null,
      outcome: null,
      errorCode: null,
      officialRequestNumber: null,
      verified: false,
      verificationNotes: null,
      evidence: [],
      workerEvents: [],
      traceId,
      traceUrl: traceId ? tracer.traceUrl(traceId) : null,
      timing: { sandboxMs: null, browserMs: null, workerMs: null, totalMs: null },
      createdAt: nowIso(),
      finishedAt: null,
    };
    await store.createAttempt(attempt);
    let current: ComplaintDraft;
    try {
      current = await transition(store, { ...complaint, activeAttemptId: attempt.id }, "FILING", { reason: `filing attempt ${attempt.id}`, actor: "system" });
    } catch (err) {
      attempt.outcome = "FAILED";
      attempt.verificationNotes = `could not enter FILING: ${(err as Error).message}`;
      attempt.finishedAt = nowIso();
      await store.saveAttempt(attempt);
      return { complaintId: complaint.id, attemptId: attempt.id, status: "FAILED", message: FILING_MESSAGES.notApproved() };
    }

    let session: BrowserSessionInfo | null = null;
    let handle: SandboxHandle | null = null;
    let result: WorkerResult | null = null;
    let verification: ReceiptVerification | null = null;
    let holdForHandoff = false;
    let held = false;
    /** true once the final attempt record is saved; later recording lookups update the store. */
    let persisted = false;
    const providerLog: { at: number; msg: string; data?: Record<string, unknown> }[] = [];
    const onProviderEvent = (msg: string, data?: Record<string, unknown>) => {
      providerLog.push({ at: Date.now() - t0, msg, data: data ? redactJson(data) : undefined });
      if (data && "liveViewUrl" in data) return; // the URL itself goes into the final message, not a progress line
      progress(msg);
    };

    const cleanup = async () => {
      const s = session;
      const h = handle;
      session = null;
      handle = null;
      await Promise.all([h?.destroy().catch(() => {}), s?.close().catch(() => {})]);
      return s;
    };
    /**
     * Background (never blocks the outcome): poll the Anchor recording every 10 s for up to 3 min,
     * download it to .runs/<attemptId>/recording.mp4, register it as "recording" evidence (playable at
     * /api/evidence/:id) and hand it to opts.onRecording (the orchestrator sends it to the resident).
     * Local browser: no recording, skipped silently.
     */
    const collectRecording = async (s: BrowserSessionInfo | null, _inlineTries = 0, _backgroundTries = 0) => {
      if (!s || s.provider === "local") return;
      track(
        (async () => {
          const deadline = Date.now() + RECORDING_DEADLINE_MS;
          let url: string | null = null;
          while (!url && Date.now() < deadline) {
            url = await s.getRecordingUrl().catch(() => null);
            if (!url) await new Promise((r) => setTimeout(r, RECORDING_POLL_MS));
          }
          if (!url) {
            console.warn(`[filing] no recording for ${attempt.id} after ${RECORDING_DEADLINE_MS / 1000} s`);
            return;
          }
          const localPath = join(RUNS_DIR, attempt.id, "recording.mp4");
          let bytes = 0;
          try {
            bytes = (await downloadAnchorRecording(url, localPath, { maxBytes: RECORDING_MAX_BYTES })).bytes;
          } catch (err) {
            console.warn(`[filing] recording download failed for ${attempt.id}:`, (err as Error).message);
            return;
          }
          const ev: Evidence = { id: shortId("ev"), attemptId: attempt.id, complaintId: complaint.id, type: "recording", step: null, summary: `Anchor session recording (${(bytes / 1_048_576).toFixed(1)} MB)`, storageReference: "", mime: "video/mp4", createdAt: nowIso() };
          const ref = register(ev, localPath);
          ev.storageReference = typeof ref === "string" && ref ? ref : `/api/evidence/${encodeURIComponent(ev.id)}`;
          attempt.recordingUrl = ev.storageReference;
          attempt.evidence.push(ev);
          if (persisted) {
            const latest = (await store.getAttempt(attempt.id)) ?? attempt;
            await store.saveAttempt({ ...latest, recordingUrl: ev.storageReference, evidence: [...latest.evidence.filter((e) => e.type !== "recording"), ev] }).catch(() => {});
          }
          if (opts.onRecording) await opts.onRecording(localPath, ev).catch((err) => console.warn("[filing] onRecording failed:", (err as Error).message));
        })(),
      );
    };

    try {
      if (!sandboxProvider) throw Object.assign(new Error("no sandbox provider configured"), { code: "SANDBOX_ERROR" as FilingErrorCode });
      if (!browserProvider) throw Object.assign(new Error("no browser provider configured"), { code: "BROWSER_ERROR" as FilingErrorCode });

      // (c) browser ‖ (d) sandbox --------------------------------------------
      progress("Preparing an isolated filing worker…");
      const [b, s] = await Promise.allSettled([
        tracer.span("anchor.create_session", { "attempt.id": attempt.id, "browser.provider": browserProvider.name }, async (set, oi) => {
          oi.tool({ name: "anchor.create_session", description: "Create a recorded cloud browser session (CDP) for the worker", parameters: { recording: true, viewport: "1280x900" } });
          const tb = Date.now();
          const sess = await browserProvider.createSession({ attemptId: attempt.id, onEvent: onProviderEvent });
          attempt.timing.browserMs = Date.now() - tb;
          set("browser.session_id", sess.id);
          set("browser.live_view", Boolean(sess.liveViewUrl));
          oi.output({ sessionId: sess.id, provider: sess.provider, liveView: Boolean(sess.liveViewUrl), durationMs: attempt.timing.browserMs });
          return sess;
        }),
        tracer.span("daytona.create_worker", { "attempt.id": attempt.id, "sandbox.provider": sandboxProvider.name, "filing.target": target }, async (set, oi) => {
          oi.tool({ name: "daytona.create_worker", description: "Disposable sandbox: upload worker, install playwright-core, relay CDP to the Anchor browser", parameters: { target } });
          const ts = Date.now();
          const h = await sandboxProvider.provision({ attemptId: attempt.id, onEvent: onProviderEvent });
          attempt.timing.sandboxMs = Date.now() - ts;
          set("sandbox.id", h.id);
          oi.output({ sandboxId: h.id, provider: h.provider, durationMs: attempt.timing.sandboxMs, stages: providerLog.map((l) => l.msg) });
          return h;
        }),
      ]);
      if (b.status === "fulfilled") session = b.value;
      if (s.status === "fulfilled") handle = s.value;
      if (b.status === "rejected") throw Object.assign(new Error(`browser: ${(b.reason as Error)?.message}`), { code: "BROWSER_ERROR" as FilingErrorCode });
      if (s.status === "rejected") throw Object.assign(new Error(`sandbox: ${(s.reason as Error)?.message}`), { code: "SANDBOX_ERROR" as FilingErrorCode });
      const sess = session!;
      const box = handle!;
      attempt.sandboxId = box.id;
      attempt.browserSessionId = sess.id;
      attempt.liveViewUrl = sess.liveViewUrl;
      if (sess.liveViewUrl) {
        attempt.evidence.push({ id: shortId("ev"), attemptId: attempt.id, complaintId: complaint.id, type: "live_view", step: null, summary: "Anchor live view of the filing browser", storageReference: sess.liveViewUrl, mime: "text/html", createdAt: nowIso() });
      }
      await store.saveAttempt(attempt);

      // (e) payload ---------------------------------------------------------------
      const formUrl = cat.officialFormUrl;
      const allowedHosts = allowedHostsFor(category, formUrl, target);
      const payload: FilingPayload = {
        attemptId: attempt.id,
        complaintId: complaint.id,
        approvedVersion: complaint.approvedVersion,
        target,
        category,
        formUrl,
        allowedHosts,
        extraHeaders: {},
        cdpUrl: sess.cdpUrl,
        liveViewUrl: sess.liveViewUrl,
        form: buildForm(complaint, opts.resident, target),
        // The final Submit needs BOTH: operator switch ALLOW_REAL_SUBMIT=1 and approval of this exact version.
        realSubmitAuthorized: realSubmitAuthorizedFor(complaint, target),
        limits: { ...DEFAULT_LIMITS, ...deps.limits },
      };
      const canAsk = Boolean(opts.onQuestion && box.answerQuestion);
      payload.limits.questionTimeoutMs = canAsk ? (deps.limits?.questionTimeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS) : 0;

      // (f) worker -----------------------------------------------------------------
      const said = new Set<string>();
      let run: Awaited<ReturnType<SandboxHandle["runWorker"]>>;
      run = await tracer.span("daytona.run_worker", { "attempt.id": attempt.id, "sandbox.id": box.id, "filing.target": target }, async (set, oi) => {
        oi.tool({ name: "worker.run", description: "Run the bounded Playwright filing worker inside the sandbox", parameters: { category, target, limits: payload.limits } });
        oi.input(redactJson({ ...payload, cdpUrl: payload.cdpUrl ? "[redacted]" : null, form: { ...payload.form, contactName: payload.form.contactName ? "[redacted]" : null, contactEmail: payload.form.contactEmail ? "[redacted]" : null } }));

        // live browser.<step> spans, one per contiguous step
        const stepSpans: Promise<unknown>[] = [];
        let open: { step: WorkerStep; events: WorkerEvent[]; end: () => void } | null = null;
        const openStep = (step: WorkerStep) => {
          let end!: () => void;
          const done = new Promise<void>((r) => (end = r));
          const events: WorkerEvent[] = [];
          stepSpans.push(
            tracer
              .span(`browser.${step}`, { "attempt.id": attempt.id, "worker.step": step }, async (sset, soi) => {
                soi.tool({ name: `browser.${step}`, description: `Worker step: ${step}` });
                await done;
                sset("worker.events", events.length);
                sset("worker.level", events.some((e) => e.level === "error") ? "error" : events.some((e) => e.level === "warn") ? "warn" : "info");
                soi.output(redactJson(events.map((e) => ({ level: e.level, message: e.message, data: e.data }))));
              })
              .catch(() => {}),
          );
          open = { step, events, end };
        };
        // live follow-up questions: worker pauses → resident answers on Telegram → answer file → same page continues
        const questionJobs: Promise<void>[] = [];
        const asked = new Set<string>();
        let workerFinished!: (v: null) => void;
        const workerDone = new Promise<null>((r) => (workerFinished = r));
        const askResident = (q: WorkerQuestion) => {
          const timeoutMs = payload.limits.questionTimeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS;
          progress(WAITING_FOR_ANSWER);
          return tracer
            .span("browser.ask_resident", { "attempt.id": attempt.id, "question.id": q.id, "question.field": q.field, "question.options": q.options?.length ?? 0 }, async (qset, qoi) => {
              qoi.tool({ name: "browser.ask_resident", description: "Pause the filing browser and ask the resident one question on Telegram", parameters: { field: q.field, required: q.required, timeoutMs } });
              // prompt + official option labels only; never the resident's typed answer
              qoi.input({ id: q.id, field: q.field, prompt: q.prompt, options: q.options ?? [], required: q.required });
              const tq = Date.now();
              let answer: WorkerAnswer | null = null;
              let timer: NodeJS.Timeout | undefined;
              try {
                answer = await Promise.race([
                  opts.onQuestion!({ ...q, attemptId: attempt.id, timeoutMs }),
                  new Promise<null>((r) => (timer = setTimeout(() => r(null), timeoutMs))),
                  workerDone,
                ]);
              } catch (err) {
                console.warn("[filing] onQuestion failed:", (err as Error).message);
              } finally {
                clearTimeout(timer);
              }
              const waitedMs = Date.now() - tq;
              qset("question.answered", Boolean(answer));
              qset("question.wait_ms", waitedMs);
              if (answer) {
                await box.answerQuestion!(q.id, answer);
                progress("▶️ Got your answer — continuing in the same browser");
              }
              qoi.output({ answered: Boolean(answer), optionIndex: answer?.optionIndex ?? null, optionLabel: answer?.optionIndex !== undefined ? (q.options?.[answer.optionIndex] ?? null) : null, freeTextChars: answer && answer.optionIndex === undefined ? answer.value.length : null, waitedMs });
              // [memory] episodic: the question + how it was answered (option label / typed length only); never blocks the browser
              if (memory) void memory.remember(liveQuestionItem({ complaint, attemptId: attempt.id, question: q, answer, waitedMs })).catch((e) => console.warn("[filing] memory (question):", (e as Error).message));
            })
            .catch((err) => console.warn("[filing] ask_resident failed:", (err as Error).message));
        };
        const onWorkerEvent = (e: WorkerEvent) => {
          attempt.workerEvents.push(e);
          const q = canAsk ? questionFromEvent(e) : null;
          if (q && !asked.has(q.id)) {
            asked.add(q.id);
            questionJobs.push(askResident(q));
          }
          if (!open || open.step !== e.step) {
            open?.end();
            openStep(e.step);
          }
          open!.events.push(e);
          const text = STEP_PROGRESS[e.step] ?? (e.step === "fill" ? STEP_PROGRESS.inspect : undefined);
          if (text && !said.has(text)) {
            said.add(text);
            progress(text);
          }
        };

        const tw = Date.now();
        const r = await box.runWorker(payload, onWorkerEvent);
        attempt.timing.workerMs = Date.now() - tw;
        workerFinished(null);
        await Promise.all(questionJobs);
        (open as { end: () => void } | null)?.end();
        await Promise.all(stepSpans);
        // the result's own step log is authoritative if streaming missed anything
        if (r.result && r.result.steps.length > attempt.workerEvents.length) attempt.workerEvents = r.result.steps;
        set("worker.exit_code", r.exitCode);
        set("worker.status", r.result?.status ?? "NO_RESULT");
        oi.output(redactJson({ status: r.result?.status ?? null, errorCode: r.result?.errorCode ?? null, submitClicked: r.result?.submitClicked ?? null, evidence: r.result?.evidence.length ?? 0, exitCode: r.exitCode, durationMs: attempt.timing.workerMs }));

        // (g) evidence -------------------------------------------------------------
        const dir = join(RUNS_DIR, attempt.id);
        await mkdir(dir, { recursive: true });
        const files = r.result?.evidence ?? [{ name: "worker.log", type: "log" as const, step: null, summary: "worker log (no result.json)" }];
        for (const f of files) {
          try {
            const buf = await box.downloadEvidence(f.name);
            const localPath = join(dir, f.name.replace(/[^A-Za-z0-9._-]/g, "_"));
            await writeFile(localPath, buf);
            const ev: Evidence = {
              id: shortId("ev"),
              attemptId: attempt.id,
              complaintId: complaint.id,
              type: f.type,
              step: f.step,
              summary: f.summary,
              storageReference: "",
              mime: MIME[extname(f.name).toLowerCase()] ?? "application/octet-stream",
              createdAt: nowIso(),
            };
            const ref = register(ev, localPath);
            ev.storageReference = typeof ref === "string" && ref ? ref : `/api/evidence/${encodeURIComponent(ev.id)}`;
            attempt.evidence.push(ev);
          } catch {
            /* missing evidence is reflected by the verifier, never fatal */
          }
        }
        set("evidence.count", attempt.evidence.length);
        return r;
      });
      result = run.result;
      if (!run.result) {
        // keep a tail of the worker output for debugging (never shown to the user)
        attempt.verificationNotes = `worker exit ${run.exitCode}; no valid result.json. Output tail: ${redactPreview(run.stdout.slice(-600))}`;
      }

      // (h) verification --------------------------------------------------------
      verification = await tracer.span("receipt.verify", { "attempt.id": attempt.id, "filing.target": target }, async (set, oi) => {
        oi.tool({ name: "receipt.verify", description: "Deterministic receipt verification (pattern + confirmation text + confirm evidence)" });
        let v: ReceiptVerification;
        if (run.result) v = verifyReceipt(run.result, target, category);
        else {
          const submitSeen = attempt.workerEvents.some((e) => e.step === "submit" || e.step === "confirm");
          const code: FilingErrorCode = run.exitCode === -1 ? "TIMEOUT" : "WORKER_CRASH";
          v = submitSeen
            ? { status: "SUBMISSION_UNKNOWN", officialRequestNumber: null, errorCode: code, verified: false, notes: `no result.json (exit ${run.exitCode}) after the submit step began ⇒ SUBMISSION_UNKNOWN` }
            : { status: "FAILED", officialRequestNumber: null, errorCode: code, verified: false, notes: `no result.json (exit ${run.exitCode}) before submit ⇒ FAILED` };
        }
        set("receipt.status", v.status);
        set("receipt.verified", v.verified);
        if (v.officialRequestNumber) set("receipt.sr", v.officialRequestNumber);
        oi.output({ ...v, workerStatus: run.result?.status ?? null });
        return v;
      });
      // A real-only dry run (HUMAN_ACTION_REQUIRED, no error code) is complete: close the browser so the recording can be sent.
      const dryRun = verification.status === "HUMAN_ACTION_REQUIRED" && !verification.errorCode && isRealOnly(category);
      holdForHandoff = verification.status === "HUMAN_ACTION_REQUIRED" && Boolean(attempt.liveViewUrl) && !dryRun;
    } catch (err) {
      const code = ((err as { code?: FilingErrorCode }).code ?? "SANDBOX_ERROR") as FilingErrorCode;
      const submitSeen = attempt.workerEvents.some((e) => e.step === "submit" || e.step === "confirm");
      verification = {
        status: submitSeen ? "SUBMISSION_UNKNOWN" : "FAILED",
        officialRequestNumber: null,
        errorCode: submitSeen ? "WORKER_CRASH" : code,
        verified: false,
        notes: `filing error: ${redactPreview((err as Error).message ?? String(err))}`,
      };
    } finally {
      // (j) ALWAYS clean up — except an explicit human handoff with a live view (the Anchor session stays open).
      if (holdForHandoff) {
        // Worker left the official form open in the Anchor browser: the resident finishes there.
        // Destroy the sandbox now; Anchor's idle/max timeouts reap the browser session.
        held = true;
        const h = handle;
        handle = null;
        session = null;
        await h?.destroy().catch(() => {});
        progress("The browser stays open so you can finish the form");
      } else {
        const closed = await cleanup();
        await collectRecording(closed, 1, 6);
      }
    }

    // (i) persist -------------------------------------------------------------------
    const v = verification!;
    const status = v.status;
    const sr = status === "SUBMITTED" && v.verified ? v.officialRequestNumber : null;
    attempt.outcome = status;
    attempt.errorCode = v.errorCode;
    attempt.officialRequestNumber = sr;
    attempt.verified = v.verified;
    attempt.verificationNotes = [v.notes, attempt.verificationNotes].filter(Boolean).join(" | ");
    attempt.finishedAt = nowIso();
    attempt.timing.totalMs = Date.now() - t0;

    await tracer.span("surrealdb.persist", { "attempt.id": attempt.id, "complaint.id": complaint.id, "filing.status": status }, async (set, oi) => {
      oi.tool({ name: "store.persist_filing", description: "Persist attempt, complaint transition, official request, workflow memory", parameters: { backend: store.backend } });
      await store.saveAttempt(attempt);
      persisted = true;
      try {
        current = await transition(store, { ...current, officialRequestNumber: sr }, status, { reason: v.errorCode ?? (status === "SUBMITTED" ? "verified-confirmation" : status === "HUMAN_ACTION_REQUIRED" ? "dry-run: stopped before final submit" : status.toLowerCase()), actor: "system" });
      } catch (err) {
        set("transition.error", (err as Error).message);
      }
      if (sr) {
        await store.saveOfficialRequest({
          id: shortId("sr"),
          complaintId: complaint.id,
          officialRequestNumber: sr,
          officialCategory: cat.officialLabel,
          status: "Open",
          statusSource: "confirmation",
          lastCheckedAt: nowIso(),
          receiptUrl: result?.officialReceiptUrl ? redactPreview(result.officialReceiptUrl) : null,
        });
      }
      const p = patternFor(target, status, v.errorCode, result);
      await store
        .recordWorkflowPattern({ id: shortId("wp"), target, category, kind: p.kind, description: p.description, hint: p.hint, observedInAttemptId: attempt.id, outcome: status, createdAt: nowIso() })
        .catch(() => {});
      // ---- [memory] ask-before-approval: learn which field the form stalled on (services/memory.ts) ----
      const learned: WorkflowPattern[] = [];
      for (const observation of askFromOutcome(status, v.errorCode, result)) {
        const lp = await recordAskPattern(store, { target, category, observation, attemptId: attempt.id, outcome: status }).catch((e) => void console.warn("[filing] recordAskPattern:", (e as Error).message));
        if (lp) learned.push(lp);
      }
      // agent memory: the outcome (episodic) + learned ask-before-approval rules (procedural).
      // Fire-and-forget like the other write points: embedding can take up to its 20 s timeout and must
      // never delay the outcome message (memory.flush() drains these in tests / scripts).
      if (memory) {
        const dryRun = status === "HUMAN_ACTION_REQUIRED" && !v.errorCode && isRealOnly(category);
        void memory.remember(filingOutcomeItem({ complaint: current, attempt, status, errorCode: v.errorCode, officialRequestNumber: sr, dryRun })).catch((e) => console.warn("[filing] memory (outcome):", (e as Error).message));
        for (const lp of learned) void memory.remember(askPatternItem(lp)).catch((e) => console.warn("[filing] memory (pattern):", (e as Error).message));
        set("memory.writes", 1 + learned.length);
      }
      // ---- [/memory] ----
      oi.output({ attemptId: attempt.id, status, sr, pattern: p.kind, evidence: attempt.evidence.length, timing: attempt.timing });
    });

    const confirmShot = [...attempt.evidence].reverse().find((e) => e.type === "screenshot" && e.step === "confirm") ?? [...attempt.evidence].reverse().find((e) => e.type === "screenshot");
    const outcome: FilingOutcome = {
      complaintId: complaint.id,
      attemptId: attempt.id,
      status,
      message: messageFor(status, sr, v.errorCode, held ? attempt.liveViewUrl : null, result && result.status === status ? (result.message ?? null) : null, category),
    };
    if (sr) outcome.officialRequestNumber = sr;
    if (sr && result?.officialReceiptUrl) outcome.officialReceiptUrl = redactPreview(result.officialReceiptUrl);
    if (confirmShot) outcome.evidenceReference = confirmShot.storageReference;
    if (v.errorCode) outcome.errorCode = v.errorCode;
    return outcome;
  }

  return {
    executeFiling,
    async drain() {
      while (background.size) await Promise.all([...background]);
    },
  };
}
