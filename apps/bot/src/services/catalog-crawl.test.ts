import { describe, expect, it } from "vitest";
import { CatalogEntry } from "../core/contracts.js";
import {
  agencyFromName,
  agencyFromProse,
  agencyFromUrl,
  assignUniqueIds,
  buildCatalogEntry,
  carryForwardIds,
  channelForUrl,
  extractPhone,
  fileableCatalogEntries,
  filingScore,
  isEmergencyArticle,
  isExtractionFailed,
  isGenericNav,
  mergeCatalog,
  parseServiceRequestCall,
  type RawArticle,
  serviceRequestUrl,
  slugify,
} from "./catalog-crawl.js";

const NOW = "2026-10-16T15:00:00.000Z";
const CAID = "776193b4-756e-e811-a971-000d3a34ed47";
const KASID = "7d13d3ce-7cc9-f011-bbd2-000d3a9c0020";
const srCall = (agency: string) =>
  `javascript:createServiceRequest('','${CAID}', '6513d3ce-7cc9-f011-bbd2-000d3a9c0020', '','${agency}','${KASID}');`;

const srArticle = (agency: string): RawArticle => ({
  kaNumber: "KA-01234",
  title: "Noise from Bar, Club, or Restaurant",
  cards: [
    {
      title: null,
      text: "You can report loud music or talking from a bar.",
      links: [{ cls: "contentaction btn btn-link", text: "Report noise", href: "#", onclick: srCall(agency) }],
    },
  ],
});

describe("parseServiceRequestCall", () => {
  it("extracts caid, kasid and agency", () => {
    expect(parseServiceRequestCall(srCall("NYPD"))).toEqual({ caid: CAID, kasid: KASID, agency: "NYPD" });
  });
  it("returns null for garbage or null", () => {
    expect(parseServiceRequestCall("javascript:void(0)")).toBeNull();
    expect(parseServiceRequestCall(null)).toBeNull();
  });
});

describe("serviceRequestUrl", () => {
  it("builds a direct link for direct-create agencies", () => {
    expect(serviceRequestUrl({ caid: CAID, kasid: KASID, agency: "NYPD" })).toBe(
      `https://portal.311.nyc.gov/servicerequest-create/?caid=${CAID}&kasid=${KASID}`,
    );
  });
  it("returns null for postback-only agencies", () => {
    expect(serviceRequestUrl({ caid: CAID, kasid: KASID, agency: "HPD" })).toBeNull();
  });
});

describe("channelForUrl", () => {
  it("classifies links", () => {
    expect(channelForUrl(`https://portal.311.nyc.gov/servicerequest-create/?caid=${CAID}`)).toBe("nyc311-sr-form");
    expect(channelForUrl("https://portal.311.nyc.gov/article/?kanumber=KA-01234")).toBeNull();
    expect(channelForUrl("https://www.nyc.gov/site/dfta/contact/complaint.page")).toBe("agency-form");
    expect(channelForUrl("https://contact.mta.info/s/customer-feedback")).toBe("external-site");
    expect(channelForUrl("mailto:help@example.com")).toBeNull();
  });
});

describe("agency helpers", () => {
  it("agencyFromUrl", () => {
    expect(agencyFromUrl("https://www.nyc.gov/site/doh/services/complaint.page")).toBe("DOHMH");
    expect(agencyFromUrl("https://new.mta.info/contact")).toBe("MTA");
  });
  it("agencyFromName", () => {
    expect(agencyFromName("Metropolitan Transportation Authority")).toBe("MTA");
    expect(agencyFromName("Some Unknown Office")).toBe("Some Unknown Office");
  });
  it("agencyFromProse picks the earliest named agency", () => {
    expect(agencyFromProse("The Department of Finance (DOF) collects fines. Contact the Department of Buildings for permits.")).toBe("DOF");
  });
});

describe("text helpers", () => {
  it("extractPhone", () => {
    expect(extractPhone("Agency: MTA Phone Number: 511")).toBe("511");
    expect(extractPhone("Call 311 or visit the website.")).toBe("311");
  });
  it("filingScore", () => {
    expect(filingScore("Report illegal parking.")).toBe(3);
    expect(filingScore("Submit a Reduced-Fare MetroCard claim form.")).toBe(2);
    expect(filingScore("Learn more about X")).toBe(0);
    expect(filingScore("Street Lighting Repair Form")).toBe(1);
  });
  it("slugify", () => {
    expect(slugify("Noise from Bar, Club, or Restaurant")).toBe("noise-from-bar-club-or-restaurant");
    expect(slugify("Cash & Expenses")).toBe("cash-and-expenses");
  });
});

