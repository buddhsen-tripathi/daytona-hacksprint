/**
 * Button sets (transport-agnostic OutboundButton rows) + conversion to grammY
 * keyboards. Every callback is bound to a complaint id + draft version.
 */
import { InlineKeyboard, Keyboard } from "grammy";
import type { CatalogEntry, ComplaintDraft, OutboundButton } from "../core/contracts.js";
import { encodeCallback } from "../core/contracts.js";

/** Telegram rejects URL buttons pointing at localhost / non-https hosts. */
export function isButtonSafeUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(u.hostname);
  } catch {
    return false;
  }
}

export function approvalButtons(d: ComplaintDraft, opts: { canApprove: boolean } = { canApprove: true }): OutboundButton[][] {
  const rows: OutboundButton[][] = [];
  if (opts.canApprove) rows.push([{ text: "✅ Approve and file", data: encodeCallback("approve", d.id, d.draftVersion) }]);
  rows.push([
    { text: "✏️ Edit details", data: encodeCallback("edit", d.id, d.draftVersion) },
    { text: "❌ Cancel", data: encodeCallback("cancel", d.id, d.draftVersion) },
  ]);
  return rows;
}

export function duplicateButtons(d: ComplaintDraft, reviewUrl: string): OutboundButton[][] {
  const review: OutboundButton = isButtonSafeUrl(reviewUrl)
    ? { text: "🔎 Review existing request", url: reviewUrl }
    : { text: "🔎 Review existing request", data: encodeCallback("dup_review", d.id, d.draftVersion) };
  return [[review], [{ text: "➡️ Continue with new report", data: encodeCallback("dup_continue", d.id, d.draftVersion) }]];
}

/** #5: the same issue was already raised by another resident. */
export function sameIssueButtons(d: ComplaintDraft): OutboundButton[][] {
  return [
    [{ text: "➕ Add me to the existing report", data: encodeCallback("dup_join", d.id, d.draftVersion) }],
    [{ text: "🆕 It's different — file a new one", data: encodeCallback("dup_continue", d.id, d.draftVersion) }],
    [{ text: "❌ Cancel", data: encodeCallback("cancel", d.id, d.draftVersion) }],
  ];
}

export function trackingButtons(d: ComplaintDraft, receiptUrl: string | null): OutboundButton[][] {
  const view: OutboundButton = isButtonSafeUrl(receiptUrl)
    ? { text: "🧾 View official request", url: receiptUrl }
    : { text: "🧾 View official request", data: encodeCallback("view_official", d.id, d.draftVersion) };
  return [[{ text: "🔄 Check status", data: encodeCallback("status", d.id, d.draftVersion) }, view]];
}

/** Router (#8) route card: the official link, then the NYC311 article. */
export function routeButtons(e: CatalogEntry): OutboundButton[][] {
  const rows: OutboundButton[][] = [];
  if (e.officialUrl && e.officialUrl !== e.articleUrl) rows.push(...linkButton(e.channel === "nyc311-sr-form" ? "📝 Report on NYC311" : "📝 Open the official form", e.officialUrl));
  rows.push(...linkButton(e.officialUrl === e.articleUrl ? "📝 Report on NYC311" : "ℹ️ NYC311 article", e.articleUrl));
  return rows;
}

/** Router (#8) low-confidence picker: one button per candidate, by index. */
export function routeChoiceButtons(d: ComplaintDraft, choices: CatalogEntry[]): OutboundButton[][] {
  return choices.map((e, i) => [{ text: e.title.slice(0, 60), data: `${encodeCallback("route_pick", d.id, d.draftVersion)}:${i}` }]);
}

export function linkButton(text: string, url: string): OutboundButton[][] {
  return isButtonSafeUrl(url) ? [[{ text, url }]] : [];
}

export function toInlineKeyboard(rows: OutboundButton[][]): InlineKeyboard {
  const kb = new InlineKeyboard();
  rows.forEach((row, i) => {
    for (const b of row) {
      if (b.url) kb.url(b.text, b.url);
      else kb.text(b.text, b.data ?? "noop");
    }
    if (i < rows.length - 1) kb.row();
  });
  return kb;
}

export function locationKeyboard(): Keyboard {
  return new Keyboard().requestLocation("📍 Share location").resized().oneTime();
}
