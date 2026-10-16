/**
 * #5 duplicate awareness across residents: the conversation (DUPLICATE_REVIEW prompt, dup_join / dup_continue),
 * the same_issue_as / not_same_as edges + supporters in both stores, and GET /api/complaints/:id sameIssue.
 */
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClassificationResult, Store, TransitDetails } from "../core/contracts.js";
import { EMPTY_LOCATION } from "../core/contracts.js";
import { createOrchestrator } from "../core/orchestrator.js";
import { createApiServer } from "../api/server.js";
import { createCaptureTransport, type CapturedMessage } from "../api/capture-transport.js";
import { createHashEmbedder } from "../integrations/embedder.js";
import { createNoopTracer } from "../integrations/fallbacks.js";
import { createMemoryStore } from "../integrations/memory-store.js";
import { createSurrealStore, type SurrealStore } from "../integrations/surrealdb.js";
import { createAgentMemory } from "./agent-memory.js";

const transit = (over: Partial<TransitDetails> = {}): TransitDetails => ({ line: "A", direction: "downtown", station: "14 St", borough: null, incidentTime: new Date().toISOString(), delayMinutes: 25, ...over });
const classification = (t: TransitDetails, description = "The A train was held at 14 St for 25 minutes with no announcements."): ClassificationResult => ({
  triage: "SUPPORTED",
  category: "subway-delay",
  confidence: 0.95,
  description,
  rationale: "",
  alternativeConsidered: null,
  safetyFlags: [],
  clarifyingQuestion: null,
  transit: t,
});

function harness(store: Store) {
  const memory = createAgentMemory({ store, embedder: createHashEmbedder() });
  const byChat = new Map<string, ClassificationResult>();
  let filings = 0;
  const transport = createCaptureTransport();
  const orch = createOrchestrator({
    store,
    memory,
    tracer: createNoopTracer(),
    classifier: { classify: async () => ({ result: byChat.get(current)!, model: "stub", usage: { promptTokens: null, completionTokens: null } }) },
    location: { fromPin: async () => ({ ...EMPTY_LOCATION }), fromText: async () => null, withinNyc: () => true },
    duplicates: { findPotentialDuplicates: async () => ({ candidates: [], dataAsOf: null, source: "open-data" }), lookupStatus: async () => null },
    filing: {
      executeFiling: async () => {
        filings++;
        return { complaintId: "x", attemptId: "none", status: "FAILED", errorCode: "SANDBOX_ERROR", message: "stub" };
      },
    },
    transport,
    mtaAlerts: async () => ({ alerts: [], source: "unavailable" }) as never,
  });
  let current = "";
  let n = 0;
  const hid = Math.random().toString(36).slice(2, 8);
  const say = async (chatId: string, text: string, c: ClassificationResult) => {
    current = chatId;
    byChat.set(chatId, c);
    const before = transport.messages.length;
    await orch.handle({ kind: "text", chatId, updateId: `${hid}-${++n}`, text, username: null });
    await memory.flush();
    return transport.messages.slice(before);
  };
  const tap = async (chatId: string, data: string) => {
    current = chatId;
    const before = transport.messages.length;
    await orch.handle({ kind: "callback", chatId, updateId: `${hid}-${++n}`, data, messageId: null, username: null }, { waitForFiling: true });
    await memory.flush();
    return transport.messages.slice(before);
  };
  const cmd = async (chatId: string, command: string) => {
    current = chatId;
    const before = transport.messages.length;
    await orch.handle({ kind: "command", chatId, updateId: `${hid}-${++n}`, command, args: "", username: null });
    return transport.messages.slice(before);
  };
  return { memory, say, tap, cmd, filings: () => filings };
}

const button = (msgs: CapturedMessage[], action: string) => msgs.flatMap((m) => (m.buttons ?? []).flat()).find((b) => b.data?.startsWith(`${action}:`))?.data ?? null;
const RIDER_A = "rider-a-901";
const RIDER_B = "rider-b-902";

