/**
 * Pure helpers for the NYC311 catalog crawler (#7, scripts/crawl-311-catalog.ts).
 * No browser, no IO: the script extracts a RawArticle from each page and this
 * module turns it into a CatalogEntry, so the rules are unit-testable.
 *
 * Portal facts these rules rely on (observed on portal.311.nyc.gov, Oct 2026):
 * - Every NYC311 service-request button is `a.contentaction` calling
 *   createServiceRequest(srformid, caid, kaid, stepid, agencycode, kasectionid).
 * - For DIRECT_CREATE_AGENCIES that call is a plain GET to
 *   /servicerequest-create/?caid=…&kasid=…; for every other agency it is a
 *   postback that creates a draft record server-side, so the crawler never
 *   triggers it and the article itself is the official link.
 * - Outbound links are `a.externallink`; links to other articles are `a.kalink`.
 */
import { CATEGORIES, type CatalogChannel, type CatalogEntry, type CategoryId } from "../core/contracts.js";

export const PORTAL = "https://portal.311.nyc.gov";

/** From the portal's createServiceRequest(): agencies whose SR form opens with a plain GET. */
export const DIRECT_CREATE_AGENCIES = new Set(["OTI", "DPR", "DEP", "EDC", "DOT", "OOS", "NYPD", "DHS", "DSNY"]);

export type RawLink = { cls: string; text: string; href: string | null; onclick: string | null };
/** One accordion card of an article. `title` is null for the always-open intro card. */
export type RawCard = { title: string | null; text: string; links: RawLink[] };
/**
 * `emergencyBanner`: the page shows the red "Call 911" .divTable banner (stripped from card text).
 * Absent on articles cached before #28.
 */
export type RawArticle = { kaNumber: string; title: string; cards: RawCard[]; emergencyBanner?: boolean };
/** Result of opening an official link once (GET only). */
export type LandingProbe = { finalUrl: string; hasCaptcha: boolean; requiresLogin: boolean };

export type ServiceRequestCall = { caid: string; kasid: string; agency: string | null };

export function articleUrl(kaNumber: string): string {
  return `${PORTAL}/article/?kanumber=${kaNumber}`;
}

