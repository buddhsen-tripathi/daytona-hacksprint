/**
 * ComplaintKnowledgeService: maps supported categories to official NYC311
 * guidance, computes missing fields, and owns the deterministic
 * "material change" rule (which edits require re-approval).
 */
import type { CategoryDefinition, CategoryId, ClassificationResult, ComplaintDraft, FilingTarget, TransitDetails, TriageOutcome } from "./contracts.js";
import { CATEGORIES, CategoryId as CategoryIdSchema, EMPTY_TRANSIT, SUBWAY_LINES } from "./contracts.js";

export const NYC311_REPORT_URL = "https://portal.311.nyc.gov/report-problems/";
export const NYC311_CHECK_STATUS_URL = "https://portal.311.nyc.gov/check-status/";

export type MissingField = ComplaintDraft["missingFields"][number];

/** Draft fields whose change invalidates an approval (design doc §6.6, §18.3). */
export const MATERIAL_FIELDS = ["category", "location", "description", "transit"] as const;
export type MaterialField = (typeof MATERIAL_FIELDS)[number];

export function getCategory(id: string | null | undefined): CategoryDefinition | null {
  const parsed = CategoryIdSchema.safeParse(id);
  return parsed.success ? CATEGORIES[parsed.data] : null;
}

export function allCategories(): CategoryDefinition[] {
  return Object.values(CATEGORIES);
}

export function isSupportedCategory(id: unknown): id is CategoryId {
  return CategoryIdSchema.safeParse(id).success;
}

/** Default when no category is known yet: a description. Location is only asked for categories that require it. */
const DEFAULT_REQUIRED: CategoryDefinition["requiredFields"] = ["description"];

export function requiredFieldsFor(category: string | null | undefined): CategoryDefinition["requiredFields"] {
  return getCategory(category)?.requiredFields ?? DEFAULT_REQUIRED;
}

/** Which transit sub-fields are still missing (line + direction are required; station/time optional). */
export function missingTransit(transit: TransitDetails | null | undefined): ("line" | "direction")[] {
  const out: ("line" | "direction")[] = [];
  if (!transit?.line) out.push("line");
  if (!transit?.direction?.trim()) out.push("direction");
  return out;
}

export function missingFields(draft: Pick<ComplaintDraft, "category" | "location" | "description" | "transit">): MissingField[] {
  const missing: MissingField[] = [];
  if (!draft.category) missing.push("category");
  const required = requiredFieldsFor(draft.category);
  if (required.includes("location")) {
    const loc = draft.location;
    const hasLoc = loc.userConfirmed && (loc.latitude != null || !!loc.address) && loc.withinNyc !== false;
    if (!hasLoc) missing.push("location");
  }
  if (required.includes("transit") && missingTransit(draft.transit).length) missing.push("transit");
  if (!draft.description || draft.description.trim().length < 5) missing.push("description");
  return missing;
}

/**
 * Categories whose official form the worker drives end to end (the MTA wizard: no CAPTCHA; the final Submit is still
 * gated by approval + ALLOW_REAL_SUBMIT).
 */
export function isRealOnly(category: string | null | undefined): boolean {
  return getCategory(category)?.id === "subway-delay";
}

/** Whether NYC Open Data has records for the category (duplicate check + Open Data status). */
export function isOpenDataBacked(category: string | null | undefined): boolean {
  return getCategory(category)?.openDataBacked !== false;
}

/** The target a filing uses: always the official form (kept as a function so call sites stay stable). */
export function effectiveTarget(_category?: string | null, _configured?: FilingTarget): FilingTarget {
  return "real";
}

/**
 * Whether the official form for this category needs the resident's name before approval
 * (data-driven: CategoryDefinition.requiresContactName). MTA Customer Feedback: contact is optional,
 * so it is passed through only if the resident set /name or /email (MTA_REQUIRE_CONTACT=1 forces it).
 */
export function requiresContactName(category: string | null | undefined, _target?: FilingTarget): boolean {
  const def = getCategory(category);
  if (!def) return false;
  if (def.id === "subway-delay" && process.env.MTA_REQUIRE_CONTACT === "1") return true;
  return def.requiresContactName;
}

/**
 * Canonical subway line from what the user said ("A train", "the 7", "L line", "42nd St shuttle").
 * Returns null when it cannot be matched — never guesses.
 */
