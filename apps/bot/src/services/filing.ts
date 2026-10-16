/**
 * Filing service (design doc §6.6–6.7, §9.2–9.4, §10, §15.2, §18.4, §19).
 *
 * executeFiling(approved complaint):
 *   guard (APPROVED + approvedVersion === draftVersion; never re-run after SUBMISSION_UNKNOWN)
 *   → FilingAttempt + complaint → FILING
 *   → Anchor session ‖ Daytona sandbox (worker + demo portal)
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
  WorkerEvent,
  WorkerResult,
} from "../core/contracts.js";
import { CATEGORIES, nowIso, shortId } from "../core/contracts.js";
import { transition } from "../core/state-machine.js";
import { RUNS_DIR, filingTarget } from "../integrations/env.js";
import { registerEvidenceFile } from "./evidence-registry.js";
import { verifyReceipt, type ReceiptVerification } from "./receipts.js";

type WorkerStep = WorkerEvent["step"];

export type FilingServiceDeps = {
  store: Store;
  tracer: Tracer;
  /** Either naming is accepted (integrations/index.ts passes `sandbox` / `browser`). */
  sandboxProvider?: SandboxProvider | null;
  sandbox?: SandboxProvider | null;
  browserProvider?: BrowserProvider | null;
  browser?: BrowserProvider | null;
  evidenceRegistry?: { registerEvidenceFile(evidence: Evidence, localPath: string): string | void };
  /** Defaults to env FILING_TARGET (demo). */
  target?: FilingTarget;
  limits?: Partial<FilingPayload["limits"]>;
  /**
   * Demo target only: how long to keep the browser + sandbox (which hosts the replica page) alive
   * after HUMAN_ACTION_REQUIRED with a live view. Default env FILING_HANDOFF_HOLD_MS, else 3 min;
   * 0 disables. Real target: the sandbox is destroyed immediately and the Anchor session is left
   * open for the resident (reaped by Anchor's idle 5 min / max 15 min timeouts).
   */
  handoffHoldMs?: number;
};

export type FilingService = {
  executeFiling(complaint: ComplaintDraft, opts: { resident: Resident; onProgress: (text: string) => void }): Promise<FilingOutcome>;
  /** Resolves when deferred cleanups + background recording lookups are done (scripts/tests). */
  drain(): Promise<void>;
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
  notApproved: () => "This report isn't approved in its current version, so I didn't file anything. Please review and approve the latest draft.",
};

function messageFor(status: FilingStatus, sr: string | null, code: FilingErrorCode | null, liveViewUrl: string | null, workerMessage: string | null): string {
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

/** Hide the signed part of Daytona preview hostnames (`3311-<signed>.<domain>`) in exported traces. */
export function redactPreview(s: string): string {
  return s.replace(/\b(\d{2,5})-[a-z0-9-]{8,}\.([a-z0-9.-]+)/gi, "$1-***.$2");
}
const redactJson = (v: unknown) => JSON.parse(redactPreview(JSON.stringify(v ?? null)));

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".html": "text/html", ".log": "text/plain", ".txt": "text/plain", ".json": "application/json" };

