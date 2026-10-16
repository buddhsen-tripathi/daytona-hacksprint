/**
 * ComplaintKnowledgeService: maps supported categories to official NYC311
 * guidance, computes missing fields, and owns the deterministic
 * "material change" rule (which edits require re-approval).
 */
import type { CategoryDefinition, CategoryId, ClassificationResult, ComplaintDraft, TriageOutcome } from "./contracts.js";
import { CATEGORIES, CategoryId as CategoryIdSchema } from "./contracts.js";

export const NYC311_REPORT_URL = "https://portal.311.nyc.gov/report-problems/";
export const NYC311_CHECK_STATUS_URL = "https://portal.311.nyc.gov/check-status/";

export type MissingField = ComplaintDraft["missingFields"][number];

/** Draft fields whose change invalidates an approval (design doc §6.6, §18.3). */
export const MATERIAL_FIELDS = ["category", "location", "description"] as const;
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

export function missingFields(draft: Pick<ComplaintDraft, "category" | "location" | "description">): MissingField[] {
  const missing: MissingField[] = [];
  if (!draft.category) missing.push("category");
  const loc = draft.location;
  const hasLoc = loc.userConfirmed && (loc.latitude != null || !!loc.address) && loc.withinNyc !== false;
  if (!hasLoc) missing.push("location");
  if (!draft.description || draft.description.trim().length < 5) missing.push("description");
  return missing;
}

/** Which material fields differ between two drafts. Empty ⇒ approval still valid. */
export function materialChanges(before: ComplaintDraft, after: ComplaintDraft): MaterialField[] {
  const changed: MaterialField[] = [];
  if (before.category !== after.category) changed.push("category");
  const a = before.location;
  const b = after.location;
  if (a.latitude !== b.latitude || a.longitude !== b.longitude || a.address !== b.address || a.borough !== b.borough) changed.push("location");
  if (before.description.trim() !== after.description.trim()) changed.push("description");
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
    "2. Share the location (pin or address)",
    "3. I check for similar reports nearby",
    "4. You review the draft and approve, and only then do I file it",
    "",
    "Commands:",
    "/report start a new report",
    "/myreports your drafts and filed requests",
    "/status <number> check a service request",
    "/cancel cancel the current draft",
    "/name <First Last> contact name (only needed for some official forms)",
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