export function parseServiceRequestCall(js: string | null): ServiceRequestCall | null {
  if (!js) return null;
  const m = js.match(/createServiceRequest\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'/);
  if (!m) return null;
  return { caid: m[2], kasid: m[6], agency: m[5] || null };
}

/** The direct SR link, or null when the portal only starts this SR through a postback. */
export function serviceRequestUrl(call: ServiceRequestCall): string | null {
  if (!call.agency || !DIRECT_CREATE_AGENCIES.has(call.agency) || !call.caid || !call.kasid) return null;
  return `${PORTAL}/servicerequest-create/?caid=${call.caid}&kasid=${call.kasid}`;
}

/** Channel of an outbound link, or null when it is not a filing destination (another 311 article, mailto, …). */
export function channelForUrl(url: string): CatalogChannel | null {
  let u: URL;
  try {
    u = new URL(url, PORTAL);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  if (host === "portal.311.nyc.gov") return /^\/(servicerequest-create|sr-step)\b/.test(u.pathname) ? "nyc311-sr-form" : null;
  if (host === "nyc.gov" || host.endsWith(".nyc.gov")) return "agency-form";
  return "external-site";
}

/** Agency codes for names that appear in articles' "Agency:" lines. */
const AGENCY_NAMES: [RegExp, string][] = [
  [/Metropolitan Transportation Authority|\bMTA\b/i, "MTA"],
  [/Housing Preservation and Development/i, "HPD"],
  [/Department of Buildings/i, "DOB"],
  [/Health and Mental Hygiene|NYC Health Department/i, "DOHMH"],
  [/City Clerk/i, "City Clerk"],
  [/Department of Transportation/i, "DOT"],
  [/Department of Sanitation/i, "DSNY"],
  [/Environmental Protection/i, "DEP"],
  [/Parks and Recreation/i, "DPR"],
  [/Police Department|\bNYPD\b/i, "NYPD"],
  [/Fire Department|\bFDNY\b/i, "FDNY"],
  [/Consumer and Worker Protection/i, "DCWP"],
  [/Taxi and Limousine Commission/i, "TLC"],
  [/Department of Finance/i, "DOF"],
  [/Department of Education|Public Schools/i, "DOE"],
  [/Homeless Services/i, "DHS"],
  [/Human Resources Administration|Social Services/i, "HRA"],
  [/Housing Authority|\bNYCHA\b/i, "NYCHA"],
  [/Office of Technology and Innovation/i, "OTI"],
  [/Department of Correction/i, "DOC"],
  [/Department for the Aging|NYC Aging/i, "DFTA"],
  [/Youth and Community Development/i, "DYCD"],
  [/Design and Construction/i, "DDC"],
  [/Small Business Services/i, "SBS"],
  [/Administration for Children's Services|Children's Services/i, "ACS"],
  [/Landmarks Preservation/i, "LPC"],
  [/Port Authority/i, "PANYNJ"],
  [/Con Edison|Consolidated Edison/i, "Con Edison"],
  [/National Grid/i, "National Grid"],
];

export function agencyFromName(name: string | null): string | null {
  if (!name) return null;
  const clean = name.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  for (const [re, code] of AGENCY_NAMES) if (re.test(clean)) return code;
  return clean;
}

/** The agency named earliest in prose ("The Department of Buildings issues violations…"), or null. */
export function agencyFromProse(text: string): string | null {
  let best: { at: number; code: string } | null = null;
  for (const [re, code] of AGENCY_NAMES) {
    const m = re.exec(text);
    if (m && (!best || m.index < best.at)) best = { at: m.index, code };
  }
  return best?.code ?? null;
}

/** nyc.gov/site/<agency>/… → agency code; a few well-known non-City hosts. */
export function agencyFromUrl(url: string | null): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url, PORTAL);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (/(^|\.)mta(nyc)?\.info$|mtanyct\.info$/.test(host)) return "MTA";
  if (host.endsWith("coned.com")) return "Con Edison";
  if (host.endsWith("nycha.info")) return "NYCHA";
  const site = (host === "nyc.gov" || host === "www.nyc.gov") && u.pathname.match(/^\/(?:site|html)\/([a-z0-9]+)\//i);
  if (site) {
    const code = site[1].toUpperCase();
    return { DOH: "DOHMH", PARKS: "DPR", NYPD: "NYPD", FDNY: "FDNY", DCA: "DCWP", DCWP: "DCWP", DSNY: "DSNY", DOT: "DOT" }[code] ?? code;
  }
  return null;
}

/** "Agency: Metropolitan Transportation Authority" in an article's "By Phone" block. */
export function agencyNameFromText(text: string): string | null {
  const m = text.match(/Agency:\s*([^\n]+?)(?:\s+Division:|\s+Phone Number:|\n|$)/);
  return m ? m[1].trim() : null;
}

/** First phone route in the text: "Phone Number: 511", tel: links, or "call 311". */
export function extractPhone(text: string, links: RawLink[] = []): string | null {
  const labelled = text.match(/Phone Number:\s*([()\d][\d()\s.-]{1,18}\d)/);
  if (labelled) return labelled[1].replace(/\s+/g, " ").trim();
  const tel = links.find((l) => l.href?.startsWith("tel:"));
  if (tel) return tel.text.trim() || tel.href!.slice(4);
  if (/\bcall 311\b/i.test(text)) return "311";
  return null;
}

/** How strongly a link's text says "this is where you file". 0 = not a filing link. */
export function filingScore(text: string): number {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t || /^(learn|visit|get |read|see |find|view|download|watch|check|look up|call)/i.test(t)) return 0;
  if (/^(report|file|complain|make a complaint|register a complaint)/i.test(t)) return 3;
  if (/^(submit|request|apply)/i.test(t)) return 2;
  // "Street Lighting Repair Form", "Service request portal", …: the link names the form itself.
  if (/\b(report|file|submit|complaint|complain|apply|feedback|claim|contact|form|repair|request)\b/i.test(t)) return 1;
  return 0;
}

/**
 * Generic navigation targets that are never the filing route for the article they appear on
 * (#28: "Contact your school" → find-a-school, lost pet → dog-license lookup, …).
 */
