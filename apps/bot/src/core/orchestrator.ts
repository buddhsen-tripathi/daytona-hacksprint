/**
 * Conversation orchestrator (ARCHITECTURE.md "Flow" 1-10).
 *
 * The LLM classifies within bounds; this file decides what happens next and
 * every status change goes through state-machine.ts. Approval is a user
 * action bound to an exact draftVersion. Filing outcomes are rendered from
 * the FilingOutcome only; request numbers are never synthesized here.
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type {
  Classifier,
  ClassificationResult,
  ComplaintDraft,
  ComplaintLocation,
  DuplicateService,
  FilingOutcome,
  FilingTarget,
  InboundEvent,
  LocationService,
  MediaItem,
  OfficialRequest,
  OutboundMessage,
  PortalMode,
  Resident,
  Store,
  Tracer,
  Transport,
} from "./contracts.js";
import { PortalMode as PortalModeSchema, decodeCallback, nowIso, shortId } from "./contracts.js";
import { NYC311_CHECK_STATUS_URL, NYC311_REPORT_URL, getCategory } from "./knowledge.js";
import { canTransition, transition } from "./state-machine.js";
import { OPEN_STATES, createComplaintService } from "../services/complaints.js";
import { M, esc } from "../telegram/messages.js";
import { approvalButtons, duplicateButtons, isButtonSafeUrl, linkButton, trackingButtons } from "../telegram/keyboards.js";
import type { FilingService, StatusService } from "../integrations/fallbacks.js";
import { RUNS_DIR } from "../integrations/env.js";
import { resolveEvidencePath } from "../services/evidence-registry.js";

export type { FilingService, StatusService } from "../integrations/fallbacks.js";

export type OrchestratorDeps = {
  store: Store;
  tracer: Tracer;
  classifier: Classifier;
  location: LocationService;
  duplicates: DuplicateService;
  filing: FilingService;
  status?: StatusService;
  transport: Transport;
  /** Defaults to "demo". */
  target?: FilingTarget;
  /** Where Telegram media is downloaded (default .runs/media). */
  mediaDir?: string;
  /** Max approvals per chat per hour (design doc §18.5). */
  maxFilingsPerHour?: number;
};

export type HandleOptions = {
  /** Override the transport for this event (API demo endpoint). */
  transport?: Transport;
  /** Await the filing job before resolving (scripts/tests). Default false: filing runs in the background. */
  waitForFiling?: boolean;
};

type Ctx = { chatId: string; t: Transport; resident: Resident; opts: HandleOptions };

const ADDRESS_HINT =
  /(\b\d+[a-z]?\s+[\w.'-]+(\s[\w.'-]+)?\s+(st|street|ave|avenue|av|blvd|boulevard|rd|road|pl|place|dr|drive|ln|lane|pkwy|parkway|ter|terrace|ct|court|way|hwy|broadway)\b)|(\s(&|and|at)\s.*\b(st|street|ave|avenue|blvd|rd|pl|broadway)\b)|\b(corner of|intersection|cross street)\b|\b(manhattan|brooklyn|bronx|queens|staten island)\b|\b(st|street|ave|avenue|blvd|broadway)\b.*\b(&|and|at)\b|\b\d{5}\b/i;

export function looksLikeAddress(text: string): boolean {
  return ADDRESS_HINT.test(text);
}

