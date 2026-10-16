/**
 * Display labels (mirrors CATEGORIES in contracts.ts without pulling zod into the client bundle).
 * Keyed by plain string so new categories can be added here as data; an id with no entry
 * falls back to the raw id instead of rendering blank.
 */
export const CATEGORY_LABEL: Record<string, string> = {
  "subway-delay": "Subway delay",
};
export const CATEGORY_OFFICIAL: Record<string, string> = {
  "subway-delay": "MTA Customer Feedback — Subways › Complaint › Service and schedule › Delay",
};

export function categoryLabel(id: string): string {
  return CATEGORY_LABEL[id] ?? id;
}
export function categoryOfficial(id: string): string {
  return CATEGORY_OFFICIAL[id] ?? CATEGORY_LABEL[id] ?? id;
}
