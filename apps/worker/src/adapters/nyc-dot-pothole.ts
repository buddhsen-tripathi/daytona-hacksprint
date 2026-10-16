/**
 * Adapter for the OFFICIAL NYC DOT pothole form (https://a841-dotvweb01.nyc.gov/potholeform).
 * Phase-1 gate result: reCAPTCHA is present on step 1 and a headless "Next >>" never navigates.
 * Therefore this adapter fills ONLY user-provided step-1 fields, takes evidence, detects the CAPTCHA and
 * stops with HUMAN_ACTION_REQUIRED/CAPTCHA so the resident can finish in the live browser view.
 * It never solves or bypasses a CAPTCHA and never clicks the final submit on the real site.
 *
 * ALLOW_REAL_SUBMIT=1 (process env, NOT payload): if — and only if — no CAPTCHA is present, the worker may click
 * "Next >>" once to reach step 2, screenshot it, and still stop with HUMAN_ACTION_REQUIRED (step 2 is not mapped).
 * Default: never clicks anything on the real site.
 */
import { Outcome, sanitizeUrl } from "../protocol.js";
import { detectCaptcha, detectLogin, unexpectedRequiredFields } from "../safety.js";
import { gotoWithRetries, isoToUsDate, needField, splitName } from "./common.js";
import type { AdapterContext, ConfirmResult, FormAdapter } from "./types.js";

export const DOT_POTHOLE_URL = "https://a841-dotvweb01.nyc.gov/potholeform";
const KNOWN = ["txFirstName", "txLastName", "txHN", "txStreetAddress", "txCity", "txState", "txZipCode", "txEmail", "txPhoneNumber", "txWorkNumber", "txDateObserved", "q"];

const HANDOFF =
  "The official NYC DOT form is protected by a CAPTCHA. 311Relay filled in only the details you provided and stopped before \"Next\" — it never solves or bypasses CAPTCHAs. You can finish the report yourself in the live browser view.";

export function createNycDotPotholeAdapter(): FormAdapter {
  const intended: { sel: string; value: string }[] = [];

  async function set(ctx: AdapterContext, sel: string, value: string | null) {
    if (!value) return; // never invent contact details
    await ctx.page.locator(sel).fill(value);
    intended.push({ sel, value });
  }

  return {
    id: "nyc-dot-pothole",

    async navigate(ctx) {
      const url = ctx.payload.formUrl || DOT_POTHOLE_URL;
      ctx.log("navigate", "info", "opening the official NYC DOT pothole form", { url: sanitizeUrl(url) });
      await gotoWithRetries(ctx, url, "#txFirstName");
      // Let the reCAPTCHA script/iframe load so detection is reliable (bounded).
      await ctx.page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      await ctx.shot("navigate", "official-form-loaded");
    },

    async inspect(ctx) {
      const login = await detectLogin(ctx.page);
      if (login.detected) throw new Outcome("HUMAN_ACTION_REQUIRED", "LOGIN_REQUIRED", "The official form asks for a login. 311Relay never signs in for you.", { ...login });
      const extra = await unexpectedRequiredFields(ctx.page, KNOWN);
      if (extra.length) {
        await ctx.shot("inspect", "unexpected-required-field");
        throw new Outcome("HUMAN_ACTION_REQUIRED", "UNEXPECTED_REQUIRED_FIELD", `The official form now requires: ${extra.map((f) => f.label ?? f.name).join(", ")}.`, { fields: extra });
      }
      const cap = await detectCaptcha(ctx.page);
      ctx.log("inspect", cap.detected ? "warn" : "info", cap.detected ? "CAPTCHA present on step 1 (expected for this form) — will fill user-provided fields and hand off" : "no CAPTCHA detected yet", { captcha: cap });
      return { requiredKnown: ["txFirstName", "txLastName"] };
    },

    async fill(ctx) {
      const f = ctx.payload.form;
      const name = splitName(f.contactName);
      if (!name) needField("The official form requires your first and last name.", { field: "txFirstName,txLastName" });
      await set(ctx, "#txFirstName", name!.first);
      await set(ctx, "#txLastName", name!.last);
      await set(ctx, "#txEmail", f.contactEmail);
      await set(ctx, "#txPhoneNumber", f.contactPhone);
      await set(ctx, "#txDateObserved", isoToUsDate(f.dateObserved));
      ctx.log("fill", "info", "filled user-provided step-1 fields only (no home address is invented)", { fields: intended.map((i) => i.sel) });
      await ctx.shot("fill", "official-step1-filled");
    },

    async validate(ctx) {
      const problems: string[] = [];
      for (const i of intended) {
        const v = await ctx.page.locator(i.sel).inputValue();
        if (v !== i.value) problems.push(`${i.sel}: expected "${i.value}", found "${v}"`);
      }
      const cap = await detectCaptcha(ctx.page);
      if (cap.detected) {
        await ctx.shot("validate", "captcha-handoff", "Official form filled with your details; stopped at the CAPTCHA before Next");
        throw new Outcome("HUMAN_ACTION_REQUIRED", "CAPTCHA", HANDOFF, { captcha: cap, liveViewUrl: ctx.payload.liveViewUrl, fieldProblems: problems });
      }
      if (process.env.ALLOW_REAL_SUBMIT !== "1") {
        await ctx.shot("validate", "stopped-before-next");
        throw new Outcome(
          "HUMAN_ACTION_REQUIRED",
          null,
          "No CAPTCHA was detected, but automated submission to the official site is disabled. 311Relay filled your details and stopped; please finish in the live browser view.",
          { liveViewUrl: ctx.payload.liveViewUrl },
        );
      }
      return { ok: problems.length === 0, problems };
    },

    async submit(ctx) {
      // Only reachable with ALLOW_REAL_SUBMIT=1 and no CAPTCHA. "Next >>" moves to step 2; it is not the final submission.
      ctx.log("submit", "warn", "ALLOW_REAL_SUBMIT=1 and no CAPTCHA: clicking Next >> once (step 1 → step 2, not the final submit)");
      await Promise.all([ctx.page.waitForLoadState("domcontentloaded").catch(() => {}), ctx.page.locator("#bSubmit").click()]);
      await ctx.page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      ctx.checkGuard("submit");
    },

    async confirm(ctx): Promise<ConfirmResult> {
      await ctx.shot("confirm", "official-step2");
      throw new Outcome(
        "HUMAN_ACTION_REQUIRED",
        "UNEXPECTED_REQUIRED_FIELD",
        "Reached the official form's location step, which 311Relay does not automate. Please finish in the live browser view; nothing was submitted.",
        { liveViewUrl: ctx.payload.liveViewUrl },
      );
    },
  };
}
