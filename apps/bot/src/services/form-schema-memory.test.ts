/**
 * #11 (bot slice): a WorkerResult.formSchema becomes procedural memory (current merged item + append-only history)
 * and the catalog row's requiredFields / formSchema / lastVerifiedAt. Structure only, never values.
 */
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createApiServer } from "../api/server.js";
import type { BrowserProvider, ComplaintDraft, FormSchema, SandboxProvider, WorkerEvent, WorkerResult } from "../core/contracts.js";
import { EMPTY_LOCATION, EMPTY_TRANSIT, nowIso } from "../core/contracts.js";
import type { Orchestrator } from "../core/orchestrator.js";
import { __resetTracingForTests, createTracer, type TracerOptions } from "../integrations/arize.js";
import { createHashEmbedder } from "../integrations/embedder.js";
import { createNoopTracer } from "../integrations/fallbacks.js";
import { createMemoryStore } from "../integrations/memory-store.js";
import { createSurrealStore } from "../integrations/surrealdb.js";
import { createAgentMemory } from "./agent-memory.js";
import { fileableCatalogEntries } from "./catalog-crawl.js";
import { createFilingService } from "./filing.js";
import { categorySchemaView, mergeFormSchemas, readCurrentSchema, recordFormSchema, requiredFieldsOf, sanitizeFormSchema, schemaHistoryMemoryId, schemaMemoryId, type CurrentSchemaData } from "./form-schema-memory.js";

type Processor = NonNullable<TracerOptions["spanProcessors"]>[number];
type Ended = Parameters<Processor["onEnd"]>[0];

const T1 = "2026-10-16T12:00:00.000Z";
const T2 = "2026-10-16T13:00:00.000Z";

/** First run: what the MTA wizard showed (PR #21 dry run, abridged). */
const RUN1: FormSchema = {
  capturedAt: T1,
  steps: [
    { title: "Which service?", fields: [{ label: "Which service?", type: "button-choice", required: true, options: ["Subways", "Buses"], step: "Which service?", selectorHint: "role=button[name=<option>]" }] },
    { title: "Additional Information", fields: [{ label: "Car number", type: "text", required: false, step: "Additional Information" }] },
    {
      title: "Tell us more",
      fields: [
        { label: "Tell us more (Required)", type: "textarea", required: true, maxLength: 4000, step: "Tell us more" },
        { label: "Date and Time of Event", type: "date", required: false, step: "Tell us more" },
      ],
    },
  ],
};
/** Second run: car number became required, a new option appeared, the date field was not seen. */
const RUN2: FormSchema = {
  capturedAt: T2,
  steps: [
    { title: "Which service?", fields: [{ label: "Which service?", type: "button-choice", required: true, options: ["Subways", "Buses", "Long Island Rail Road"], step: "Which service?" }] },
    { title: "Additional Information", fields: [{ label: "Car number", type: "text", required: true, step: "Additional Information" }] },
    { title: "Tell us more", fields: [{ label: "Tell us more (Required)", type: "textarea", required: true, maxLength: 4000, step: "Tell us more" }] },
  ],
};
/** A buggy worker that leaked what was typed / chosen into the schema. */
const LEAKY = {
  capturedAt: T1,
  steps: [
    {
      title: "Contact details",
      fields: [
        { label: "Email (optional)", type: "text", required: false, step: "Contact details", value: "jane@example.com", options: ["jane@example.com"], selectorHint: 'input[value="jane@example.com"]' },
        { label: "First name (optional)", type: "text", required: false, step: "Contact details", filled: "Jane Doe", checked: true },
        { label: "Call me at 212-555-0100", type: "text", required: false, step: "Contact details" },
        { label: "Nearest station", type: "select", required: false, step: "Contact details", options: ["14 St", "W 4 St"], selected: "14 St", selectorHint: 'role=combobox[name="Nearest station"]' },
      ],
    },
  ],
};

const attempt = (id: string, extra: Partial<{ traceId: string | null; evidence: { id: string; type: "screenshot"; step: "confirm" | "validate" | "fill" }[] }> = {}) => ({ id, traceId: extra.traceId ?? `trace_${id}`, evidence: extra.evidence ?? [] });