const NAV_DENYLIST: RegExp[] = [
  /schools\.nyc\.gov\/find-a-school/i,
  /\/locations-and-hours\/?/i,
  /a816-healthpsi\.nyc\.gov\/DogLicense/i,
  /^https?:\/\/(www\.)?nyc\.gov\/?(\?.*)?$/i,
  /^https?:\/\/(www\.)?nyc\.gov\/(main\/)?(services|agencies|home|index\.page)\b/i,
  /\/contact-us\b|\/contact\.page\b/i,
];

export function isGenericNav(url: string): boolean {
  return NAV_DENYLIST.some((re) => re.test(url));
}

/** The always-open intro and "File a Complaint" / "Report …" sections hold the article's own filing route. */
export function isFilingSection(title: string | null): boolean {
  return title === null || /^(file|report|submit|make)\b|complaint$/i.test(title.replace(/["“”]/g, "").trim());
}

export function slugify(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export type ReportLink = { kind: "sr" | "external"; url: string | null; agency: string | null; text: string };

/** Every filing route on the article, best first: SR actions (direct link first), then outbound links by filingScore. */
export function findReportLinks(raw: RawArticle): ReportLink[] {
  const sr: ReportLink[] = [];
  const ext: (ReportLink & { score: number })[] = [];
  for (const card of raw.cards) {
    for (const l of card.links) {
      const call = l.cls.includes("contentaction") ? parseServiceRequestCall(l.onclick ?? l.href) : null;
      if (call) {
        sr.push({ kind: "sr", url: serviceRequestUrl(call), agency: call.agency, text: l.text });
        continue;
      }
      if (!l.cls.includes("externallink") || !l.href) continue;
      // A link in the intro or a "File a Complaint" / "Report …" section beats an equally worded one elsewhere.
      const base = filingScore(l.text);
      const score = base && base + (isFilingSection(card.title) ? 1 : 0);
      if (score > 0 && channelForUrl(l.href) && !isGenericNav(new URL(l.href, PORTAL).href)) ext.push({ kind: "external", url: new URL(l.href, PORTAL).href, agency: agencyFromUrl(l.href), text: l.text, score });
    }
  }
  sr.sort((a, b) => Number(b.url !== null) - Number(a.url !== null));
  ext.sort((a, b) => b.score - a.score);
  return [...sr, ...ext.map(({ score: _s, ...l }) => l)];
}

/** The one URL per article the crawler may open (GET) to check CAPTCHA / login. */
export function probeTarget(raw: RawArticle): string | null {
  return findReportLinks(raw).find((l) => l.url)?.url ?? null;
}

/**
 * A "Call 911" article: its intro opens with "Call 911", or the page shows the 911 banner and offers no
 * filing route at all (a banner next to an SR form just means "if it is an emergency, call 911").
 */
export function isEmergencyArticle(raw: RawArticle): boolean {
  if (/^\W*call 911\b/i.test(raw.cards[0]?.text ?? "")) return true;
  if (raw.emergencyBanner !== true || findReportLinks(raw).length > 0) return false;
  // A banner over a hotline ("Phone Number: …") is a phone route with a 911 caveat, not a 911 article.
  const text = raw.cards.map((c) => c.text).join("\n");
  return extractPhone(text, raw.cards.flatMap((c) => c.links)) === null || /\bcall 911\b/i.test(firstSentences(raw.cards[0]?.text ?? "", 120));
}

export type BuildContext = {
  topic: string | null;
  /** One-line summary from the "by category" listing, if the article appears there. */
  summary: string | null;
  probe: LandingProbe | null;
  now: string;
};

export function buildCatalogEntry(raw: RawArticle, ctx: BuildContext): CatalogEntry {
  const text = raw.cards.map((c) => c.text).join("\n");
  const links = raw.cards.flatMap((c) => c.links);
  const best = findReportLinks(raw)[0] ?? null;
  const phone = extractPhone(text, links);

  let channel: CatalogChannel;
  let officialUrl: string | null;
  if (best?.kind === "sr") {
    channel = "nyc311-sr-form";
    // Postback-only SR actions start from the article itself.
    officialUrl = best.url ?? articleUrl(raw.kaNumber);
  } else if (best?.url) {
    channel = channelForUrl(best.url) ?? "external-site";
    officialUrl = best.url;
  } else {
    channel = phone ? "phone-only" : "info-only";
    officialUrl = null;
  }

  const intro = raw.cards[0]?.text ?? "";
  // The report action's agency, else what the intro names, else any "Agency:" line on the page.
  const agency =
    best?.agency ?? agencyFromName(agencyNameFromText(intro)) ?? agencyFromProse(intro) ?? agencyFromName(agencyNameFromText(text)) ?? null;
  const emergency = isEmergencyArticle(raw);
  const probed = ctx.probe && officialUrl && best?.url === officialUrl ? ctx.probe : null;

  return {
    id: slugify(raw.title),
    title: raw.title,
    kaNumber: raw.kaNumber,
    articleUrl: articleUrl(raw.kaNumber),
    summary: (ctx.summary ?? firstSentences(intro)).trim(),
    agency,
    topic: ctx.topic,
    channel,
    officialUrl,
    requiresLogin: probed ? probed.requiresLogin : null,
    // The probe only loads page 1 of an NYC311 SR form; a CAPTCHA (if any) would sit on a later step, so
    // "none on page 1" proves nothing. Keep only a positive finding until the full flow is probed.
    hasCaptcha: probed ? (channel === "nyc311-sr-form" && !probed.hasCaptcha ? null : probed.hasCaptcha) : null,
    requiredFields: null,
    automation: emergency || channel === "phone-only" || channel === "info-only" ? "none" : "handoff",
    lastVerifiedAt: ctx.now,
    emergency,
  };
}

/** Up to ~240 chars of whole sentences. */
export function firstSentences(text: string, max = 240): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return end > 60 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
}

/** Fileable rows first; a crawled row whose id or KA number is already taken is dropped (KA-01014). Sorted by id. */
export function mergeCatalog(fileable: CatalogEntry[], crawled: CatalogEntry[]): CatalogEntry[] {
  const ids = new Set(fileable.map((e) => e.id));
  const kas = new Set(fileable.map((e) => e.kaNumber));
  const rest = crawled.filter((e) => {
    if (ids.has(e.id) || kas.has(e.kaNumber)) return false;
    kas.add(e.kaNumber);
    return true;
  });
  return [...fileable, ...rest].sort((a, b) => a.id.localeCompare(b.id));
}

/** Slugs must be unique: on a clash append the KA number ("noise-ka-01234"). */
export function assignUniqueIds(entries: CatalogEntry[]): CatalogEntry[] {
  const seen = new Map<string, number>();
  for (const e of entries) seen.set(e.id, (seen.get(e.id) ?? 0) + 1);
  return entries.map((e) => ((seen.get(e.id) ?? 0) > 1 ? { ...e, id: `${e.id}-${e.kaNumber.toLowerCase()}` } : e));
}

/**
 * Catalog rows for the categories we can already file (CATEGORIES). They keep their CategoryId as the
 * catalog id and point at their worker adapter; facts not in CategoryDefinition are stated here.
 */
const FILEABLE: Record<CategoryId, { agency: string; topic: string; adapter: string; requiresLogin: boolean; hasCaptcha: boolean }> = {
  // contact.mta.info wizard: no CAPTCHA or login observed (apps/worker/docs/mta-subway-delay-wizard.md).
  "subway-delay": { agency: "MTA", topic: "Transportation › Public Transportation", adapter: "mta-subway-delay", requiresLogin: false, hasCaptcha: false },
};

export function fileableCatalogEntries(now: string): CatalogEntry[] {
  return Object.values(CATEGORIES).map((c) => {
    const f = FILEABLE[c.id];
    return {
      id: c.id,
      title: c.label,
      kaNumber: c.articleUrl.match(/KA-\d+/)?.[0] ?? "KA-00000",
      articleUrl: c.articleUrl,
      summary: c.guidance,
      agency: f.agency,
      topic: f.topic,
      channel: channelForUrl(c.officialFormUrl) ?? "external-site",
      officialUrl: c.officialFormUrl,
      requiresLogin: f.requiresLogin,
      hasCaptcha: f.hasCaptcha,
      requiredFields: [...c.requiredFields],
      automation: `adapter:${f.adapter}`,
      lastVerifiedAt: now,
      emergency: false,
    };
  });
}
