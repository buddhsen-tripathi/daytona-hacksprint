/**
 * Generic hand-off adapter (#9): the default for every catalog entry with `automation: "handoff"`.
 * Opens payload.formUrl (the entry's officialUrl) in the session, screenshots it, stops on CAPTCHA / login (never
 * bypassed), prefills ONLY fields whose label matches a key in payload.form.extraFields, and NEVER submits: it always
 * ends HUMAN_ACTION_REQUIRED with the live-view URL so a person finishes the form.
 * Contact fields are never filled by this adapter (only extraFields, which are the resident's own answers).
 */
import { Outcome, sanitizeUrl } from "../protocol.js";
import { detectCaptcha, detectLogin } from "../safety.js";
import { emitFormStep, gotoWithRetries } from "./common.js";
import { FIELD_SELECTOR, NEVER_FILL_TYPES, listFields, matchFieldByLabel, normLabel, schemaFields } from "./fields.js";
import type { AdapterContext, FormAdapter } from "./types.js";

export function createHandoffAdapter(): FormAdapter {
  const prefilled: string[] = [];
  const notMatched: string[] = [];

  async function safetyStop(ctx: AdapterContext, step: "inspect" | "validate") {
    const login = await detectLogin(ctx.page);
    if (login.detected) {
      await ctx.shot(step, "login-wall");
      throw new Outcome("HUMAN_ACTION_REQUIRED", "LOGIN_REQUIRED", "The official form asks you to sign in. 311Relay never signs in for you; please continue in the live browser view.", { ...login, handoff: true, liveViewUrl: ctx.payload.liveViewUrl });
    }
    const cap = await detectCaptcha(ctx.page);
    if (cap.detected) {
      await ctx.shot(step, "captcha");
      throw new Outcome("HUMAN_ACTION_REQUIRED", "CAPTCHA", "The official form shows a CAPTCHA. 311Relay never solves or bypasses CAPTCHAs; please finish in the live browser view.", { captcha: cap, handoff: true, liveViewUrl: ctx.payload.liveViewUrl });
    }
  }

  return {
    id: "handoff",

    async navigate(ctx) {
      ctx.log("navigate", "info", "hand-off: opening the official form (a person submits it)", { url: sanitizeUrl(ctx.payload.formUrl) });
      await gotoWithRetries(ctx, ctx.payload.formUrl, "body");
      await ctx.page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      await ctx.shot("navigate", "official-form-loaded");
    },

    async inspect(ctx) {
      await safetyStop(ctx, "inspect");
      const fields = await listFields(ctx.page);
      emitFormStep(ctx, { title: "form", fields: schemaFields(fields, "form") });
      return { requiredKnown: fields.filter((f) => f.required).map((f) => f.label) };
    },

    async fill(ctx) {
      const extra = ctx.payload.form.extraFields ?? {};
      const keys = Object.keys(extra).filter((k) => typeof extra[k] === "string" && extra[k]!.trim());
      if (!keys.length) {
        ctx.log("fill", "info", "hand-off: no saved answers to prefill");
        return;
      }
      const fields = (await listFields(ctx.page)).filter((f) => !NEVER_FILL_TYPES.has(f.type));
      for (const key of keys) {
        const value = extra[key]!.trim();
        const f = matchFieldByLabel(key, fields);
        if (!f) {
          notMatched.push(key);
          continue;
        }
        const el = ctx.page.locator(FIELD_SELECTOR).nth(f.index);
        if (f.tag === "select") {
          const opt = (f.options ?? []).find((o) => normLabel(o) === normLabel(value));
          if (!opt) {
            notMatched.push(key);
            continue;
          }
          await el.selectOption({ label: opt });
        } else {
          if (!(await el.isEditable().catch(() => false))) {
            notMatched.push(key);
            continue;
          }
          await el.fill(value);
        }
        prefilled.push(f.label);
        ctx.action({ kind: "fill", target: f.label, chars: value.length });
      }
      // Field labels only (no values) in the log.
      ctx.log("fill", "info", `hand-off: prefilled ${prefilled.length} field(s) from saved answers`, { prefilled, notMatched });
    },

    async validate(ctx) {
      await safetyStop(ctx, "validate");
      await ctx.shot("validate", "handoff-prefilled", prefilled.length ? `Official form with ${prefilled.length} field(s) prefilled; not submitted` : "Official form opened; not submitted");
      return { ok: true, problems: [] };
    },

    async submit(ctx) {
      // Never submits. A person reviews and submits in the live browser view.
      ctx.log("submit", "warn", "hand-off: 311Relay does not submit this form; handing over to a person");
      ctx.action({ kind: "stop", target: "handoff" });
      await ctx.saveHtml("submit", "handoff");
      throw new Outcome(
        "HUMAN_ACTION_REQUIRED",
        null,
        prefilled.length
          ? `I opened the official form and prefilled ${prefilled.length} field(s). Please review and submit it yourself in the live browser view.`
          : "I opened the official form. Please fill it in and submit it yourself in the live browser view.",
        { handoff: true, liveViewUrl: ctx.payload.liveViewUrl, prefilled, notMatched },
      );
    },

    async confirm(): Promise<never> {
      throw new Outcome("FAILED", "WORKER_CRASH", "The hand-off adapter never submits, so there is nothing to confirm.");
    },
  };
}