describe("form schema: sanitize + merge (pure)", () => {
  it("keeps structure only: drops value keys, options on text inputs, value-pinning selectors, PII in labels", () => {
    const s = sanitizeFormSchema(LEAKY)!;
    const json = JSON.stringify(s);
    expect(json).not.toMatch(/jane@example|Jane Doe|555-0100|"value"|"filled"|"checked"|"selected"/);
    const [email, first, call, station] = s.steps[0]!.fields;
    expect(email).toEqual({ label: "Email (optional)", type: "text", required: false, step: "Contact details" });
    expect(first).toEqual({ label: "First name (optional)", type: "text", required: false, step: "Contact details" });
    expect(call!.label).toBe("Call me at [phone]");
    // official option labels of a choice control are structure and stay
    expect(station).toEqual({ label: "Nearest station", type: "select", required: false, step: "Contact details", options: ["14 St", "W 4 St"], selectorHint: 'role=combobox[name="Nearest station"]' });
    expect(sanitizeFormSchema({ steps: [] })).toBeNull();
    expect(sanitizeFormSchema("nope")).toBeNull();
  });

  it("merge: union of required fields, latest options, unseen fields kept, diff explains it", () => {
    const { merged, diff } = mergeFormSchemas(RUN1, RUN2);
    expect(requiredFieldsOf(merged)).toEqual(["Which service?", "Car number", "Tell us more (Required)"]);
    expect(merged.steps[0]!.fields[0]!.options).toEqual(["Subways", "Buses", "Long Island Rail Road"]);
    expect(merged.steps[2]!.fields.map((f) => f.label)).toEqual(["Tell us more (Required)", "Date and Time of Event"]);
    expect(merged.capturedAt).toBe(T2);
    expect(diff).toEqual({ added: [], notSeen: ["Date and Time of Event"], newlyRequired: ["Car number"], optionsChanged: ["Which service?"] });
    // a field that is optional in a later run stays required (union)
    expect(requiredFieldsOf(mergeFormSchemas(RUN2, RUN1).merged)).toContain("Car number");
  });
});

