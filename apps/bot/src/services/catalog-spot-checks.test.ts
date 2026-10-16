import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CatalogEntry } from "../core/contracts.js";
import { REPO_ROOT } from "../integrations/env.js";

type SpotCheck = {
  id: string;
  kaNumber: string;
  channel: string;
  agency: string | null;
  automation: string;
  officialUrlPrefix: string | null;
  hasCaptcha: boolean | null;
  emergency?: boolean;
};

const read = <T>(rel: string): T => JSON.parse(readFileSync(resolve(REPO_ROOT, rel), "utf8")) as T;
const catalog = read<unknown[]>("fixtures/nyc311-catalog.json").map((e) => CatalogEntry.parse(e));
const spot = read<{ entries: SpotCheck[] }>("fixtures/catalog-spot-checks.json").entries;
const byId = new Map(catalog.map((e) => [e.id, e]));

describe("fixtures/nyc311-catalog.json", () => {
  it("is a full, valid snapshot sorted by unique id", () => {
    expect(catalog.length).toBeGreaterThan(600);
    const ids = catalog.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
  });

  it("keeps subway-delay as the fileable adapter row", () => {
    expect(byId.get("subway-delay")).toMatchObject({ automation: "adapter:mta-subway-delay", agency: "MTA", requiredFields: ["transit", "description"] });
  });

  it("only offers automation where there is an official link", () => {
    for (const e of catalog) if (e.automation !== "none") expect(e.officialUrl, e.id).not.toBeNull();
  });
});

describe("fixtures/catalog-spot-checks.json (hand-verified entries)", () => {
  it("has 18 entries (15 from #7 minus the KA-01014 duplicate, plus 4 #28 cases)", () => expect(spot).toHaveLength(18));

  it("has one row per KA number and flags Call 911 articles as emergencies (#28)", () => {
    const kas = catalog.map((e) => e.kaNumber);
    expect(new Set(kas).size).toBe(kas.length);
    for (const e of catalog) if (e.emergency) expect(e.automation, e.id).toBe("none");
    expect(catalog.filter((e) => e.emergency).length).toBeGreaterThan(30);
    for (const s of spot) expect(byId.get(s.id)?.emergency ?? false, s.id).toBe(s.emergency ?? false);
  });

  it.each(spot.map((s) => [s.id, s] as const))("%s matches the snapshot", (_id, s) => {
    const e = byId.get(s.id);
    expect(e, s.id).toBeDefined();
    expect({ kaNumber: e!.kaNumber, channel: e!.channel, agency: e!.agency, automation: e!.automation }).toEqual({
      kaNumber: s.kaNumber,
      channel: s.channel,
      agency: s.agency,
      automation: s.automation,
    });
    // null = not probed when verified; a later crawl may learn it.
    if (s.hasCaptcha !== null) expect(e!.hasCaptcha).toBe(s.hasCaptcha);
    if (s.officialUrlPrefix === null) expect(e!.officialUrl).toBeNull();
    else expect(e!.officialUrl?.startsWith(s.officialUrlPrefix)).toBe(true);
  });
});