function todayNyc(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function patternFor(target: FilingTarget, status: FilingStatus, code: FilingErrorCode | null, result: WorkerResult | null): { kind: string; description: string; hint: Record<string, unknown> } {
  if (status === "SUBMITTED")
    return {
      kind: "confirmation-parsed",
      description: "Confirmation page exposed a parseable service request number.",
      hint: { finalUrlPath: result?.finalUrl ? new URL(result.finalUrl).pathname.replace(/[A-Z0-9-]{10,}$/, ":sr") : null },
    };
  switch (code) {
    case "CAPTCHA":
      return { kind: "captcha-on-step1", description: `${target === "real" ? "Official DOT form" : "Demo portal (captcha mode)"} shows a CAPTCHA before step 1 can be submitted; hand off to a human.`, hint: { handoff: "live_view", detectBeforeClick: true } };
    case "CONNECTION_LOST_AFTER_SUBMIT":
      return { kind: "flaky-submit", description: "Connection dropped after submit; outcome unknown. Never auto-retry; ask the resident to check the portal.", hint: { autoRetry: false } };
    case "FORM_REJECTED":
      return { kind: "form-rejected-location", description: "Portal rejected the submitted location text.", hint: { checkCrossStreets: true } };
    default:
      return { kind: `outcome-${(code ?? status).toLowerCase().replace(/_/g, "-")}`, description: `Attempt ended ${status}${code ? `/${code}` : ""}.`, hint: {} };
  }
}

export function createFilingService(deps: FilingServiceDeps): FilingService {
  const { store, tracer } = deps;
  const sandboxProvider = deps.sandboxProvider ?? deps.sandbox ?? null;
  const browserProvider = deps.browserProvider ?? deps.browser ?? null;
  const register = deps.evidenceRegistry?.registerEvidenceFile ?? registerEvidenceFile;
  const background = new Set<Promise<unknown>>();
  const track = (p: Promise<unknown>) => {
    const q = p.catch(() => {}).finally(() => background.delete(q));
    background.add(q);
  };

  async function executeFiling(complaint: ComplaintDraft, opts: { resident: Resident; onProgress: (text: string) => void }): Promise<FilingOutcome> {
    const t0 = Date.now();
    const target = deps.target ?? filingTarget();
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
    const collectRecording = async (s: BrowserSessionInfo | null, inlineTries: number, backgroundTries: number) => {
      if (!s || s.provider === "local") return;
      const addRecording = async (url: string) => {
        const ev: Evidence = { id: shortId("ev"), attemptId: attempt.id, complaintId: complaint.id, type: "recording", step: null, summary: "Anchor session recording", storageReference: url, mime: "video/mp4", createdAt: nowIso() };
        attempt.recordingUrl = url;
        attempt.evidence.push(ev);
        if (persisted) {
          const latest = (await store.getAttempt(attempt.id)) ?? attempt;
          await store.saveAttempt({ ...latest, recordingUrl: url, evidence: [...latest.evidence.filter((e) => e.type !== "recording"), ev] });
        }
      };
      for (let i = 0; i < inlineTries; i++) {
        const url = await s.getRecordingUrl().catch(() => null);
        if (url) return addRecording(url);
      }
      if (backgroundTries <= 0) return;
      track(
        (async () => {
          for (let i = 0; i < backgroundTries; i++) {
            await new Promise((r) => setTimeout(r, 10_000));
            const url = await s.getRecordingUrl().catch(() => null);
            if (url) return addRecording(url);
          }
        })(),
      );
    };

    try {
      if (!sandboxProvider) throw Object.assign(new Error("no sandbox provider configured"), { code: "SANDBOX_ERROR" as FilingErrorCode });
      if (!browserProvider) throw Object.assign(new Error("no browser provider configured"), { code: "BROWSER_ERROR" as FilingErrorCode });

      // (c) browser ‖ (d) sandbox --------------------------------------------
      progress("Preparing an isolated filing worker…");
      const portalMode = opts.resident.demoPortalMode ?? "normal";
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
        tracer.span("daytona.create_worker", { "attempt.id": attempt.id, "sandbox.provider": sandboxProvider.name, "filing.target": target, "portal.mode": portalMode }, async (set, oi) => {
          oi.tool({ name: "daytona.create_worker", description: "Disposable sandbox: upload worker (+ demo portal), install playwright-core, start portal", parameters: { target, portalMode } });
          const ts = Date.now();
          const h = await sandboxProvider.provision({ attemptId: attempt.id, target, portalMode, onEvent: onProviderEvent });
          attempt.timing.sandboxMs = Date.now() - ts;
          set("sandbox.id", h.id);
          oi.output({ sandboxId: h.id, provider: h.provider, portal: Boolean(h.portalUrl), durationMs: attempt.timing.sandboxMs, stages: providerLog.map((l) => l.msg) });
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
      if (target === "demo" && !box.portalUrl) throw Object.assign(new Error("demo portal URL missing"), { code: "SANDBOX_ERROR" as FilingErrorCode });
      const formUrl = target === "demo" ? `${box.portalUrl}/report/${cat.demoRoute}` : cat.officialFormUrl;
      const allowedHosts = [...new Set([new URL(formUrl).hostname, ...(target === "real" ? ["a841-dotvweb01.nyc.gov"] : [])])];
      const payload: FilingPayload = {
        attemptId: attempt.id,
        complaintId: complaint.id,
        approvedVersion: complaint.approvedVersion,
        target,
        category,
        formUrl,
        allowedHosts,
        extraHeaders: box.portalHeaders,
        cdpUrl: sess.cdpUrl,
        liveViewUrl: sess.liveViewUrl,
        portalMode,
        form: {
          // the worker picks the restoration type from the description (trench / cut / patch / repair)
          description: category === "street-repair-defect" && !/trench|cut|patch|repair/i.test(complaint.description) ? `${complaint.description} (repaired patch)` : complaint.description,
          address: complaint.location.address,
          borough: complaint.location.borough,
          latitude: complaint.location.latitude,
          longitude: complaint.location.longitude,
          // Real target: only ever user-provided. Demo replica: documented placeholder is acceptable.
          contactName: opts.resident.contactName ?? (target === "demo" ? "Relay Resident" : null),
          contactEmail: opts.resident.contactEmail ?? null,
          contactPhone: null,
          dateObserved: todayNyc(),
        },
        limits: { ...DEFAULT_LIMITS, ...deps.limits },
      };

      // (f) worker -----------------------------------------------------------------
      const said = new Set<string>();
      let run: Awaited<ReturnType<SandboxHandle["runWorker"]>>;
      run = await tracer.span("daytona.run_worker", { "attempt.id": attempt.id, "sandbox.id": box.id, "filing.target": target }, async (set, oi) => {
        oi.tool({ name: "worker.run", description: "Run the bounded Playwright filing worker inside the sandbox", parameters: { category, target, portalMode, limits: payload.limits } });
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
        const onWorkerEvent = (e: WorkerEvent) => {
          attempt.workerEvents.push(e);
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
        if (run.result) v = verifyReceipt(run.result, target);
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
      holdForHandoff = verification.status === "HUMAN_ACTION_REQUIRED" && Boolean(attempt.liveViewUrl);
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
      // (j) ALWAYS clean up — except an explicit human handoff with a live view, which is deferred.
      const holdMs = deps.handoffHoldMs ?? (process.env.FILING_HANDOFF_HOLD_MS ? Number(process.env.FILING_HANDOFF_HOLD_MS) : 3 * 60_000);
      if (holdForHandoff && target === "real") {
        // Worker left the official form open in the Anchor browser: the resident finishes there.
        // Destroy the sandbox now; Anchor's idle/max timeouts reap the browser session.
        held = true;
        const h = handle;
        handle = null;
        session = null;
        await h?.destroy().catch(() => {});
        progress("The browser stays open so you can finish the form");
      } else if (holdForHandoff && holdMs > 0) {
        // Demo: the replica page lives in the sandbox, so keep both briefly for the live view.
        held = true;
        const s = session;
        const h = handle;
        session = null;
        handle = null;
        progress(`Keeping the browser open for ${holdMs >= 60_000 ? `${Math.round(holdMs / 60_000)} min` : `${Math.round(holdMs / 1000)} s`} so you can finish`);
        track(
          new Promise<void>((resolve) =>
            setTimeout(async () => {
              await Promise.all([h?.destroy().catch(() => {}), s?.close().catch(() => {})]);
              await collectRecording(s, 1, 6);
              resolve();
            }, holdMs),
          ),
        );
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
        current = await transition(store, { ...current, officialRequestNumber: sr }, status, { reason: v.errorCode ?? "verified-confirmation", actor: "system" });
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
          statusSource: target === "demo" ? "demo-portal" : "confirmation",
          lastCheckedAt: nowIso(),
          receiptUrl: result?.officialReceiptUrl ? redactPreview(result.officialReceiptUrl) : null,
        });
      }
      const p = patternFor(target, status, v.errorCode, result);
      await store
        .recordWorkflowPattern({ id: shortId("wp"), target, category, kind: p.kind, description: p.description, hint: p.hint, observedInAttemptId: attempt.id, outcome: status, createdAt: nowIso() })
        .catch(() => {});
      oi.output({ attemptId: attempt.id, status, sr, pattern: p.kind, evidence: attempt.evidence.length, timing: attempt.timing });
    });

    const confirmShot = [...attempt.evidence].reverse().find((e) => e.type === "screenshot" && e.step === "confirm") ?? [...attempt.evidence].reverse().find((e) => e.type === "screenshot");
    const outcome: FilingOutcome = {
      complaintId: complaint.id,
      attemptId: attempt.id,
      status,
      message: messageFor(status, sr, v.errorCode, held ? attempt.liveViewUrl : null, result && result.status === status ? (result.message ?? null) : null),
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