describe("buildCatalogEntry", () => {
  const ctx = { topic: "Noise", summary: null, probe: null, now: NOW };

  it("direct SR action → nyc311-sr-form with direct link and probe values", () => {
    const e = buildCatalogEntry(srArticle("NYPD"), {
      ...ctx,
      probe: { finalUrl: "https://portal.311.nyc.gov/servicerequest-create/", hasCaptcha: false, requiresLogin: true },
    });
    expect(CatalogEntry.parse(e)).toEqual(e);
    expect(e.id).toBe("noise-from-bar-club-or-restaurant");
    expect(e.channel).toBe("nyc311-sr-form");
    expect(e.officialUrl).toBe(`https://portal.311.nyc.gov/servicerequest-create/?caid=${CAID}&kasid=${KASID}`);
    expect(e.agency).toBe("NYPD");
    expect(e.automation).toBe("handoff");
    // Page 1 of an SR form shows no CAPTCHA; a later step might → unknown (#28).
    expect(e.hasCaptcha).toBeNull();
    expect(e.requiresLogin).toBe(true);
  });

  it("postback-only SR action → article is the official link, not probed", () => {
    const e = buildCatalogEntry(srArticle("HPD"), {
      ...ctx,
      probe: { finalUrl: "x", hasCaptcha: true, requiresLogin: true },
    });
    expect(CatalogEntry.parse(e)).toEqual(e);
    expect(e.channel).toBe("nyc311-sr-form");
    expect(e.officialUrl).toBe("https://portal.311.nyc.gov/article/?kanumber=KA-01234");
    expect(e.agency).toBe("HPD");
    expect(e.hasCaptcha).toBeNull();
    expect(e.requiresLogin).toBeNull();
  });

  it("phone-only article", () => {
    const raw: RawArticle = { kaNumber: "KA-00001", title: "Phone Thing", cards: [{ title: null, text: "Call 311 to report the problem.", links: [] }] };
    const e = buildCatalogEntry(raw, ctx);
    expect(CatalogEntry.parse(e)).toEqual(e);
    expect(e.channel).toBe("phone-only");
    expect(e.automation).toBe("none");
    expect(e.officialUrl).toBeNull();
  });

  it("info-only article", () => {
    const raw: RawArticle = { kaNumber: "KA-00002", title: "Info Thing", cards: [{ title: null, text: "General information.", links: [] }] };
    const e = buildCatalogEntry(raw, ctx);
    expect(CatalogEntry.parse(e)).toEqual(e);
    expect(e.channel).toBe("info-only");
    expect(e.automation).toBe("none");
    expect(e.officialUrl).toBeNull();
  });
});

describe("assignUniqueIds", () => {
  it("suffixes clashing slugs with the KA number", () => {
    const ctx = { topic: null, summary: null, probe: null, now: NOW };
    const a = buildCatalogEntry({ kaNumber: "KA-00010", title: "Noise", cards: [] }, ctx);
    const b = buildCatalogEntry({ kaNumber: "KA-00011", title: "Noise", cards: [] }, ctx);
    const c = buildCatalogEntry({ kaNumber: "KA-00012", title: "Other", cards: [] }, ctx);
    expect(assignUniqueIds([a, b, c]).map((e) => e.id)).toEqual(["noise-ka-00010", "noise-ka-00011", "other"]);
  });
});

describe("fileableCatalogEntries", () => {
  it("emits the subway-delay adapter entry", () => {
    const entries = fileableCatalogEntries(NOW);
    expect(entries).toHaveLength(1);
    const [e] = entries;
    expect(CatalogEntry.parse(e)).toEqual(e);
    expect(e.id).toBe("subway-delay");
    expect(e.automation).toBe("adapter:mta-subway-delay");
    expect(e.requiredFields).toEqual(["transit", "description"]);
    expect(e.lastVerifiedAt).toBe(NOW);
  });
});

describe("mergeCatalog (#28)", () => {
  it("dedupes by KA number, keeping the fileable row", () => {
    const fileable = fileableCatalogEntries(NOW);
    const ka = fileable[0].kaNumber;
    const base = buildCatalogEntry(srArticle("NYPD"), { topic: null, summary: null, probe: null, now: NOW });
    const merged = mergeCatalog(fileable, [{ ...base, id: "buses-and-subways", kaNumber: ka }, base]);
    expect(merged.filter((e) => e.kaNumber === ka).map((e) => e.id)).toEqual([fileable[0].id]);
    expect(merged.map((e) => e.id)).toContain("noise-from-bar-club-or-restaurant");
  });
});