export function canonicalSubwayLine(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const exact = SUBWAY_LINES.find((l) => l.toLowerCase() === s.toLowerCase());
  if (exact) return exact;
  if (/staten island|\bSIR\b/i.test(s)) return "Staten Island Railway";
  if (/shuttle|^S$/i.test(s)) {
    if (/franklin/i.test(s)) return "S-Franklin Av Shuttle";
    if (/rockaway/i.test(s)) return "S-Rockaway Park Shuttle";
    if (/42|times sq|grand central/i.test(s) || /^S( shuttle)?$/i.test(s)) return "S-42 Street Shuttle";
    return null;
  }
  const core = s
    .replace(/[()[\].,!?"']/g, " ")
    .replace(/\b(the|a|an)\s+(?=\S+\s+(train|line|express|local)\b)/gi, " ")
    .replace(/\b(trains?|lines?|express|local|subway|service)\b/gi, " ")
    .replace(/^\s*(the)\s+/i, " ")
    .trim()
    .toUpperCase();
  return (SUBWAY_LINES as readonly string[]).includes(core) ? core : null;
}

/** Merge newly extracted transit details into the known ones: new values win, nulls never erase. */
export function mergeTransit(prev: TransitDetails | null | undefined, next: TransitDetails | null | undefined): TransitDetails | null {
  if (!prev && !next) return null;
  const a = prev ?? EMPTY_TRANSIT;
  const b = next ?? EMPTY_TRANSIT;
  const pick = <K extends keyof TransitDetails>(k: K): TransitDetails[K] => {
    const v = b[k];
    return (v === null || v === undefined || (typeof v === "string" && !v.trim()) ? a[k] : v) as TransitDetails[K];
  };
  return { line: pick("line"), direction: pick("direction"), station: pick("station"), borough: pick("borough"), incidentTime: pick("incidentTime"), delayMinutes: pick("delayMinutes") };
}

/**
 * Deterministic fallback for short answers to the transit questions ("the A", "downtown",
 * "Manhattan-bound"). Only fills what is unambiguous in the text.
 */
export function transitHintsFromText(text: string): Partial<TransitDetails> {
  const out: Partial<TransitDetails> = {};
  const t = text.trim();
  const dir = /\b(uptown|downtown|northbound|southbound|eastbound|westbound|(?:manhattan|brooklyn|queens|bronx|coney island)[- ]bound|towards?\s+[A-Z0-9][\w .'-]{2,40})\b/i.exec(t);
  if (dir) out.direction = dir[1]!.trim();
  // Letters are case-sensitive on purpose: "a train" is not the A.
  const m = /\b([1-7]|[ACEBDFMNQRWGLJZ])\s*(?:[Tt]rains?|[Ll]ine|[Ee]xpress|[Ll]ocal)\b/.exec(t) ?? (t.length <= 12 ? /^(?:[Tt]he\s+)?([1-7]|[ACEBDFMNQRWGLJZ])\.?$/.exec(t) : null);
  const line = canonicalSubwayLine(m?.[1] ?? null);
  if (line) out.line = line;
  return out;
}

export function transitEqual(a: TransitDetails | null | undefined, b: TransitDetails | null | undefined): boolean {
  const x = a ?? EMPTY_TRANSIT;
  const y = b ?? EMPTY_TRANSIT;
  return x.line === y.line && x.direction === y.direction && x.station === y.station && x.borough === y.borough && x.incidentTime === y.incidentTime && x.delayMinutes === y.delayMinutes;
}

/** Which material fields differ between two drafts. Empty ⇒ approval still valid. */
export function materialChanges(before: ComplaintDraft, after: ComplaintDraft): MaterialField[] {
  const changed: MaterialField[] = [];
  if (before.category !== after.category) changed.push("category");
  const a = before.location;
  const b = after.location;
  if (a.latitude !== b.latitude || a.longitude !== b.longitude || a.address !== b.address || a.borough !== b.borough) changed.push("location");
  if (before.description.trim() !== after.description.trim()) changed.push("description");
  if (!transitEqual(before.transit, after.transit)) changed.push("transit");
  return changed;
}

export function isMaterialChange(before: ComplaintDraft, after: ComplaintDraft): boolean {
  return materialChanges(before, after).length > 0;
}

/** "subway delays" / "subway delays and X" — the categories filed today, in plain words. */
export function supportedSummary(): string {
  const labels = allCategories().map((c) => `${c.label.toLowerCase()}s`);
  return labels.length <= 1 ? (labels[0] ?? "") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

export function helpText(): string {
  return [
    "What I can file today:",
    "• Subway delays, with the MTA",
    "More categories are coming.",
    "",
    "What happens:",
    "1. You send a photo or describe the problem",
    "2. I draft the report and ask for anything missing",
    "3. You approve it (nothing is sent without your OK)",
    "4. I file it in a real browser and send you the recording and the reference",
    "",
    "Commands:",
    "/report start a new report",
    "/myreports your reports",
    "/status <number> check a report",
    "/name <First Last> your name for official forms",
    "/email <address> your email for official replies",
    "/cancel cancel the current draft",
    "/help this message",
    "",
    "For emergencies, call 911.",
  ].join("\n");
}

export function emergencyText(): string {
  return [
    "🚨 This sounds like it could be dangerous.",
    "",
    "Please call 911 now if anyone is at risk or there's an immediate hazard.",
    "",
    "I'm not filing this as a routine report.",
    "",
    "If it's not an emergency after all, describe it again and I'll help you report it.",
  ].join("\n");
}

export function manualGuidance(triage: TriageOutcome | ClassificationResult["triage"], text: string | null, link: string = NYC311_REPORT_URL): string {
  const lines: string[] = [];
  lines.push(triage === "OUT_OF_SCOPE" ? "That's a real issue, but it isn't one I can file yet." : "I can't file this one automatically.");
  if (text && text.trim()) lines.push("", `What I understood: ${text.trim()}`);
  lines.push("", `Here's where to report it: ${link}`, "", `Right now I can file: ${supportedSummary()}.`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// MTA Customer Feedback: direction options per line, in the form's own terms
// (apps/worker/docs/mta-subway-delay-wizard.md "Direction options per line"; the "<line> Train-" prefix stripped).
// ---------------------------------------------------------------------------
export const MTA_DIRECTIONS: Record<string, [string, string]> = {
  "1": ["Downtown (South Ferry)", "Uptown & The Bronx"],
  "2": ["Downtown & Brooklyn", "Uptown & The Bronx"],
  "3": ["Downtown & Brooklyn", "Uptown (Harlem-148 St)"],
  "4": ["Uptown & The Bronx", "Downtown & Brooklyn"],
  "5": ["Uptown & The Bronx", "Downtown & Brooklyn"],
  "6": ["Uptown & The Bronx", "Downtown (Brooklyn Bridge-City Hall)"],
  "7": ["Queens (Flushing-Main St)", "Manhattan (34 St-Hudson Yards)"],
  A: ["Uptown (Inwood-207 St)", "Downtown & Queens"],
  C: ["Downtown & Brooklyn", "Uptown (168 St)"],
  E: ["Downtown (World Trade Ctr)", "Uptown & Queens"],
  B: ["Downtown & Brooklyn", "Uptown & The Bronx"],
  D: ["Downtown & Brooklyn", "Uptown & The Bronx"],
  F: ["Downtown & Brooklyn", "Uptown & Queens"],
  M: ["Uptown & Forest Hills-71 Av", "Downtown & Middle Village-Metropolitan Av"],
  N: ["Downtown & Brooklyn", "Uptown & Queens"],
  Q: ["Downtown & Brooklyn", "Uptown (96 St)"],
  R: ["Downtown & Brooklyn", "Uptown & Queens"],
  W: ["Whitehall St-South Ferry", "Astoria-Ditmars Blvd"],
  G: ["Brooklyn (Church Av)", "Queens (Court Sq)"],
  L: ["Brooklyn (Canarsie-Rockaway Pkwy)", "Manhattan (8 Av)"],
  J: ["Queens (Jamaica Ctr-Parsons/Archer)", "Manhattan (Broad St)"],
  Z: ["Broad St", "Jamaica Ctr-Parsons/Archer"],
  "S-42 Street Shuttle": ["Times Sq-42 St", "Grand Central-42 St"],
  "S-Franklin Av Shuttle": ["Franklin Av", "Prospect Park"],
  "S-Rockaway Park Shuttle": ["Rockaway Park-Beach 116 St", "Broad Channel"],
  "Staten Island Railway": ["Tottenville", "St. George"],
};

export function mtaDirectionOptions(line: string | null | undefined): [string, string] | null {
  return line ? (MTA_DIRECTIONS[line] ?? null) : null;
}

// Same tokenizer/synonyms as the worker's matchDirection (apps/worker/src/adapters/mta-subway-delay.ts).
const DIR_STOP = new Set(["the", "to", "toward", "towards", "train", "trains", "line", "bound", "going", "heading", "headed", "direction", "in", "on", "at", "st", "av", "ave", "avs", "street", "avenue", "and", "of", "from", "into", "a", "an", "way", "side", "service", "-", "&"]);
const DIR_SYN: Record<string, string> = { northbound: "uptown", north: "uptown", up: "uptown", southbound: "downtown", south: "downtown", down: "downtown", center: "ctr", centre: "ctr", square: "sq", wtc: "ctr", bx: "bronx", bk: "brooklyn", bklyn: "brooklyn", city: "manhattan" };

export function directionTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/-bound\b/g, " ")
    .replace(/(\d+)(st|nd|rd|th)\b/g, "$1")
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !DIR_STOP.has(t))
    .map((t) => DIR_SYN[t] ?? t);
}

/**
 * Map what the resident said to exactly one of the MTA form's direction options for the line.
 * Unique best token overlap wins; zero overlap or a tie ⇒ null (ask the resident).
 * "Manhattan" only matches when an option mentions Manhattan (7, L, J); on the A it is ambiguous.
 */
export function resolveDirection(line: string | null | undefined, said: string | null | undefined, options: readonly string[] | null = mtaDirectionOptions(line)): string | null {
  if (!options || !said?.trim()) return null;
  const exact = options.find((o) => o.toLowerCase() === said.trim().toLowerCase());
  if (exact) return exact;
  const want = new Set(directionTokens(said));
  if (!want.size) return null;
  const scored = options.map((o) => {
    const have = new Set(directionTokens(o));
    let score = 0;
    for (const t of want) if (have.has(t)) score++;
    return { o, score };
  });
  scored.sort((a, b) => b.score - a.score);
  if (scored[0]!.score === 0 || scored[0]!.score === scored[1]!.score) return null;
  return scored[0]!.o;
}

// ---------------------------------------------------------------------------
// Incident time (New York local), always stored as ISO with the NY UTC offset.
// ---------------------------------------------------------------------------
function nyParts(d: Date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "longOffset" })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  const offset = (p.timeZoneName ?? "GMT-05:00").replace("GMT", "") || "+00:00";
  return { y: p.year!, m: p.month!, d: p.day!, h: Number(p.hour), min: Number(p.minute), offset: offset === "" ? "+00:00" : offset };
}

/** "2026-10-16T12:47:00-04:00" */
export function nycIso(d: Date = new Date()): string {
  const p = nyParts(d);
  return `${p.y}-${p.m}-${p.d}T${String(p.h).padStart(2, "0")}:${String(p.min).padStart(2, "0")}:00${p.offset}`;
}

/**
 * Deterministic parse of a typed incident time, today in New York: "just now", "8:30", "8:30 am",
 * "around 8 this morning", "2pm". Returns null when unclear or in the future. Never guesses a date.
 */
export function parseIncidentTime(text: string, now: Date = new Date()): string | null {
  const t = text.toLowerCase();
  if (/\b(just now|right now|now|atm|at the moment|currently|still)\b/.test(t) && !/\d/.test(t)) return nycIso(now);
  if (/\byesterday|last (night|week)|\bago\b/.test(t)) return null;
  const m = /\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?|\b(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)|\b(?:at|around|about|by|~)\s*(\d{1,2})\b(?!\s*(?:min|minute|hour|hr))/.exec(t);
  if (!m) return null;
  const hour = Number(m[1] ?? m[4] ?? m[6]);
  const minute = Number(m[2] ?? 0);
  const mer = (m[3] ?? m[5] ?? "").replace(/\./g, "");
  if (hour > 23 || minute > 59) return null;
  const p = nyParts(now);
  const nowMin = p.h * 60 + p.min;
  let candidates: number[];
  if (hour > 12) candidates = [hour];
  else if (mer === "am") candidates = [hour % 12];
  else if (mer === "pm") candidates = [(hour % 12) + 12];
  else if (/morning/.test(t)) candidates = [hour % 12];
  else if (/afternoon|evening|tonight/.test(t)) candidates = [(hour % 12) + 12];
  else candidates = [hour % 12, (hour % 12) + 12];
  const past = candidates.map((h) => h * 60 + minute).filter((x) => x <= nowMin + 5);
  if (!past.length) return null;
  const best = Math.max(...past);
  return `${p.y}-${p.m}-${p.d}T${String(Math.floor(best / 60)).padStart(2, "0")}:${String(best % 60).padStart(2, "0")}:00${p.offset}`;
}
