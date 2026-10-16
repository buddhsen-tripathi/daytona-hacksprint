import { describe, expect, it } from "vitest";
import type { ClassificationResult } from "../core/contracts.js";
import { getCatalogEntry, searchCatalog, stem, tokenize } from "./catalog.js";
import { catalogCandidates, PHOTO_ONLY_CANDIDATES, validateRoute } from "./classifier.js";

const base = (over: Partial<ClassificationResult> = {}): ClassificationResult => ({
  triage: "OUT_OF_SCOPE",
  category: null,
  confidence: 0.9,
  description: "Loud music from a neighbor at night.",
  rationale: "noise",
  alternativeConsidered: null,
  safetyFlags: [],
  clarifyingQuestion: null,
  transit: null,
  route: { catalogId: "noise-from-neighbor", confidence: 0.92, rationale: "neighbor noise", alternatives: ["noise-complaints"] },
  ...over,
});

describe("catalog retrieval (stage 1)", () => {
  it("tokenizes and stems", () => {
    expect(tokenize("The complaints about parking")).toEqual(["complaint", "park"]);
    expect(stem("hazards")).toBe("hazard");
  });

  it.each([
    ["noise from my neighbor at 2am", "noise-from-neighbor"],
    ["rats in the backyard", "rat-or-mouse-complaint"],
    ["LIRR train was late", "long-island-rail-road"],
    ["The sidewalk is cracked and lifted, someone tripped on it", "broken-sidewalk"],
    ["The storm drain on the corner is clogged", "catch-basin-complaint"],
  ])("%s → %s in the top 10", (q, id) => {
    expect(searchCatalog(q, 10).map((h) => h.entry.id)).toContain(id);
  });

  it("returns nothing for empty text", () => expect(searchCatalog("", 10)).toEqual([]));

  it("always offers fileable categories; photo-only reports get the photo set", () => {
    const text = catalogCandidates({ text: "graffiti on my wall", imagePaths: [], conversation: [], priorDescription: null, locationKnown: false }).map((e) => e.id);
    expect(text).toContain("graffiti");
    expect(text).toContain("subway-delay");
    const photo = catalogCandidates({ text: null, imagePaths: ["x.jpg"], conversation: [], priorDescription: null, locationKnown: false }).map((e) => e.id);
    expect(photo).toEqual(expect.arrayContaining(PHOTO_ONLY_CANDIDATES));
    for (const id of PHOTO_ONLY_CANDIDATES) expect(getCatalogEntry(id), id).not.toBeNull();
  });
});

describe("validateRoute (stage 2 allowlist)", () => {
  it("keeps a valid pick", () => {
    expect(validateRoute(base())).toMatchObject({ catalogId: "noise-from-neighbor", alternatives: ["noise-complaints"] });
  });

  it("drops ids that are not in the catalog and dedupes alternatives (max 3)", () => {
    const r = validateRoute(base({ route: { catalogId: "made-up-id", confidence: 0.9, rationale: "", alternatives: ["noise-complaints", "noise-complaints", "nope", "graffiti", "dead-tree", "illegal-parking"] } }));
    expect(r).toMatchObject({ catalogId: null, confidence: 0, alternatives: ["noise-complaints", "graffiti", "dead-tree"] });
  });

  it("uses the category itself for SUPPORTED fileable reports", () => {
    expect(validateRoute(base({ triage: "SUPPORTED", category: "subway-delay", route: null }))?.catalogId).toBe("subway-delay");
  });

  it("never routes an emergency", () => {
    expect(validateRoute(base({ triage: "EMERGENCY" }))).toBeNull();
  });
});