describe("form schema → procedural memory + catalog (recordFormSchema)", () => {
  it("first observation writes the current item + a history item and updates the catalog row; second merges + appends", async () => {
    const store = createMemoryStore();
    await store.upsertCatalog!(fileableCatalogEntries(T1));
    const memory = createAgentMemory({ store, embedder: createHashEmbedder() });
    const evidence = [
      { id: "ev_v", type: "screenshot" as const, step: "validate" as const },
      { id: "ev_c", type: "screenshot" as const, step: "confirm" as const },
      { id: "ev_f", type: "screenshot" as const, step: "fill" as const },
    ];

    const r1 = await recordFormSchema({ store, memory }, { category: "subway-delay", attempt: attempt("att_1", { evidence }), outcome: "HUMAN_ACTION_REQUIRED", formSchema: RUN1 });
    await memory.flush();
    expect(r1).toMatchObject({ currentId: "mem_schema_subway-delay", historyId: "mem_schemahist_att_1", version: 1, requiredFields: ["Which service?", "Tell us more (Required)"], catalogUpdated: true });
    const cur1 = (await store.listMemory!({ kind: "procedural" })).find((m) => m.id === schemaMemoryId("subway-delay"))!;
    expect(cur1).toMatchObject({
      kind: "procedural",
      category: "subway-delay",
      chatId: null,
      importance: 0.6,
      source: "attempt:att_1",
      about: [{ table: "filing_attempt", id: "att_1" }, { table: "complaint_category", id: "subway-delay" }],
    });
    expect(cur1.text).toBe("Form schema for Subway delay: steps Which service? → Additional Information → Tell us more; required fields: Which service?, Tell us more (Required).");
    const d1 = cur1.data as CurrentSchemaData;
    expect(d1.source).toEqual({ attemptId: "att_1", traceId: "trace_att_1", evidenceIds: ["ev_v", "ev_c"], capturedAt: T1 });
    expect(d1.history).toHaveLength(1);
    let cat = (await store.listCatalog!()).find((e) => e.id === "subway-delay")!;
    expect(cat.requiredFields).toEqual(["Which service?", "Tell us more (Required)"]);
    expect(cat.lastVerifiedAt).toBe(T1);
    expect(cat.formSchema?.steps).toHaveLength(3);

    const r2 = await recordFormSchema({ store, memory }, { category: "subway-delay", attempt: attempt("att_2"), outcome: "SUBMITTED", formSchema: RUN2 });
    await memory.flush();
    expect(r2).toMatchObject({ version: 2, requiredFields: ["Which service?", "Car number", "Tell us more (Required)"], diff: { newlyRequired: ["Car number"] } });
    const procedural = await store.listMemory!({ kind: "procedural" });
    expect(procedural.filter((m) => m.id === schemaMemoryId("subway-delay"))).toHaveLength(1); // upserted, not duplicated
    expect(procedural.map((m) => m.id)).toEqual(expect.arrayContaining([schemaHistoryMemoryId("att_1"), schemaHistoryMemoryId("att_2")]));
    const cur2 = (await readCurrentSchema(store, "subway-delay"))!;
    expect(cur2.version).toBe(2);
    expect(cur2.outcome).toBe("SUBMITTED");
    expect(cur2.history.map((h) => h.attemptId)).toEqual(["att_1", "att_2"]);
    expect(cur2.history[1]!.diff).toMatchObject({ newlyRequired: ["Car number"], notSeen: ["Date and Time of Event"], optionsChanged: ["Which service?"] });
    expect(procedural.find((m) => m.id === schemaMemoryId("subway-delay"))!.importance).toBe(0.9);
    cat = (await store.listCatalog!()).find((e) => e.id === "subway-delay")!;
    expect(cat.requiredFields).toEqual(["Which service?", "Car number", "Tell us more (Required)"]);
    expect(cat.lastVerifiedAt).toBe(T2);

    // a later catalog re-crawl does not clobber the learned list
    await store.upsertCatalog!(fileableCatalogEntries(T2));
    cat = (await store.listCatalog!()).find((e) => e.id === "subway-delay")!;
    expect(cat.requiredFields).toEqual(["Which service?", "Car number", "Tell us more (Required)"]);
    expect(cat.formSchema).toBeTruthy();

    const view = (await categorySchemaView(store, "subway-delay"))!;
    expect(view).toMatchObject({ category: "subway-delay", version: 2, provenance: { attemptId: "att_2", traceId: "trace_att_2", capturedAt: T2 } });
    expect(view.history).toHaveLength(2);
  });

  it("the writer persists structure only: a leaky schema leaves no values in memory or the catalog", async () => {
    const store = createMemoryStore();
    await store.upsertCatalog!(fileableCatalogEntries(T1));
    const memory = createAgentMemory({ store, embedder: createHashEmbedder() });
    await recordFormSchema({ store, memory }, { category: "subway-delay", attempt: attempt("att_x"), outcome: "FAILED", formSchema: LEAKY });
    await memory.flush();
    const rows = await store.listMemory!({ kind: "procedural" });
    expect(rows).toHaveLength(2);
    const everything = JSON.stringify({ rows, catalog: await store.listCatalog!() });
    expect(everything).not.toMatch(/jane@example|Jane Doe|555-0100|"value"|"filled"|"checked"|"selected"/);
  });

  it("concurrent observations of one category are serialized (no lost history)", async () => {
    const store = createMemoryStore();
    const memory = createAgentMemory({ store, embedder: createHashEmbedder() });
    await Promise.all([
      recordFormSchema({ store, memory }, { category: "subway-delay", attempt: attempt("att_a"), outcome: "FAILED", formSchema: RUN1 }),
      recordFormSchema({ store, memory }, { category: "subway-delay", attempt: attempt("att_b"), outcome: "FAILED", formSchema: RUN2 }),
    ]);
    await memory.flush();
    const cur = (await readCurrentSchema(store, "subway-delay"))!;
    expect(cur.version).toBe(2);
    expect(cur.history.map((h) => h.attemptId)).toEqual(["att_a", "att_b"]);
  });
});