for (const [name, make] of [
  ["memory store", async () => ({ store: createMemoryStore() as Store, close: async () => {} })],
  [
    "SurrealDB embedded",
    async () => {
      const s: SurrealStore = createSurrealStore({ url: "mem://", isolated: true });
      await s.init();
      return { store: s as Store, close: () => s.close() };
    },
  ],
] as const) {
  describe(`same issue across residents (${name})`, () => {
    let store: Store;
    let close: () => Promise<void>;
    beforeAll(async () => ({ store, close } = await make()), 30_000);
    afterAll(async () => close?.());

    async function firstRider(h: ReturnType<typeof harness>, chatId = RIDER_A, t = transit()) {
      const msgs = await h.say(chatId, "The A train sat at 14 St for 25 minutes, downtown", classification(t));
      expect(button(msgs, "approve")).not.toBeNull(); // nobody else raised it: straight to the card
      return (await store.getActiveComplaint(chatId))!;
    }

    it("same issue from two chat ids → the second gets the prompt; join creates the edge, supporters, no filing", async () => {
      const h = harness(store);
      const original = await firstRider(h);
      const msgs = await h.say(RIDER_B, "A train stuck at 14 St downtown for like 25 min", classification(transit(), "The downtown A train was held at 14 St for about 25 minutes, no announcements."));
      const prompt = msgs[msgs.length - 1]!;
      expect(prompt.text).toContain("Looks like this was already raised: an A train delay, Downtown &amp; Queens, around 14 St");
      expect(prompt.text).toContain("Do you want to raise another issue, or add yourself to that one?");
      expect(prompt.text).toContain("1 person reported this in the last 2 hours");
      expect(prompt.text).toMatch(/match 0\.\d\d ≥ 0\.7/);
      expect(prompt.text).not.toContain(RIDER_A);
      expect(button(msgs, "approve")).toBeNull();
      expect((prompt.buttons ?? []).map((r) => r.map((b) => b.text))).toEqual([["➕ Add me to the existing report"], ["🆕 It's different — file a new one"], ["❌ Cancel"]]);
      const draft = (await store.getActiveComplaint(RIDER_B))!;
      expect(draft.status).toBe("DUPLICATE_REVIEW");
      expect(draft.statusReason).toBe(`same issue as ${original.id}`);

      const joined = await h.tap(RIDER_B, button(msgs, "dup_join")!);
      expect(joined[0]!.text).toContain("you're added to the existing report");
      expect(joined[0]!.text).toContain("You'll get its status updates in /myreports");
      const supporter = (await store.getComplaint(draft.id))!;
      expect(supporter).toMatchObject({ status: "TRACKING", sameIssueAs: original.id });
      expect(h.filings()).toBe(0);
      expect(await store.listAttempts({ complaintId: draft.id })).toEqual([]);
      expect(await store.getIssueLinks!(draft.id)).toEqual({ sameIssueAs: original.id, joined: [], notSameAs: [], supporters: 0 });
      expect(await store.getIssueLinks!(original.id)).toEqual({ sameIssueAs: null, joined: [draft.id], notSameAs: [], supporters: 1 });
      expect((await store.getComplaint(original.id))!.supporters).toBe(1);
      // a stale copy of the original (its own resident's next save) never resets supporters
      await store.saveComplaint({ ...original, updatedAt: new Date().toISOString() });
      expect((await store.getComplaint(original.id))!.supporters).toBe(1);
      // the choice is episodic memory
      const mem = await store.listMemory!({ chatId: RIDER_B, kind: "episodic" });
      expect(mem.some((m) => (m.data as { sameIssueChoice?: string }).sameIssueChoice === "join" && (m.data as { sameIssueAs?: string }).sameIssueAs === original.id)).toBe(true);
      // graph edge
      const g = await store.graph({ complaintId: draft.id });
      expect(g.edges).toContainEqual({ from: draft.id, to: original.id, rel: "same_issue_as" });
      // /myreports lists the joined issue
      const mine = await h.cmd(RIDER_B, "myreports");
      expect(mine[0]!.text).toContain("added to an existing report (draft, not filed)");
      // a third rider: the supporter counts toward the original
      const third = await h.say("rider-c-903", "A train held at 14 St downtown 25 minutes", classification(transit()));
      expect(third[third.length - 1]!.text).toContain("2 people reported this in the last 2 hours");
      expect(third[third.length - 1]!.text).toContain("1 person has added themselves to it");
      await h.tap("rider-c-903", button(third, "cancel")!);
    });

    it("different line → no prompt; opposite direction → no prompt", async () => {
      const h = harness(store);
      const other = await h.say("rider-d-904", "The C train sat at 14 St for 25 minutes, downtown", classification(transit({ line: "C" }), "The C train was held at 14 St for 25 minutes with no announcements."));
      expect(button(other, "dup_join")).toBeNull();
      expect(button(other, "approve")).not.toBeNull();
      const opposite = await h.say("rider-e-905", "The A train sat at 14 St for 25 minutes, uptown", classification(transit({ direction: "uptown" })));
      expect(button(opposite, "dup_join")).toBeNull();
      expect(button(opposite, "approve")).not.toBeNull();
    });

    it("It's different → not_same_as edge, the approval card, and no second prompt about that report", async () => {
      const h = harness(store);
      const msgs = await h.say("rider-f-906", "A train held at 14 St downtown 25 minutes", classification(transit()));
      const cont = button(msgs, "dup_continue");
      expect(cont).not.toBeNull();
      const d = (await store.getActiveComplaint("rider-f-906"))!;
      const originalId = d.statusReason!.replace("same issue as ", "");
      const card = await h.tap("rider-f-906", cont!);
      expect(card[card.length - 1]!.text).toContain("OK, treating this as a different issue");
      expect(button(card, "approve")).not.toBeNull();
      expect((await store.getIssueLinks!(d.id)).notSameAs).toEqual([originalId]);
      expect((await store.getComplaint(d.id))!.status).toBe("READY_FOR_APPROVAL");
      const g = await store.graph({ complaintId: d.id });
      expect(g.edges).toContainEqual({ from: d.id, to: originalId, rel: "not_same_as" });
      // editing the draft re-runs the pipeline: the dismissed report is not offered again
      const again = await h.say("rider-f-906", "it was 25 minutes", classification(transit()));
      const offered = (await store.getActiveComplaint("rider-f-906"))!;
      if (offered.status === "DUPLICATE_REVIEW") expect(offered.statusReason).not.toBe(`same issue as ${originalId}`);
      else expect(button(again, "approve")).not.toBeNull();
    });
  });
}

