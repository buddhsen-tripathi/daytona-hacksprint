import { describe, expect, it } from "vitest";
import { CatalogEntry } from "../core/contracts.js";
import {
  agencyFromName,
  agencyFromProse,
  agencyFromUrl,
  assignUniqueIds,
  buildCatalogEntry,
  channelForUrl,
  extractPhone,
  fileableCatalogEntries,
  filingScore,
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
    expect(e.hasCaptcha).toBe(false);
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