describe("filing service writes the schema after an attempt", () => {
  function approvedDraft(): ComplaintDraft {
    const t = nowIso();
    return {
      id: "cmp_fs",
      telegramChatId: "rider-s",
      residentId: "res_s",
      status: "APPROVED",
      category: "subway-delay",
      triage: "SUPPORTED",
      description: "A train stuck",
      userMessages: [],
      location: { ...EMPTY_LOCATION },
      media: [],
      classification: null,
      transit: { ...EMPTY_TRANSIT, line: "A" },
      missingFields: [],
      needsEmergencyReferral: false,
      confidence: 0.95,
      duplicates: [],
      duplicateReviewed: true,
      draftVersion: 1,
      approvedVersion: 1,
      approvedAt: t,
      activeAttemptId: null,
      officialRequestNumber: null,
      statusReason: null,
      traceId: null,
      createdAt: t,
      updatedAt: t,
    };
  }
  const browser: BrowserProvider = {
    name: "local",
    createSession: async () => ({ id: "sess", provider: "local", cdpUrl: null, liveViewUrl: null, close: async () => {}, getRecordingUrl: async () => null }),
  };
  const sandbox = (formSchema: unknown, events: WorkerEvent[] = []): SandboxProvider => ({
    name: "local",
    provision: async () => ({
      id: "sbx",
      provider: "local",
      async runWorker(payload, onEvent) {
        for (const e of events) onEvent(e);
        const result: WorkerResult = {
          attemptId: payload.attemptId,
          status: "HUMAN_ACTION_REQUIRED",
          errorCode: null,
          officialRequestNumber: null,
          officialReceiptUrl: null,
          confirmationText: null,
          submitClicked: false,
          finalUrl: null,
          steps: [],
          evidence: [],
          message: null,
          startedAt: nowIso(),
          finishedAt: nowIso(),
          formSchema: formSchema as FormSchema,
        };
        return { result, stdout: "", exitCode: 0 };
      },
      downloadEvidence: async () => {
        throw new Error("no evidence in tests");
      },
      destroy: async () => {},
    }),
  });

  it("procedural item + catalog row after executeFiling (drain + flush)", async () => {
    const store = createMemoryStore();
    await store.upsertCatalog!(fileableCatalogEntries(T1));
    const memory = createAgentMemory({ store, embedder: createHashEmbedder() });
    await store.saveComplaint(approvedDraft());
    const filing = createFilingService({ store, tracer: createNoopTracer(), memory, sandboxProvider: sandbox(RUN1), browserProvider: browser });
    const resident = await store.getOrCreateResident("rider-s", null);
    const outcome = await filing.executeFiling(approvedDraft(), { resident, onProgress: () => {} });
    await filing.drain();
    await memory.flush();
    const cur = (await readCurrentSchema(store, "subway-delay"))!;
    expect(cur.source.attemptId).toBe(outcome.attemptId);
    expect(cur.outcome).toBe(outcome.status);
    expect((await store.listCatalog!()).find((e) => e.id === "subway-delay")!.requiredFields).toEqual(["Which service?", "Tell us more (Required)"]);
    // never on the resident: world fact
    expect((await store.listMemory!({ kind: "procedural" })).every((m) => m.chatId === null)).toBe(true);
  });

  it("Phoenix: form.required_fields on daytona.run_worker + browser.inspect, schema summary in the output, no values", async () => {
    const spans: Ended[] = [];
    const processor: Processor = { onStart() {}, onEnd: (s) => void spans.push(s), forceFlush: async () => {}, shutdown: async () => {} };
    const tracer = createTracer({ spanProcessors: [processor], endpoint: "http://localhost:6006", projectName: "test" });
    try {
      const store = createMemoryStore();
      await store.saveComplaint(approvedDraft());
      const leakyStep = LEAKY.steps[0]!;
      const events: WorkerEvent[] = [
        { ts: nowIso(), step: "inspect", level: "info", message: "form_schema", data: { stepTitle: RUN1.steps[2]!.title, fields: RUN1.steps[2]!.fields } },
        { ts: nowIso(), step: "inspect", level: "info", message: "form_schema", data: { stepTitle: leakyStep.title, fields: leakyStep.fields } },
      ];
      const leakyRun = { capturedAt: T1, steps: [...RUN1.steps, leakyStep] };
      const filing = createFilingService({ store, tracer, sandboxProvider: sandbox(leakyRun, events), browserProvider: browser });
      const resident = await store.getOrCreateResident("rider-s", null);
      await filing.executeFiling(approvedDraft(), { resident, onProgress: () => {} });
      await filing.drain();
      const run = spans.find((s) => s.name === "daytona.run_worker")!;
      expect(run.attributes["form.required_fields"]).toEqual(["Which service?", "Tell us more (Required)"]);
      expect(run.attributes["form.steps"]).toBe(4);
      const out = JSON.parse(String(run.attributes["output.value"]));
      expect(out.formSchema.requiredFields).toEqual(["Which service?", "Tell us more (Required)"]);
      expect(out.formSchema.steps[0]).toEqual({ title: "Which service?", fields: [{ label: "Which service?", type: "button-choice", required: true, options: 2 }] });
      const inspect = spans.find((s) => s.name === "browser.inspect")!;
      expect(inspect.attributes["form.required_fields"]).toEqual(["Tell us more (Required)"]);
      const all = JSON.stringify(spans.map((s) => s.attributes));
      expect(all).not.toMatch(/jane@example|Jane Doe|555-0100/);
      // no AgentMemory configured ⇒ no schema items (the catalog is still updated)
      expect(await readCurrentSchema(store, "subway-delay")).toBeNull();
    } finally {
      __resetTracingForTests();
    }
  });
});

