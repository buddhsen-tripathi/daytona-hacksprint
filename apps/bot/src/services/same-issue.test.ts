/**
 * #5 duplicate awareness across residents: matching (findSameIssue) tuned on fixtures/duplicates/*.json.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ClassificationResult, ComplaintDraft, Store } from "../core/contracts.js";
import { EMPTY_LOCATION, EMPTY_TRANSIT } from "../core/contracts.js";
import { createHashEmbedder } from "../integrations/embedder.js";
import { createMemoryStore } from "../integrations/memory-store.js";
import { createAgentMemory, readyForApprovalItem } from "./agent-memory.js";
import { SAME_ISSUE, findSameIssue, sameIssueAgreement, sameIssuePrompt, sameIssueChoiceItem } from "./memory.js";

type Side = { line: string; direction: string; station: string; description: string; incidentMinutesAgo: number; reportedMinutesAgo?: number };
type Fixture = { name: string; category: "subway-delay"; original: Side; incoming: Side; expect: "match" | "none"; reason: string | null };

const DIR = fileURLToPath(new URL("../../../../fixtures/duplicates/", import.meta.url));
const FIXTURES = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => ({ file: f, ...(JSON.parse(readFileSync(`${DIR}${f}`, "utf8")) as Fixture) }));

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const cls = (description: string): ClassificationResult => ({ triage: "SUPPORTED", category: "subway-delay", confidence: 0.9, description, rationale: "", alternativeConsidered: null, safetyFlags: [], clarifyingQuestion: null, transit: null });

export function subwayDraft(id: string, chatId: string, s: Side, over: Partial<ComplaintDraft> = {}): ComplaintDraft {
  const created = ago(s.reportedMinutesAgo ?? s.incidentMinutesAgo);
  return {
    id,
    telegramChatId: chatId,
    residentId: `res_${chatId}`,
    status: "READY_FOR_APPROVAL",
    category: "subway-delay",
    triage: "SUPPORTED",
    description: s.description,
    userMessages: [],
    location: { ...EMPTY_LOCATION },
    media: [],
    classification: cls(s.description),
    transit: { ...EMPTY_TRANSIT, line: s.line, direction: s.direction, station: s.station, incidentTime: ago(s.incidentMinutesAgo) },
    missingFields: [],
    needsEmergencyReferral: false,
    confidence: 0.9,
    duplicates: [],
    duplicateReviewed: true,
    draftVersion: 1,
    approvedVersion: null,
    approvedAt: null,
    activeAttemptId: null,
    officialRequestNumber: null,
    statusReason: null,
    traceId: null,
    createdAt: created,
    updatedAt: created,
    ...over,
  };
}

async function setup(f: Pick<Fixture, "original" | "incoming">, over: Partial<ComplaintDraft> = {}) {
  const store: Store = createMemoryStore();
  const memory = createAgentMemory({ store, embedder: createHashEmbedder() });
  const original = await store.saveComplaint(subwayDraft("cmp_orig", "rider-1", f.original, over));
  await memory.remember({ ...readyForApprovalItem(original), createdAt: original.createdAt });
  const incoming = await store.saveComplaint(subwayDraft("cmp_new", "rider-2", f.incoming, { status: "TRIAGING", createdAt: ago(0) }));
  return { store, memory, original, incoming };
}

describe("same issue across residents: fixtures/duplicates", () => {
  it("has the six threshold fixtures", () => {
    expect(FIXTURES.map((f) => f.file)).toEqual(["different-line.json", "five-hours-apart.json", "forty-minutes-apart.json", "opposite-direction.json", "paraphrase.json", "same-issue.json"]);
  });

  for (const f of FIXTURES) {
    it(`${f.file}: ${f.name} → ${f.expect}`, async () => {
      const { store, memory, original, incoming } = await setup(f);
      const ag = sameIssueAgreement(incoming, original);
      expect(ag.reason).toBe(f.reason);
      const m = await findSameIssue({ store, memory }, incoming);
      // threshold tuning: score with the structural gate disabled (what recall alone would say)
      const loose = await findSameIssue({ store, memory }, incoming, { threshold: 0 });
      if (f.expect === "match") {
        expect(m, `score ${loose?.breakdown.score}`).not.toBeNull();
        expect(m!.originalId).toBe("cmp_orig");
        expect(m!.breakdown.score).toBeGreaterThanOrEqual(SAME_ISSUE.threshold);
        expect(m!.breakdown).toMatchObject({ sameLine: true, direction: "same", relevanceKind: "cosine" });
        expect(m!.breakdown.deltaMinutes).toBeLessThanOrEqual(180);
      } else {
        expect(m).toBeNull();
        expect(loose).toBeNull(); // rejected structurally, not by the threshold
      }
    });
  }

  it("an unrelated text on the same line/direction/time stays under the threshold", async () => {
    const f = FIXTURES.find((x) => x.file === "same-issue.json")!;
    const { store, memory, incoming } = await setup({ ...f, original: { ...f.original, station: "Jay St-MetroTech", description: "Overcrowded platform, the escalator at Jay St-MetroTech was out of service." } });
    const loose = await findSameIssue({ store, memory }, incoming, { threshold: 0 });
    expect(loose).not.toBeNull();
    expect(loose!.breakdown.score).toBeLessThan(SAME_ISSUE.threshold);
    expect(await findSameIssue({ store, memory }, incoming)).toBeNull();
  });

  it("privacy: the match carries neutral facts only — no chat ids, resident ids or contact fields", async () => {
    const f = FIXTURES.find((x) => x.file === "same-issue.json")!;
    const { store, memory, incoming } = await setup(f, { userMessages: ["call me at 917-555-0101, jane@example.com"] });
    const m = (await findSameIssue({ store, memory }, incoming))!;
    const json = JSON.stringify(m) + sameIssuePrompt(m);
    for (const secret of ["rider-1", "res_rider-1", "917-555-0101", "jane@example.com"]) expect(json).not.toContain(secret);
    expect(Object.keys(m).sort()).toEqual(["breakdown", "category", "direction", "line", "memoryId", "neutralDescription", "officialRequestNumber", "originalId", "recentReporters", "station", "status", "supporters", "timeBucket"]);
    expect(m.timeBucket).toBe("30 min ago");
    expect(m.recentReporters).toBe(1);
    const prompt = sameIssuePrompt(m);
    expect(prompt).toContain("Looks like this was already raised: an A train delay, Downtown &amp; Queens, around 14 St, 30 min ago (status: draft, not filed)");
    expect(prompt).toContain("1 person reported this in the last 2 hours");
    expect(prompt).toContain("Do you want to raise another issue, or add yourself to that one?");
  });

  it("own reports, cancelled originals and dismissed originals never prompt; a joined supporter counts toward the original", async () => {
    const f = FIXTURES.find((x) => x.file === "same-issue.json")!;
    // own report
    {
      const { store, memory, incoming } = await setup(f);
      expect(await findSameIssue({ store, memory }, { ...incoming, telegramChatId: "rider-1" })).toBeNull();
    }
    // cancelled original
    {
      const { store, memory, incoming } = await setup(f, { status: "CANCELLED" });
      expect(await findSameIssue({ store, memory }, incoming)).toBeNull();
    }
    // a third rider joined the original: their memory item resolves to the original and is counted
    {
      const { store, memory, original, incoming } = await setup(f);
      const joiner = await store.saveComplaint(subwayDraft("cmp_join", "rider-3", f.incoming, { status: "TRACKING", sameIssueAs: original.id }));
      await memory.remember(sameIssueChoiceItem(joiner, original.id, "join"));
      const m = (await findSameIssue({ store, memory }, incoming))!;
      expect(m.originalId).toBe(original.id);
      expect(m.recentReporters).toBe(2);
    }
  });
});