describe("GET /api/complaints/:id sameIssue", () => {
  it("returns the cluster (complaint ids only) for the original and a supporter", async () => {
    const store = createMemoryStore();
    const h = harness(store);
    await h.say(RIDER_A, "The A train sat at 14 St for 25 minutes, downtown", classification(transit()));
    const original = (await store.getActiveComplaint(RIDER_A))!;
    const msgs = await h.say(RIDER_B, "A train held at 14 St downtown", classification(transit()));
    const supporterId = (await store.getActiveComplaint(RIDER_B))!.id;
    await h.tap(RIDER_B, button(msgs, "dup_join")!);
    const server = createApiServer({ store, tracer: createNoopTracer(), memory: h.memory, orchestrator: {} as never });
    await new Promise<void>((r) => server.listen(0, r));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const a = (await (await fetch(`${base}/api/complaints/${original.id}`)).json()) as { sameIssue: unknown };
      expect(a.sameIssue).toEqual({ originalId: original.id, supporters: 1, joined: [supporterId], notSameAs: [] });
      const b = (await (await fetch(`${base}/api/complaints/${supporterId}`)).json()) as { sameIssue: unknown };
      expect(b.sameIssue).toEqual({ originalId: original.id, supporters: 1, joined: [supporterId], notSameAs: [] });
      const g = (await (await fetch(`${base}/api/graph`)).json()) as { edges: { from: string; to: string; rel: string }[] };
      expect(g.edges).toContainEqual({ from: supporterId, to: original.id, rel: "same_issue_as" });
    } finally {
      server.close();
    }
  });
});