describe("filing link selection (#28)", () => {
  const ctx = { topic: null, summary: null, probe: null, now: NOW };
  const ext = (text: string, href: string) => ({ cls: "externallink", text, href, onclick: null });
  const art = (cards: RawArticle["cards"]): RawArticle => ({ kaNumber: "KA-09999", title: "X", cards });

  it("finds a 'Repair Form' link (street-light-complaint)", () => {
    const e = buildCatalogEntry(
      art([
        { title: null, text: "Report a street light problem.", links: [] },
        { title: "Report Street Light Conditions", text: "", links: [ext("Street Lighting Repair Form", "https://service.nyctmc.org/alias3/main.asp")] },
      ]),
      ctx,
    );
    expect(e).toMatchObject({ channel: "external-site", officialUrl: "https://service.nyctmc.org/alias3/main.asp", automation: "handoff" });
  });

  it("prefers the intro's link over an equally worded one in another complaint section (gym)", () => {
    const e = buildCatalogEntry(
      art([
        { title: null, text: "", links: [ext("Report a problem with a gym or health spa membership.", "https://www.nyc.gov/site/dca/consumers/file-complaint.page")] },
        { title: '"Click to Cancel" Complaint', text: "", links: [ext('File a "Click to Cancel" complaint against a gym.', "https://www.nyc.gov/main/click-to-cancel")] },
      ]),
      ctx,
    );
    expect(e.officialUrl).toBe("https://www.nyc.gov/site/dca/consumers/file-complaint.page");
  });

  it("never picks generic navigation (find-a-school, dog license lookup)", () => {
    expect(isGenericNav("https://www.schools.nyc.gov/find-a-school")).toBe(true);
    expect(isGenericNav("https://a816-healthpsi.nyc.gov/DogLicense/")).toBe(true);
    expect(isGenericNav("https://www.nyc.gov/site/dca/consumers/file-complaint.page")).toBe(false);
    const e = buildCatalogEntry(
      art([{ title: "Reporting a Student Absence", text: "", links: [ext("Contact your school.", "https://www.schools.nyc.gov/find-a-school")] }]),
      ctx,
    );
    expect(e.officialUrl).toBeNull();
  });
});

describe("emergency (Call 911) articles (#28)", () => {
  const ctx = { topic: null, summary: null, probe: null, now: NOW };
  const banner = (cards: RawArticle["cards"], emergencyBanner = true): RawArticle => ({ kaNumber: "KA-02048", title: "Gas Leak", cards, emergencyBanner });

  it("a 911 banner with no filing route is an emergency with automation none", () => {
    const raw = banner([{ title: null, text: "", links: [] }]);
    expect(isEmergencyArticle(raw)).toBe(true);
    const e = buildCatalogEntry(raw, ctx);
    expect(e).toMatchObject({ emergency: true, automation: "none", officialUrl: null });
    expect(CatalogEntry.parse(e).emergency).toBe(true);
  });

  it("an intro that opens with 'Call 911' is an emergency", () => {
    expect(isEmergencyArticle(banner([{ title: null, text: "Call 911 if you smell gas.", links: [] }], false))).toBe(true);
  });

  it("a banner next to an SR form is not an emergency (it only says 'if it is an emergency…')", () => {
    const raw = { ...srArticle("NYPD"), emergencyBanner: true };
    expect(isEmergencyArticle(raw)).toBe(false);
    expect(buildCatalogEntry(raw, ctx)).toMatchObject({ emergency: false, automation: "handoff" });
  });

  it("emergency defaults to false for rows written before #28", () => {
    const { emergency: _e, ...old } = buildCatalogEntry(srArticle("NYPD"), ctx);
    expect(CatalogEntry.parse(old).emergency).toBe(false);
  });
});

describe("carryForwardIds (#28)", () => {
  const ctx = { topic: null, summary: null, probe: null, now: NOW };
  const entry = (ka: string, title: string) => buildCatalogEntry({ kaNumber: ka, title, cards: [] }, ctx);

  it("keeps the previous id for a retitled KA", () => {
    const out = carryForwardIds([entry("KA-00010", "Street Light Out (Renamed)"), entry("KA-00011", "Other")], [
      { id: "street-light-out", kaNumber: "KA-00010" },
    ]);
    expect(out.map((e) => e.id)).toEqual(["street-light-out", "other"]);
  });

  it("suffixes a new slug that collides with a carried id", () => {
    const out = carryForwardIds([entry("KA-00020", "Noise"), entry("KA-00010", "Noise Renamed")], [{ id: "noise", kaNumber: "KA-00010" }]);
    expect(out.map((e) => e.id)).toEqual(["noise-ka-00020", "noise"]);
  });

  it("is a no-op with no previous snapshot", () => {
    const es = [entry("KA-00010", "A"), entry("KA-00011", "B")];
    expect(carryForwardIds(es, [])).toEqual(es);
  });
});

describe("isExtractionFailed (#28)", () => {
  it("flags empty pages without a 911 banner, explicit flags and missing titles", () => {
    expect(isExtractionFailed({ kaNumber: "KA-01591", title: "Noise", cards: [{ title: null, text: "", links: [] }] })).toBe(true);
    expect(isExtractionFailed({ kaNumber: "KA-1", title: "X", cards: [] })).toBe(true);
    expect(isExtractionFailed({ ...srArticle("NYPD"), extractionFailed: true })).toBe(true);
    expect(isExtractionFailed({ ...srArticle("NYPD"), title: "" })).toBe(true);
  });

  it("accepts real articles and bare Call 911 pages", () => {
    expect(isExtractionFailed(srArticle("NYPD"))).toBe(false);
    expect(isExtractionFailed({ kaNumber: "KA-02048", title: "Gas Leak", cards: [{ title: null, text: "", links: [] }], emergencyBanner: true })).toBe(
      false,
    );
  });
});
