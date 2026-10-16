import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DUPLICATE_SEARCH } from "../core/contracts.js";
import type { Raw311Record } from "../integrations/nyc-open-data.js";
import { categorySimilarity, createDuplicateService, rankCandidates, scoreRecord, type OpenDataMatch } from "./duplicates.js";

// Open Data mappings of the (currently unregistered) street categories: the scoring stays generic.
const POTHOLE: OpenDataMatch = { complaintType: "Street Condition", descriptors: ["Pothole", "Cave-in", "Rough, Pitted or Cracked Roads"] };
const REPAIR: OpenDataMatch = { complaintType: "Street Condition", descriptors: ["Failed Street Repair", "Pothole"] };
import { createStatusService } from "./status.js";

const records = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../../fixtures/sample-311-records.json"), "utf8")) as Raw311Record[];
const NOW = new Date("2026-10-16T15:00:00Z");
const TIMES_SQ = { latitude: 40.758, longitude: -73.9855 };

afterEach(() => vi.unstubAllGlobals());

const rec = (over: Partial<Raw311Record>): Raw311Record => ({
  unique_key: "1",
  created_date: "2026-10-15T15:00:00.000",
  complaint_type: "Street Condition",
  descriptor: "Pothole",
  status: "Open",
  latitude: String(TIMES_SQ.latitude),
  longitude: String(TIMES_SQ.longitude),
  ...over,
});

describe("categorySimilarity", () => {
  it("1.0 exact descriptor, 0.6 other street-surface descriptor, 0.2 otherwise", () => {
    expect(categorySimilarity(POTHOLE, { complaint_type: "Street Condition", descriptor: "Pothole" })).toBe(1);
    expect(categorySimilarity(POTHOLE, { complaint_type: "Street Condition", descriptor: "Cave-in" })).toBe(1);
    expect(categorySimilarity(POTHOLE, { complaint_type: "Street Condition", descriptor: "Failed Street Repair" })).toBe(0.6);
    expect(categorySimilarity(REPAIR, { complaint_type: "Street Condition", descriptor: "Failed Street Repair" })).toBe(1);
    expect(categorySimilarity(POTHOLE, { complaint_type: "Street Condition", descriptor: "Plate Condition - Shifted" })).toBe(0.6);
    expect(categorySimilarity(POTHOLE, { complaint_type: "Street Condition", descriptor: "Blocked - Construction" })).toBe(0.2);
    expect(categorySimilarity(POTHOLE, { complaint_type: "Noise - Street/Sidewalk", descriptor: "Pothole" })).toBe(0.2);
  });
});

describe("scoreRecord", () => {
  it("same spot, same descriptor, yesterday ⇒ near 1", () => {
    const c = scoreRecord(rec({}), { category: POTHOLE, ...TIMES_SQ, now: NOW })!;
    expect(c.distanceMeters).toBe(0);
    expect(c.scoreBreakdown.location).toBe(1);
    expect(c.scoreBreakdown.category).toBe(1);
    expect(c.scoreBreakdown.recency).toBeCloseTo(1 - 1 / 90, 2);
    expect(c.matchScore).toBeCloseTo(0.45 + 0.35 + 0.2 * (1 - 1 / 90), 2);
  });
  it("location similarity decays over radiusMeters; dropped beyond broadRadius", () => {
    // ~25 m north
    const c = scoreRecord(rec({ latitude: String(TIMES_SQ.latitude + 0.000225) }), { category: POTHOLE, ...TIMES_SQ, now: NOW })!;
    expect(c.distanceMeters!).toBeGreaterThan(24);
    expect(c.scoreBreakdown.location).toBeCloseTo(0.5, 1);
    // ~100 m: kept with location 0
    expect(scoreRecord(rec({ latitude: String(TIMES_SQ.latitude + 0.0009) }), { category: POTHOLE, ...TIMES_SQ, now: NOW })!.scoreBreakdown.location).toBe(0);
    // ~200 m: dropped
    expect(scoreRecord(rec({ latitude: String(TIMES_SQ.latitude + 0.0018) }), { category: POTHOLE, ...TIMES_SQ, now: NOW })).toBeNull();
    // no coordinates: dropped
    expect(scoreRecord(rec({ latitude: undefined }), { category: POTHOLE, ...TIMES_SQ, now: NOW })).toBeNull();
  });
  it("recency hits 0 at recencyDays", () => {
    const c = scoreRecord(rec({ created_date: "2026-07-01T00:00:00.000" }), { category: POTHOLE, ...TIMES_SQ, now: NOW })!;
    expect(c.scoreBreakdown.recency).toBe(0);
    expect(c.ageDays).toBeGreaterThan(DUPLICATE_SEARCH.recencyDays);
  });
});