export function createOrchestrator(deps: OrchestratorDeps) {
  const { store, tracer, classifier, location, duplicates, filing } = deps;
  const target: FilingTarget = deps.target ?? "demo";
  const mediaRoot = deps.mediaDir ?? resolve(RUNS_DIR, "media");
  const maxPerHour = deps.maxFilingsPerHour ?? 6;
  const complaints = createComplaintService(store);
  const chains = new Map<string, Promise<void>>();
  const filingJobs = new Map<string, Promise<void>>();
  const approvalsLog = new Map<string, number[]>();

  // ---------------------------------------------------------------- helpers
  async function send(ctx: Ctx, msg: Omit<OutboundMessage, "chatId">) {
    return tracer.span("telegram.respond", { "message.length": msg.text.length, "message.buttons": msg.buttons?.flat().length ?? 0 }, async (set) => {
      const res = await ctx.t.send({ parseMode: "HTML", ...msg, chatId: ctx.chatId });
      set("message.id", res.messageId ?? -1);
      return res;
    });
  }

  function typing(ctx: Ctx) {
    void ctx.t.typing?.(ctx.chatId).catch(() => {});
  }

  async function activeDraft(chatId: string): Promise<ComplaintDraft | null> {
    const c = await store.getActiveComplaint(chatId);
    return c && OPEN_STATES.includes(c.status) ? c : null;
  }

  async function openOrNewDraft(ctx: Ctx): Promise<ComplaintDraft> {
    const existing = await activeDraft(ctx.chatId);
    if (existing) return existing;
    const d = await complaints.newDraft(ctx.chatId, ctx.resident.id);
    const traceId = tracer.currentTraceId();
    return traceId ? store.saveComplaint({ ...d, traceId }) : d;
  }

  function reviewUrl(): string {
    return NYC311_CHECK_STATUS_URL;
  }

  function finishUrl(d: ComplaintDraft, o: FilingOutcome): string {
    if (isButtonSafeUrl(o.officialReceiptUrl)) return o.officialReceiptUrl!;
    if (target === "real") return getCategory(d.category)?.officialFormUrl ?? NYC311_REPORT_URL;
    return NYC311_REPORT_URL;
  }

  function needsName(resident: Resident) {
    return target === "real" && !resident.contactName;
  }

  // ------------------------------------------------------------ the pipeline
  /** After any update to an open draft: decide the next state and message. */
  async function advance(ctx: Ctx, draft: ComplaintDraft, prefix: string[] = []): Promise<ComplaintDraft> {
    draft = complaints.computeMissing(draft);
    if (draft.status !== "TRIAGING") draft = await complaints.enterTriage(draft, "re-evaluate draft");
    else draft = await store.saveComplaint(draft);

    if (draft.missingFields.includes("category") || draft.missingFields.includes("description")) {
      draft = await complaints.moveTo(draft, "NEEDS_INFORMATION", `missing: ${draft.missingFields.join(",")}`);
      const q = draft.classification?.clarifyingQuestion ?? null;
      await send(ctx, { text: [...prefix, draft.missingFields.includes("category") ? M.clarify(q) : M.needDescription()].join("\n\n") });
      return draft;
    }
    if (draft.missingFields.includes("location")) {
      draft = await complaints.moveTo(draft, "NEEDS_INFORMATION", "missing: location");
      await send(ctx, { text: [...prefix, M.askLocation()].join("\n\n"), requestLocation: true });
      return draft;
    }

    // Complete → duplicate check (once per location/category).
    const notes: string[] = [...prefix];
    if (!draft.duplicateReviewed && draft.category && draft.location.latitude != null && draft.location.longitude != null) {
      const lat = draft.location.latitude;
      const lon = draft.location.longitude;
      const category = draft.category;
      let found: Awaited<ReturnType<DuplicateService["findPotentialDuplicates"]>> | null = null;
      try {
        found = await tracer.span("nyc311.search_duplicates", { category, "geo.radius_m": 50 }, async (set, oi) => {
          oi.input({ category, lat: Number(lat.toFixed(4)), lon: Number(lon.toFixed(4)) });
          const r = await duplicates.findPotentialDuplicates({ category, latitude: lat, longitude: lon });
          set("duplicates.count", r.candidates.length);
          set("duplicates.source", r.source);
          oi.retriever(r.candidates.map((c) => ({ id: c.uniqueKey, content: `${c.complaintType} / ${c.descriptor ?? ""} / ${c.status ?? ""}`, score: c.matchScore })));
          return r;
        });
      } catch (err) {
        console.warn("[orchestrator] duplicate search failed:", (err as Error).message);
      }
      if (!found || found.source === "unavailable") {
        notes.push(M.openDataDown());
        draft = { ...draft, duplicateReviewed: true, duplicates: [], duplicatesDataAsOf: null };
      } else if (found.candidates.length > 0) {
        draft = { ...draft, duplicates: found.candidates, duplicatesDataAsOf: found.dataAsOf };
        await store.linkDuplicates(draft.id, found.candidates).catch((e) => console.warn("[orchestrator] linkDuplicates:", e.message));
        draft = await complaints.moveTo(draft, "DUPLICATE_REVIEW", `${found.candidates.length} potential duplicate(s)`);
        const label = getCategory(draft.category)?.label ?? "street";
        const text = [...notes, M.duplicate(found.candidates, found.dataAsOf, label)].join("\n\n");
        await send(ctx, { text, buttons: duplicateButtons(draft, reviewUrl()) });
        return draft;
      } else {
        draft = { ...draft, duplicateReviewed: true, duplicates: [], duplicatesDataAsOf: found.dataAsOf };
      }
    }
    return presentDraft(ctx, draft, notes);
  }

  async function presentDraft(ctx: Ctx, draft: ComplaintDraft, notes: string[] = [], actor: "system" | "user" = "system"): Promise<ComplaintDraft> {
    if (draft.status !== "READY_FOR_APPROVAL") draft = await complaints.moveTo(draft, "READY_FOR_APPROVAL", "draft complete", actor);
    const summary = await tracer.span("draft.generate", { "complaint.id": draft.id, "draft.version": draft.draftVersion }, async (_set, oi) => {
      const s = complaints.buildSummary(draft, { contactName: target === "real" ? ctx.resident.contactName : null, target });
      oi.output({ category: draft.category, version: draft.draftVersion, photos: draft.media.length });
      return s;
    });
    const parts = [...notes, summary];
    const blocked = needsName(ctx.resident);
    if (blocked) parts.push(M.needName());
    await send(ctx, { text: parts.join("\n\n"), buttons: approvalButtons(draft, { canApprove: !blocked }) });
    return draft;
  }

  async function classifyAndAdvance(ctx: Ctx, draft: ComplaintDraft, input: { text: string | null; imagePaths: string[] }, prefix: string[] = []) {
    draft = await complaints.enterTriage(draft, "new input");
    typing(ctx);
    let result: ClassificationResult | null = null;
    try {
      const r = await tracer.span("routing.classify", { "input.has_image": input.imagePaths.length > 0, "input.text_length": input.text?.length ?? 0 }, async (set, oi) => {
        const out = await classifier.classify({
          text: input.text,
          imagePaths: input.imagePaths,
          priorDescription: draft.description || null,
          locationKnown: !draft.missingFields.includes("location") || draft.location.userConfirmed,
          conversation: draft.userMessages,
        });
        set("classification.triage", out.result.triage);
        set("classification.category", out.result.category ?? "none");
        set("classification.confidence", out.result.confidence);
        set("llm.model_name", out.model);
        oi.output(out.result);
        return out;
      });
      result = r.result;
    } catch (err) {
      console.warn("[orchestrator] classify failed:", (err as Error).message);
    }

    if (!result) {
      if (draft.category) return advance(ctx, draft, prefix);
      draft = await complaints.moveTo(draft, "NEEDS_INFORMATION", "classifier unavailable");
      await send(ctx, { text: [...prefix, input.imagePaths.length ? M.invalidImage() : M.clarify(null)].join("\n\n") });
      return draft;
    }

    const hadCategory = draft.category;
    const applied = complaints.applyClassification(draft, result);
    draft = applied.draft;
    switch (applied.decision.kind) {
      case "EMERGENCY": {
        draft = await transition(store, draft, "EMERGENCY_REFERRAL", { reason: `safety: ${result.safetyFlags.join(", ") || "danger"}`, actor: "llm" });
        tracer.evaluate("emergency_referral", { label: "referred", explanation: result.rationale });
        await send(ctx, { text: M.emergency() });
        return draft;
      }
      case "OUT_OF_SCOPE": {
        draft = await transition(store, draft, "OUT_OF_SCOPE", { reason: "unsupported category", actor: "llm" });
        await send(ctx, { text: M.outOfScope("OUT_OF_SCOPE", result.description), buttons: linkButton("Report on NYC311", NYC311_REPORT_URL) });
        return draft;
      }
      case "CLARIFY": {
        draft = await complaints.moveTo(draft, "NEEDS_INFORMATION", "low confidence / unclear");
        await send(ctx, { text: [...prefix, M.clarify(applied.decision.question)].join("\n\n") });
        return draft;
      }
      case "CONTINUE": {
        const label = getCategory(draft.category)?.label;
        const pre = [...prefix];
        if (label && hadCategory !== draft.category) pre.push(M.classified(label));
        else if (hadCategory && input.text) pre.push(M.noted());
        return advance(ctx, draft, pre);
      }
    }
  }

  function photoPaths(d: ComplaintDraft) {
    return d.media.filter((m) => m.type === "photo" && m.localPath).map((m) => m.localPath!).slice(-3);
  }

  // --------------------------------------------------------------- handlers
  async function onPhoto(ctx: Ctx, ev: Extract<InboundEvent, { kind: "photo" }>) {
    let draft = await openOrNewDraft(ctx);
    const media = await tracer.span("intake.extract", { "input.kind": "photo", "input.has_caption": !!ev.caption }, async (set) => {
      const dir = resolve(mediaRoot, ctx.chatId);
      mkdirSync(dir, { recursive: true });
      try {
        const file = await ctx.t.downloadFile(ev.fileId, dir);
        set("media.downloaded", true);
        const item: MediaItem = { id: shortId("med"), type: "photo", telegramFileId: ev.fileId, localPath: file.path, mime: file.mime, createdAt: nowIso() };
        return item;
      } catch (err) {
        set("media.downloaded", false);
        console.warn("[orchestrator] photo download failed:", (err as Error).message);
        return null;
      }
    });
    if (media) draft = { ...draft, media: [...draft.media, media] };
    if (ev.caption?.trim()) draft = { ...draft, userMessages: [...draft.userMessages, ev.caption.trim()] };
    draft = await store.saveComplaint(draft);
    if (!media && !ev.caption) {
      await send(ctx, { text: M.invalidImage() });
      return;
    }
    await send(ctx, { text: M.analyzing() });
    await classifyAndAdvance(ctx, draft, { text: ev.caption ?? null, imagePaths: photoPaths(draft) });
  }

  async function applyLocation(ctx: Ctx, draft: ComplaintDraft, loc: ComplaintLocation) {
    if (loc.withinNyc === false) {
      if (draft.status !== "NEEDS_INFORMATION") draft = await complaints.enterTriage(draft, "location outside NYC");
      draft = await complaints.moveTo(draft, "NEEDS_INFORMATION", "location outside NYC");
      await send(ctx, { text: M.outsideNyc(), requestLocation: true });
      return draft;
    }
    draft = complaints.setLocation(draft, { ...loc, userConfirmed: true });
    await store.upsertLocation(draft.location).catch(() => null);
    draft = await store.saveComplaint(draft);
    if (!draft.description && !draft.media.length) {
      draft = await complaints.enterTriage(draft, "location before description");
      draft = await complaints.moveTo(draft, "NEEDS_INFORMATION", "missing description");
      await send(ctx, { text: `Got the location. 📍\n\n${M.needDescription()}` });
      return draft;
    }
    return advance(ctx, draft, [M.locationGot()]);
  }

  async function onLocation(ctx: Ctx, ev: Extract<InboundEvent, { kind: "location" }>) {
    const draft = await openOrNewDraft(ctx);
    const loc = await tracer.span("location.validate", { "location.source": "pin" }, async (set) => {
      const l = await location.fromPin(ev.latitude, ev.longitude);
      set("location.within_nyc", l.withinNyc ?? false);
      set("location.has_address", !!l.address);
      return l;
    });
    await applyLocation(ctx, draft, loc);
  }

  async function onText(ctx: Ctx, text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    let draft = await openOrNewDraft(ctx);
    const lacksLocation = !draft.location.userConfirmed || draft.location.withinNyc === false || draft.statusReason === "user requested edit";
    if (lacksLocation && looksLikeAddress(trimmed)) {
      const loc = await tracer.span("location.validate", { "location.source": "text" }, async (set) => {
        const l = await location.fromText(trimmed).catch(() => null);
        set("location.resolved", !!l);
        if (l) set("location.within_nyc", l.withinNyc ?? false);
        return l;
      });
      if (loc) {
        await applyLocation(ctx, draft, { ...loc, rawInput: loc.rawInput ?? trimmed, source: "text" });
        return;
      }
    }
    draft = await tracer.span("intake.extract", { "input.kind": "text", "input.length": trimmed.length }, async () =>
      store.saveComplaint({ ...draft, userMessages: [...draft.userMessages, trimmed] }),
    );
    await classifyAndAdvance(ctx, draft, { text: trimmed, imagePaths: photoPaths(draft) });
  }

  async function onVoice(ctx: Ctx, ev: Extract<InboundEvent, { kind: "voice" }>) {
    if (!classifier.transcribe) {
      await send(ctx, { text: M.voiceUnsupported() });
      return;
    }
    const transcript = await tracer.span("intake.extract", { "input.kind": "voice" }, async () => {
      const dir = resolve(mediaRoot, ctx.chatId);
      mkdirSync(dir, { recursive: true });
      const f = await ctx.t.downloadFile(ev.fileId, dir);
      return classifier.transcribe!(f.path);
    }).catch((err) => {
      console.warn("[orchestrator] transcription failed:", (err as Error).message);
      return null;
    });
    if (!transcript) {
      await send(ctx, { text: M.voiceUnsupported() });
      return;
    }
    await send(ctx, { text: `🎙️ I heard: “${transcript.replace(/[<>&]/g, "")}”` });
    await onText(ctx, transcript);
  }

  // ---------------------------------------------------------------- commands
  async function onCommand(ctx: Ctx, command: string, args: string) {
    switch (command.toLowerCase()) {
      case "start":
        await send(ctx, { text: M.start() });
        return;
      case "help":
        await send(ctx, { text: M.help() });
        return;
      case "report": {
        const d = await activeDraft(ctx.chatId);
        if (d) await complaints.cancel(d, "user").catch(() => null);
        await send(ctx, { text: M.reportPrompt() });
        return;
      }
      case "cancel": {
        const d = await store.getActiveComplaint(ctx.chatId);
        if (!d || !canTransition(d.status, "CANCELLED")) {
          await send(ctx, { text: d?.status === "FILING" ? "Filing is in progress, so I can't cancel it right now. I'll report back shortly." : M.nothingToCancel() });
          return;
        }
        await complaints.cancel(d, "user");
        await send(ctx, { text: M.cancelled() });
        return;
      }
      case "myreports": {
        const [list, reqs] = await tracer.span("surrealdb.read_context", { "query.kind": "myreports" }, async () =>
          Promise.all([store.listComplaints({ chatId: ctx.chatId, limit: 20 }), store.listOfficialRequests(ctx.chatId)]),
        );
        const visible = list.filter((c) => c.status !== "CANCELLED" || c.officialRequestNumber);
        await send(ctx, { text: M.myReports(visible, reqs) });
        return;
      }
      case "status": {
        let sr = args.trim().split(/\s+/)[0] ?? "";
        if (!sr) {
          const list = await store.listComplaints({ chatId: ctx.chatId, limit: 20 });
          sr = list.find((c) => c.officialRequestNumber)?.officialRequestNumber ?? "";
        }
        if (!sr) {
          await send(ctx, { text: M.statusUsage() });
          return;
        }
        await replyStatus(ctx, sr);
        return;
      }
      case "mode": {
        const parsed = PortalModeSchema.safeParse(args.trim().toLowerCase());
        if (!parsed.success) {
          await send(ctx, { text: `${M.modeUsage()}\nCurrent: <b>${ctx.resident.demoPortalMode}</b>` });
          return;
        }
        ctx.resident = await store.updateResident(ctx.resident.id, { demoPortalMode: parsed.data as PortalMode });
        await send(ctx, { text: M.modeSet(parsed.data) });
        return;
      }
      case "name": {
        const name = args.trim().replace(/\s+/g, " ");
        if (name.split(" ").length < 2 || name.length > 80) {
          await send(ctx, { text: "Please send your first and last name, like <code>/name Jane Doe</code>." });
          return;
        }
        ctx.resident = await store.updateResident(ctx.resident.id, { contactName: name });
        await send(ctx, { text: M.nameSaved(name) });
        const d = await activeDraft(ctx.chatId);
        if (d?.status === "READY_FOR_APPROVAL") await presentDraft(ctx, d);
        return;
      }
      default:
        await send(ctx, { text: M.help() });
    }
  }

  async function replyStatus(ctx: Ctx, sr: string) {
    if (/^DEMO-/i.test(sr)) {
      // The demo portal lived in a sandbox that is destroyed after filing: answer from the recorded OfficialRequest.
      const reqs = await tracer.span("surrealdb.read_context", { "query.kind": "official_request" }, async () => store.listOfficialRequests(ctx.chatId));
      const r = reqs.find((x) => x.officialRequestNumber.toUpperCase() === sr.toUpperCase());
      const c = r ? await store.getComplaint(r.complaintId) : null;
      await send(ctx, {
        text: r
          ? M.status(sr, {
              found: true,
              status: r.status ?? "Open",
              detail: `${r.officialCategory}, filed ${new Date(c?.createdAt ?? r.lastCheckedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" })}. This is the status recorded at filing time (demo portal).`,
              source: "demo-portal",
            })
          : M.status(sr, { found: false, status: null }),
      });
      return;
    }
    const res = await tracer.span("nyc311.status_lookup", { "sr.is_demo": /^DEMO-/i.test(sr) }, async (set) => {
      if (!deps.status) return null;
      const r = await deps.status.lookup(sr, { target: /^DEMO-/i.test(sr) ? "demo" : target }).catch((err) => {
        console.warn("[orchestrator] status lookup failed:", (err as Error).message);
        return null;
      });
      set("status.found", !!r?.found);
      return r;
    });
    const norm = normalizeStatus(res);
    await send(ctx, { text: M.status(sr, norm) });
    if (norm.found && norm.status) {
      const list = await store.listComplaints({ chatId: ctx.chatId, limit: 50 });
      const c = list.find((x) => x.officialRequestNumber === sr);
      if (c) {
        const reqs = await store.listOfficialRequests(ctx.chatId);
        const existing = reqs.find((r) => r.officialRequestNumber === sr);
        if (existing) await store.saveOfficialRequest({ ...existing, status: norm.status, lastCheckedAt: nowIso() }).catch(() => null);
      }
    }
  }

  // --------------------------------------------------------------- callbacks
  async function onCallback(ctx: Ctx, ev: Extract<InboundEvent, { kind: "callback" }>) {
    const cb = decodeCallback(ev.data);
    if (!cb) return;
    let draft = await tracer.span("surrealdb.read_context", { "query.kind": "complaint" }, async () => store.getComplaint(cb.complaintId));
    if (!draft || draft.telegramChatId !== ctx.chatId) {
      await send(ctx, { text: "I couldn't find that report anymore. Send a photo or description to start a new one." });
      return;
    }
    switch (cb.action) {
      case "approve":
        return onApprove(ctx, draft, cb.version);
      case "edit": {
        if (!OPEN_STATES.includes(draft.status) && !["FAILED", "HUMAN_ACTION_REQUIRED"].includes(draft.status)) {
          await send(ctx, { text: `This report is already ${M_status(draft)}, so it can't be edited.` });
          return;
        }
        await complaints.editRequest(draft);
        await send(ctx, { text: M.editPrompt() });
        return;
      }
      case "cancel": {
        if (!canTransition(draft.status, "CANCELLED")) {
          await send(ctx, { text: `This report is already ${M_status(draft)}.` });
          return;
        }
        await complaints.cancel(draft, "user");
        await send(ctx, { text: M.cancelled() });
        return;
      }
      case "dup_review":
        await send(ctx, { text: `${M.dupReview()}\n\n${NYC311_CHECK_STATUS_URL}`, buttons: [[{ text: "➡️ Continue with new report", data: `dup_continue:${draft.id}:${draft.draftVersion}` }]] });
        return;
      case "dup_continue": {
        if (draft.status !== "DUPLICATE_REVIEW") {
          if (draft.status === "READY_FOR_APPROVAL") await presentDraft(ctx, draft);
          else await send(ctx, { text: `This report is ${M_status(draft)}.` });
          return;
        }
        if (cb.version !== draft.draftVersion) {
          await send(ctx, { text: M.draftChanged() });
          return void (await advance(ctx, draft));
        }
        draft = { ...draft, duplicateReviewed: true };
        draft = await tracer.span("user.duplicate_continue", { "complaint.id": draft.id }, async () =>
          transition(store, draft!, "READY_FOR_APPROVAL", { reason: "user chose to continue despite duplicates", actor: "user" }),
        );
        await presentDraft(ctx, draft, [], "user");
        return;
      }
      case "status": {
        if (!draft.officialRequestNumber) {
          await send(ctx, { text: `This report doesn't have an official request number. Status: <b>${M_status(draft)}</b>.` });
          return;
        }
        await replyStatus(ctx, draft.officialRequestNumber);
        return;
      }
      case "view_official": {
        const reqs = await store.listOfficialRequests(ctx.chatId);
        const r = reqs.find((x) => x.complaintId === draft!.id);
        const sr = r?.officialRequestNumber ?? draft.officialRequestNumber ?? "-";
        const shot = await confirmationScreenshot(draft);
        if (shot) {
          await send(ctx, { text: `Confirmation page for service request <b>${sr}</b>, captured by the filing worker.`, photoPath: shot });
          return;
        }
        const url = r?.receiptUrl && !/^DEMO-/.test(sr) ? r.receiptUrl : NYC311_CHECK_STATUS_URL;
        await send(ctx, { text: `Service request <b>${sr}</b>\n${url}` });
        return;
      }
      case "retry_location":
        await send(ctx, { text: M.askLocation(), requestLocation: true });
        return;
      case "confirm_location":
        if (OPEN_STATES.includes(draft.status)) await advance(ctx, draft);
        return;
    }
  }

  async function confirmationScreenshot(d: ComplaintDraft): Promise<string | null> {
    const attempts = d.activeAttemptId ? [await store.getAttempt(d.activeAttemptId)] : await store.listAttempts({ complaintId: d.id, limit: 5 });
    for (const a of attempts) {
      if (!a) continue;
      const shots = a.evidence.filter((e) => e.type === "screenshot");
      const ev = [...shots].reverse().find((e) => e.step === "confirm") ?? shots[shots.length - 1];
      const hit = ev ? resolveEvidencePath(ev.id) : null;
      if (hit) return hit.path;
    }
    return null;
  }

  function M_status(d: ComplaintDraft) {
    return d.status.toLowerCase().replace(/_/g, " ");
  }

  function rateLimited(chatId: string): boolean {
    const now = Date.now();
    const list = (approvalsLog.get(chatId) ?? []).filter((t) => now - t < 3600_000);
    approvalsLog.set(chatId, list);
    return list.length >= maxPerHour;
  }

  async function onApprove(ctx: Ctx, draft: ComplaintDraft, version: number) {
    if (draft.status === "APPROVED" || draft.status === "FILING" || filingJobs.has(draft.id)) {
      await send(ctx, { text: M.busy() });
      return;
    }
    if (draft.status !== "READY_FOR_APPROVAL") {
      await send(ctx, { text: `This report is ${M_status(draft)}, so there's nothing to approve.` });
      return;
    }
    if (version !== draft.draftVersion) {
      await send(ctx, { text: M.draftChanged() });
      await presentDraft(ctx, draft);
      return;
    }
    if (needsName(ctx.resident)) {
      await send(ctx, { text: M.needName() });
      return;
    }
    if (rateLimited(ctx.chatId)) {
      await send(ctx, { text: "You've filed several reports in the last hour. To avoid flooding NYC311, please wait a bit before filing another." });
      return;
    }
    const res = await tracer.span("user.approve", { "complaint.id": draft.id, "draft.version": version }, async (set) => {
      const r = await complaints.approve(draft, version, "user");
      set("approval.ok", r.ok);
      if (!r.ok) set("approval.reason", r.reason);
      return r;
    });
    if (!res.ok) {
      await send(ctx, { text: M.draftChanged() });
      const fresh = await store.getComplaint(draft.id);
      if (fresh?.status === "READY_FOR_APPROVAL") await presentDraft(ctx, fresh);
      return;
    }
    approvalsLog.set(ctx.chatId, [...(approvalsLog.get(ctx.chatId) ?? []), Date.now()]);
    await send(ctx, { text: M.filingNow() });
    const job = runFiling(ctx, res.draft).finally(() => filingJobs.delete(draft.id));
    filingJobs.set(draft.id, job);
    if (ctx.opts.waitForFiling) await job;
  }

  async function runFiling(ctx: Ctx, approved: ComplaintDraft) {
    // Progress: one message, edited in place (falls back to new messages if editing fails).
    const lines: string[] = [];
    let progressId: number | null = null;
    let last = "";
    let lastBody = "";
    let lastSentAt = 0;
    let chain: Promise<void> = Promise.resolve();
    const flush = async () => {
      const body = lines.slice(-8).map((l) => M.progress(l)).join("\n");
      if (!body || body === lastBody) return; // coalesced into a later edit
      const wait = 1100 - (Date.now() - lastSentAt); // stay under Telegram's edit rate limits
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const latest = lines.slice(-8).map((l) => M.progress(l)).join("\n");
      if (latest === lastBody) return;
      lastBody = latest;
      lastSentAt = Date.now();
      const r = await ctx.t.send({ chatId: ctx.chatId, text: latest, parseMode: "HTML", ...(progressId != null ? { editMessageId: progressId } : {}) });
      if (r.messageId != null) progressId = r.messageId;
    };
    const onProgress = (text: string) => {
      const clean = String(text).replace(/https?:\/\/\S+/g, "[link]").slice(0, 200);
      if (!clean || clean === last) return;
      last = clean;
      lines.push(clean);
      chain = chain.then(flush).catch((err) => console.warn("[orchestrator] progress send failed:", (err as Error).message));
    };

    let outcome: FilingOutcome;
    try {
      const resident = (await store.getOrCreateResident(ctx.chatId, ctx.resident.telegramUsername)) ?? ctx.resident;
      outcome = await filing.executeFiling(approved, { resident, onProgress });
    } catch (err) {
      console.error("[orchestrator] executeFiling threw:", err);
      outcome = { complaintId: approved.id, attemptId: approved.activeAttemptId ?? "unknown", status: "FAILED", errorCode: "WORKER_CRASH", message: "the filing worker crashed" };
    }
    await chain;
    await tracer.withSession({ sessionId: ctx.chatId, metadata: { complaintId: approved.id } }, () =>
      tracer.span("telegram.filing_outcome", { "complaint.id": approved.id, "filing.status": outcome.status, "filing.error_code": outcome.errorCode ?? "" }, async () => {
        await renderOutcome(ctx, approved, outcome);
      }),
    );
  }

  /** Bring the persisted complaint to the outcome state, tolerating a FilingService that already transitioned it. */
  async function settle(complaintId: string, fallback: ComplaintDraft, o: FilingOutcome): Promise<ComplaintDraft> {
    let d = (await store.getComplaint(complaintId)) ?? fallback;
    if (d.status === "APPROVED") d = await transition(store, d, "FILING", { reason: "filing started", actor: "system" });
    if (d.status === "FILING") d = await transition(store, d, o.status, { reason: o.errorCode ?? o.status.toLowerCase(), actor: "system" });
    if (o.attemptId && o.attemptId !== "none" && d.activeAttemptId !== o.attemptId) d = await store.saveComplaint({ ...d, activeAttemptId: o.attemptId });
    return d;
  }

  async function renderOutcome(ctx: Ctx, approved: ComplaintDraft, o: FilingOutcome) {
    let d: ComplaintDraft;
    try {
      d = await settle(approved.id, approved, o);
    } catch (err) {
      console.error("[orchestrator] could not settle outcome state:", (err as Error).message);
      d = (await store.getComplaint(approved.id)) ?? approved;
    }
    switch (o.status) {
      case "SUBMITTED": {
        if (!o.officialRequestNumber) {
          // Defensive: SUBMITTED without a parsed number is not a confirmation.
          await send(ctx, { text: M.unknown({ ...o, message: "No service request number was returned." }), buttons: linkButton("Check NYC311", NYC311_CHECK_STATUS_URL) });
          return;
        }
        d = await store.saveComplaint({ ...d, officialRequestNumber: o.officialRequestNumber });
        const req: OfficialRequest = {
          id: shortId("sr"),
          complaintId: d.id,
          officialRequestNumber: o.officialRequestNumber,
          officialCategory: getCategory(d.category)?.officialLabel ?? "Unknown",
          status: "Submitted",
          statusSource: /^DEMO-/.test(o.officialRequestNumber) ? "demo-portal" : "confirmation",
          lastCheckedAt: nowIso(),
          receiptUrl: o.officialReceiptUrl ?? null,
        };
        const known = (await store.listOfficialRequests(ctx.chatId).catch(() => [])).some((r) => r.officialRequestNumber === req.officialRequestNumber);
        if (!known) await store.saveOfficialRequest(req).catch((e) => console.warn("[orchestrator] saveOfficialRequest:", e.message));
        if (d.status === "SUBMITTED") d = await transition(store, d, "TRACKING", { reason: "tracking official request", actor: "system" });
        tracer.evaluate("filing_outcome", { label: "submitted", score: 1 });
        // Demo receipts live in a destroyed sandbox (and carry a signed URL): show the confirmation screenshot instead.
        const isDemo = /^DEMO-/.test(o.officialRequestNumber);
        await send(ctx, { text: o.message ? esc(o.message) : M.submitted(o), buttons: trackingButtons(d, isDemo ? null : (o.officialReceiptUrl ?? NYC311_CHECK_STATUS_URL)) });
        return;
      }
      case "HUMAN_ACTION_REQUIRED": {
        tracer.evaluate("filing_outcome", { label: "human_action_required", score: 0.5, explanation: o.errorCode });
        const url = finishUrl(d, o);
        const live = /https:\/\/\S+/.exec(o.message ?? "")?.[0]?.replace(/[).,]+$/, "") ?? null;
        const liveOk = isButtonSafeUrl(live);
        await send(ctx, {
          text: o.message ? `${esc(o.message)}\n\n${esc(url)}` : M.humanAction(o, url),
          buttons: [...linkButton("Finish on NYC311", url), ...(liveOk ? linkButton("🖥️ Take over the browser", live!) : []), [{ text: "❌ Cancel", data: `cancel:${d.id}:${d.draftVersion}` }]],
        });
        return;
      }
      case "SUBMISSION_UNKNOWN": {
        tracer.evaluate("filing_outcome", { label: "submission_unknown", score: 0, explanation: o.errorCode });
        await send(ctx, { text: o.message ? esc(o.message) : M.unknown(o), buttons: linkButton("Check NYC311", NYC311_CHECK_STATUS_URL) });
        return;
      }
      case "FAILED": {
        tracer.evaluate("filing_outcome", { label: "failed", score: 0, explanation: o.errorCode });
        await send(ctx, { text: o.message ? `${esc(o.message)} You can try again from the draft.` : M.failed(o) });
        // "Try again from the draft": back to review with a new version so a fresh approval is required.
        try {
          if (d.status === "FAILED") {
            const bumped = { ...d, draftVersion: d.draftVersion + 1, approvedVersion: null, approvedAt: null };
            d = await transition(store, bumped, "READY_FOR_APPROVAL", { reason: "retry after failure", actor: "system" });
            await presentDraft(ctx, d);
          }
        } catch (err) {
          console.warn("[orchestrator] could not reopen draft:", (err as Error).message);
        }
        return;
      }
    }
  }

  // ------------------------------------------------------------------ entry
  async function processEvent(event: InboundEvent, opts: HandleOptions) {
    const t = opts.transport ?? deps.transport;
    const fresh = await store.markUpdateProcessed(event.updateId);
    if (!fresh) return;
    // Untraced lookup only to put the complaint id in session metadata; all traced reads happen inside the session.
    const active = await store.getActiveComplaint(event.chatId).catch(() => null);
    await tracer.withSession({ sessionId: event.chatId, metadata: { complaintId: active?.id ?? null } }, () =>
      tracer.span("telegram.message", { "event.kind": event.kind, "complaint.id": active?.id ?? "", "complaint.status": active?.status ?? "" }, async (_set, oi) => {
        oi.input(redactEvent(event));
        try {
          const resident = await tracer.span("surrealdb.read_context", { "query.kind": "resident" }, async () => store.getOrCreateResident(event.chatId, event.username));
          const ctx: Ctx = { chatId: event.chatId, t, resident, opts };
          switch (event.kind) {
            case "command":
              return await onCommand(ctx, event.command, event.args);
            case "text":
              return await onText(ctx, event.text);
            case "photo":
              return await onPhoto(ctx, event);
            case "voice":
              return await onVoice(ctx, event);
            case "location":
              return await onLocation(ctx, event);
            case "callback":
              return await onCallback(ctx, event);
          }
        } catch (err) {
          console.error(`[orchestrator] error handling ${event.kind}:`, err);
          await t.send({ chatId: event.chatId, text: M.error() }).catch(() => {});
        }
      }),
    );
  }

  async function handle(event: InboundEvent, opts: HandleOptions = {}): Promise<void> {
    const prev = chains.get(event.chatId) ?? Promise.resolve();
    const run = prev.then(() => processEvent(event, opts)).catch(async (err) => {
      console.error("[orchestrator] unhandled:", err);
      const t = opts.transport ?? deps.transport;
      await t.send({ chatId: event.chatId, text: M.error() }).catch(() => {});
    });
    chains.set(event.chatId, run);
    await run;
    if (chains.get(event.chatId) === run) chains.delete(event.chatId);
  }

  /** Resolves when all background filing jobs are done (scripts/tests). */
  async function idle() {
    while (filingJobs.size) await Promise.allSettled([...filingJobs.values()]);
  }

  return { handle, idle, complaints };
}