describe("GET /api/categories/:id/schema", () => {
  it("returns the merged schema with provenance + history; 404 before anything was learned", async () => {
    const store = createMemoryStore();
    const memory = createAgentMemory({ store, embedder: createHashEmbedder() });
    const server = createApiServer({ store, tracer: createNoopTracer(), memory, orchestrator: {} as Orchestrator });
    await new Promise<void>((r) => server.listen(0, r));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      expect((await fetch(`${base}/api/categories/subway-delay/schema`)).status).toBe(404);
      await recordFormSchema({ store, memory }, { category: "subway-delay", attempt: attempt("att_api1"), outcome: "FAILED", formSchema: RUN1 });
      await recordFormSchema({ store, memory }, { category: "subway-delay", attempt: attempt("att_api2"), outcome: "SUBMITTED", formSchema: RUN2 });
      await memory.flush();
      const res = await fetch(`${base}/api/categories/subway-delay/schema`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Awaited<ReturnType<typeof categorySchemaView>>;
      expect(body).toMatchObject({
        category: "subway-delay",
        requiredFields: ["Which service?", "Car number", "Tell us more (Required)"],
        version: 2,
        provenance: { attemptId: "att_api2", traceId: "trace_att_api2", capturedAt: T2 },
        source: "memory",
      });
      expect(body!.formSchema.steps).toHaveLength(3);
      expect(body!.history.map((h) => h.attemptId)).toEqual(["att_api1", "att_api2"]);
      expect((await fetch(`${base}/api/categories/subway-delay`)).status).toBe(404);
    } finally {
      server.close();
    }
  });
});

describe("form schema on SurrealDB (embedded mem://)", () => {
  it("procedural items + complaint_category row; a catalog re-upsert keeps the learned requiredFields", async () => {
    const store = createSurrealStore({ url: "mem://", isolated: true });
    await store.init();
    try {
      await store.upsertCatalog(fileableCatalogEntries(T1));
      expect((await store.listCatalog()).find((e) => e.id === "subway-delay")!.requiredFields).toEqual(["transit", "description"]);
      const memory = createAgentMemory({ store, embedder: createHashEmbedder() });
      await recordFormSchema({ store, memory }, { category: "subway-delay", attempt: attempt("att_s1"), outcome: "HUMAN_ACTION_REQUIRED", formSchema: RUN1 });
      await recordFormSchema({ store, memory }, { category: "subway-delay", attempt: attempt("att_s2"), outcome: "SUBMITTED", formSchema: RUN2 });
      await memory.flush();
      const cur = (await readCurrentSchema(store, "subway-delay"))!;
      expect(cur.version).toBe(2);
      expect(cur.history.map((h) => h.attemptId)).toEqual(["att_s1", "att_s2"]);
      let row = (await store.listCatalog()).find((e) => e.id === "subway-delay")!;
      expect(row.requiredFields).toEqual(["Which service?", "Car number", "Tell us more (Required)"]);
      expect(row.lastVerifiedAt).toBe(T2);
      expect(row.formSchema?.steps.map((s) => s.title)).toEqual(["Which service?", "Additional Information", "Tell us more"]);
      await store.upsertCatalog(fileableCatalogEntries(T2));
      row = (await store.listCatalog()).find((e) => e.id === "subway-delay")!;
      expect(row.requiredFields).toEqual(["Which service?", "Car number", "Tell us more (Required)"]);
      expect((await categorySchemaView(store, "subway-delay"))!.provenance).toMatchObject({ attemptId: "att_s2", capturedAt: T2 });
    } finally {
      await store.close();
    }
  }, 30_000);
});
