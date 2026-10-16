import type { CategoryId } from "./types";

/** Display labels (mirrors CATEGORIES in contracts.ts without pulling zod into the client bundle). */
export const CATEGORY_LABEL: Record<CategoryId, string> = {
  "street-pothole": "Street pothole",
  "street-repair-defect": "Street repair defect",
};
export const CATEGORY_OFFICIAL: Record<CategoryId, string> = {
  "street-pothole": "Pothole or Cave-In on Street",
  "street-repair-defect": "Street Repair Complaint",
};