export type Orchestrator = ReturnType<typeof createOrchestrator>;

function normalizeStatus(r: unknown): { found: boolean; status: string | null; detail?: string | null; source?: string | null } {
  if (!r || typeof r !== "object") return { found: false, status: null };
  const o = r as Record<string, unknown>;
  const status = typeof o.status === "string" ? o.status : null;
  const found = typeof o.found === "boolean" ? o.found : status != null;
  const detail = [o.detail, o.resolutionDescription, o.message, o.category].find((x) => typeof x === "string") as string | undefined;
  const source = typeof o.source === "string" ? o.source : null;
  return { found, status, detail: detail ?? null, source };
}

/** Never put file ids/paths or tokens into traces. */
function redactEvent(e: InboundEvent): Record<string, unknown> {
  switch (e.kind) {
    case "photo":
      return { kind: e.kind, caption: e.caption };
    case "voice":
      return { kind: e.kind, durationSec: e.durationSec };
    case "location":
      return { kind: e.kind, lat: Number(e.latitude.toFixed(3)), lon: Number(e.longitude.toFixed(3)) };
    case "callback":
      return { kind: e.kind, action: e.data.split(":")[0] };
    case "command":
      return { kind: e.kind, command: e.command };
    case "text":
      return { kind: e.kind, text: e.text };
  }
}
