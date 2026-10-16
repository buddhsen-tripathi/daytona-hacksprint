import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocationService, looksLikeAddress, withinNyc } from "./location.js";
import { normalizeStreetName, splitIntersection } from "../integrations/geosearch.js";

afterEach(() => vi.unstubAllGlobals());

describe("looksLikeAddress", () => {
  it.each([
    "1515 Broadway",
    "350 5th Ave",
    "123 W 45th St, Manhattan",
    "Broadway & W 45th St",
    "Atlantic Ave and Flatbush Ave",
    "corner of Atlantic Avenue and Flatbush Avenue",
    "W 45th St and 8th Ave, Manhattan",
    "32 4th Avenue Brooklyn",
    "Flatbush Ave, Brooklyn",
    "10036",
    "near 77-12 Roosevelt Ave, Queens",
  ])("accepts %s", (t) => expect(looksLikeAddress(t)).toBe(true));

  it.each([
    "This road is completely broken.",
    "the train is stuck and nobody says why",
    "my street is broken",
    "it's been like this for 3 weeks",
    "yes",
    "Can you report this?",
    "the patch where they dug up the road is sinking and I almost fell",
    "I hit it with my bike and it hurt",
    "",
  ])("rejects %s", (t) => expect(looksLikeAddress(t)).toBe(false));
});

describe("withinNyc", () => {
  it("accepts Times Square, Staten Island, the Bronx", () => {
    expect(withinNyc(40.758, -73.9855)).toBe(true);
    expect(withinNyc(40.5795, -74.1502)).toBe(true);
    expect(withinNyc(40.8448, -73.8648)).toBe(true);
  });
  it("rejects Jersey City-west, Yonkers-north, Long Island, garbage", () => {
    expect(withinNyc(40.75, -74.3)).toBe(false);
    expect(withinNyc(40.95, -73.89)).toBe(false);
    expect(withinNyc(40.75, -73.5)).toBe(false);
    expect(withinNyc(Number.NaN, -73.9)).toBe(false);
  });
});

describe("intersection helpers", () => {
  it("normalizes street names to 311 style", () => {
    expect(normalizeStreetName("W 45th St")).toBe("WEST 45 STREET");
    expect(normalizeStreetName("Flatbush Ave")).toBe("FLATBUSH AVENUE");
    expect(normalizeStreetName("Broadway")).toBe("BROADWAY");
    expect(normalizeStreetName("Fifth Avenue")).toBe("5 AVENUE");
  });
  it("splits intersections", () => {
    expect(splitIntersection("corner of Atlantic Ave and Flatbush Ave, Brooklyn")).toEqual(["Atlantic Ave", "Flatbush Ave"]);
    expect(splitIntersection("Broadway & W 45th St")).toEqual(["Broadway", "W 45th St"]);
    expect(splitIntersection("1515 Broadway")).toBeNull();
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const feature = (lon: number, lat: number, props: Record<string, unknown>) => ({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: props });

describe("createLocationService (mocked fetch)", () => {
  it("fromText returns null for ordinary sentences without calling the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await createLocationService().fromText("the road is completely broken")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fromText geocodes an address via GeoSearch", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(String(url)).toContain("geosearch.planninglabs.nyc/v2/search");
      return jsonResponse({ features: [feature(-73.984348, 40.760208, { label: "1600 BROADWAY, New York, NY, USA", borough: "Manhattan", housenumber: "1600", street: "BROADWAY", confidence: 0.8, layer: "venue" })] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const loc = await createLocationService().fromText("1600 Broadway");
    expect(loc).toMatchObject({ address: "1600 BROADWAY, New York, NY, USA", borough: "Manhattan", source: "text", userConfirmed: true, withinNyc: true, rawInput: "1600 Broadway" });
    expect(loc?.latitude).toBeCloseTo(40.7602);
  });

  it("fromText rejects a GeoSearch guess with a different house number", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ features: [feature(-73.98, 40.76, { label: "24 MAY AVENUE", housenumber: "24", confidence: 0.8, layer: "venue", borough: "Staten Island" })] })));
    expect(await createLocationService().fromText("1600 Broadway")).toBeNull();
  });

  it("fromText resolves intersections through 311 Open Data", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(String(url)).toContain("erm2-nwe9");
      return jsonResponse([{ intersection_street_1: "ATLANTIC AVENUE", intersection_street_2: "FLATBUSH AVENUE", latitude: "40.68405", longitude: "-73.97745", borough: "BROOKLYN" }]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const loc = await createLocationService().fromText("corner of Atlantic Ave and Flatbush Ave");
    expect(loc).toMatchObject({ address: "ATLANTIC AVENUE & FLATBUSH AVENUE, Brooklyn, NY", borough: "Brooklyn", withinNyc: true, source: "text" });
  });

  it("fromPin keeps the pin when reverse geocoding fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const loc = await createLocationService().fromPin(40.758, -73.9855);
    expect(loc).toMatchObject({ latitude: 40.758, longitude: -73.9855, address: null, source: "pin", userConfirmed: true, withinNyc: true });
  });

  it("fromPin reverse geocodes in NYC and flags outside NYC", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ features: [feature(-73.9855, 40.758, { label: "1540 B'WAY, New York, NY, USA", borough: "Manhattan" })] })));
    const svc = createLocationService();
    expect(await svc.fromPin(40.758, -73.9855)).toMatchObject({ address: "1540 B'WAY, New York, NY, USA", borough: "Manhattan" });
    expect(await svc.fromPin(42.65, -73.75)).toMatchObject({ withinNyc: false, address: null, userConfirmed: true });
  });
});