describe("rankCandidates on real fixture rows", () => {
  it("Times Square: the 4 m-away SR ranks first; far/old/low-score rows filtered", () => {
    const { candidates, dataAsOf } = rankCandidates(records, { category: POTHOLE, ...TIMES_SQ, now: NOW });
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(candidates.length).toBeLessThanOrEqual(DUPLICATE_SEARCH.maxCandidates);
    expect(candidates[0].uniqueKey).toBe("70339080");
    expect(candidates[0].distanceMeters!).toBeLessThan(10);
    for (const c of candidates) expect(c.matchScore).toBeGreaterThanOrEqual(DUPLICATE_SEARCH.minScore);
    for (let i = 1; i < candidates.length; i++) expect(candidates[i - 1].matchScore).toBeGreaterThanOrEqual(candidates[i].matchScore);
    const maxCreated = records.map((r) => r.created_date).sort().at(-1);
    expect(dataAsOf).toBe(maxCreated);
  });
  it("Brooklyn block: nothing within 150 m of Times Square leaks in", () => {
    const { candidates } = rankCandidates(records, { category: POTHOLE, ...TIMES_SQ, now: NOW });
    expect(candidates.every((c) => (c.latitude ?? 0) > 40.75)).toBe(true);
  });
  it("Brooklyn pin matches the Brooklyn SR", () => {
    const { candidates } = rankCandidates(records, { category: POTHOLE, latitude: 40.683127, longitude: -73.979185, now: NOW });
    expect(candidates[0]?.uniqueKey).toBe("70534098");
  });
});

describe("createDuplicateService (mocked fetch)", () => {
  it("returns unavailable on any error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 503 })));
    expect(await createDuplicateService().findPotentialDuplicates({ category: "subway-delay", ...TIMES_SQ })).toEqual({ candidates: [], dataAsOf: null, source: "unavailable" });
  });
  it("lookupStatus by unique_key", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      expect(new URL(url).searchParams.get("$where")).toBe("unique_key='70339080'");
      return new Response(JSON.stringify(records.filter((r) => r.unique_key === "70339080")), { status: 200 });
    }));
    const c = await createDuplicateService().lookupStatus("70339080");
    expect(c).toMatchObject({ uniqueKey: "70339080", status: "Closed", descriptor: "Pothole" });
  });
});

describe("createStatusService", () => {
  it("does not treat non-numeric references as NYC311 numbers (no fetch)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const r = await createStatusService().lookup("MTA-CASE-ABC");
    expect(r).toMatchObject({ status: null, source: "unknown" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("unknown when Open Data has no record", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
    const r = await createStatusService().lookup("12345678", { target: "real" });
    expect(r).toMatchObject({ status: null, source: "unknown" });
  });
  it("open-data status for real SRs", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(records.filter((r) => r.unique_key === "70339080")), { status: 200 })));
    const r = await createStatusService().lookup("70339080", { target: "real" });
    expect(r).toMatchObject({ sr: "70339080", status: "Closed", source: "open-data" });
  });
});
