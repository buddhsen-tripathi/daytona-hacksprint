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

/** Default when no category is known yet: assume a street report (location + description). */
const DEFAULT_REQUIRED: CategoryDefinition["requiredFields"] = ["location", "description"];

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

/** Categories with no replica portal: always filed against the official site (approval still required). */
export function isRealOnly(category: string | null | undefined): boolean {
  return getCategory(category)?.filing === "real-only";
}

/** Whether NYC Open Data has records for the category (duplicate check + Open Data status). */
export function isOpenDataBacked(category: string | null | undefined): boolean {
  return getCategory(category)?.openDataBacked !== false;
}

/** The target a filing for this category actually uses: real-only categories ignore FILING_TARGET. */
export function effectiveTarget(category: string | null | undefined, configured: FilingTarget): FilingTarget {
  return isRealOnly(category) ? "real" : configured;
}

/**
 * Whether the official form for this category needs the resident's name before approval.
 * DOT pothole form (real target): first + last name required. MTA Customer Feedback: contact is
 * optional (agent G mapping), so it is passed through only if the resident set /name or /email.
 */
export function requiresContactName(category: string | null | undefined, target: FilingTarget): boolean {
  if (isRealOnly(category)) return process.env.MTA_REQUIRE_CONTACT === "1";
  return effectiveTarget(category, target) === "real";
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

export function helpText(): string {
  const cats = allCategories()
    .map((c) => `• ${c.label} (${c.officialLabel})`)
    .join("\n");
  return [
    "Here's what I can help with right now:",
    cats,
    "",
    "How it works:",
    "1. Send a photo or describe the problem",
    "2. Share the location (pin or address); for a subway delay, tell me the line and direction instead",
    "3. I check for similar reports nearby (NYC Open Data), or live MTA alerts for subway delays",
    "4. You review the draft and approve, and only then do I file it",
    "",
    "Subway delays go straight to the MTA's Customer Feedback form, filed for real. Only report a delay that actually happened to you.",
    "",
    "Commands:",
    "/report start a new report",
    "/myreports your drafts and filed requests",
    "/status <number> check a service request",
    "/cancel cancel the current draft",
    "/name <First Last> contact name (only needed for some official forms)",
    "/email <address> optional email for official forms (the MTA replies by email)",
    "",
    "I never file without your OK, and I never make up request numbers.",
    "For emergencies, call 911.",
  ].join("\n");
}

export function emergencyText(): string {
  return [
    "🚨 This sounds like it could be dangerous.",
    "",
    "Please call 911 now if anyone is at risk or there's an open hole, collapse, or hazard in the road.",
    "",
    "I'm not filing this as a routine 311 report.",
    "",
    "If it's not an emergency after all, describe it again and I'll help you report it.",
  ].join("\n");
}

export function manualGuidance(triage: TriageOutcome | ClassificationResult["triage"], text: string | null): string {
  const lines: string[] = [];
  if (triage === "OUT_OF_SCOPE") {
    lines.push("That sounds like a real issue, but it isn't one I can file yet.");
  } else {
    lines.push("I can't file this one automatically.");
  }
  if (text && text.trim()) lines.push("", `What I understood: ${text.trim()}`);
  lines.push(
    "",
    `You can report it directly on NYC311: ${NYC311_REPORT_URL}`,
    "",
    `Right now I can file: ${allCategories()
      .map((c) => c.label.toLowerCase())
      .join(" and ")}.`,
  );
  return lines.join("\n");
}
