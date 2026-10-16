/**
 * Adapter for the controlled replica (apps/portal). Two-step pothole flow mirroring the real DOT form,
 * plus the single-page street-repair form. Label/testid selectors only — never coordinates.
 */
import { DEMO_SR_RE, Outcome, sanitizeUrl, type FilingPayload } from "../protocol.js";
import { detectCaptcha, detectLogin, unexpectedRequiredFields } from "../safety.js";
import { acceptsFreeText, gotoWithRetries, isoToUsDate, needField, parseAddress, restorationTypeFrom, splitName, textOf } from "./common.js";
import type { AdapterContext, ConfirmResult, FormAdapter } from "./types.js";

const STEP1_KNOWN = ["first_name", "last_name", "house_number", "street_name", "city", "state", "zip", "email", "home_phone", "work_phone", "date_detected", "mode"];
const STEP2_KNOWN = ["borough", "location_type", "house_number", "on_street", "cross_street_1", "cross_street_2", "description", "mode", "draft"];
const REPAIR_KNOWN = ["borough", "on_street", "cross_street_1", "restoration_type", "description", "first_name", "last_name", "email", "home_phone", "mode"];
export const CROSS_STREET_UNKNOWN = "Nearest intersection unknown — see description";

type Variant = "pothole" | "street-repair";
type Intended = { testid: string; kind: "text" | "select" | "radio"; value: string };
type SubmitOutcome = "confirmation" | "form-error" | "captcha-error" | "connection-lost" | "server-error" | "timeout";

const tid = (name: string) => `[data-testid="${name}"]`;

/** Resolve the replica route for the category from whatever portal URL the bot gave us (root or a /report/* page). */
export function demoFormUrl(payload: FilingPayload, variant: Variant): string {
  const u = new URL(payload.formUrl);
  const idx = u.pathname.indexOf("/report/");
  const prefix = idx >= 0 ? u.pathname.slice(0, idx) : u.pathname.replace(/\/+$/, "");
  u.pathname = `${prefix}/report/${variant}`;
  // Mode travels in the URL too (the portal persists it in a cookie + hidden field); env MODE is the fallback.
  if (!u.searchParams.has("mode")) u.searchParams.set("mode", payload.portalMode);
  return u.toString();
}

async function stopIfCaptchaOrLogin(ctx: AdapterContext, step: "inspect" | "fill" | "validate" | "submit") {
  const login = await detectLogin(ctx.page);
  if (login.detected) {
    await ctx.shot(step, "login-required");
    throw new Outcome("HUMAN_ACTION_REQUIRED", "LOGIN_REQUIRED", "The form asks for a login. 311Relay never signs in for you or bypasses authentication.", { ...login });
  }
  const cap = await detectCaptcha(ctx.page);
  if (cap.detected) {
    await ctx.shot(step, "captcha-detected");
    throw new Outcome(
      "HUMAN_ACTION_REQUIRED",
      "CAPTCHA",
      "The form shows a CAPTCHA (\"verify you are human\"). 311Relay stopped before submitting and will not try to solve or bypass it — a person needs to finish this step.",
      { ...cap },
    );
  }
}

async function stopIfUnexpected(ctx: AdapterContext, step: "inspect" | "fill", known: string[]) {
  const extra = await unexpectedRequiredFields(ctx.page, known);
  if (extra.length) {
    await ctx.shot(step, "unexpected-required-field");
    throw new Outcome(
      "HUMAN_ACTION_REQUIRED",
      "UNEXPECTED_REQUIRED_FIELD",
      `The form now requires information 311Relay was not authorized to provide: ${extra.map((f) => f.label ?? f.name).join(", ")}.`,
      { fields: extra },
    );
  }
}

export function createDemoPortalAdapter(variant: Variant): FormAdapter {
  const intended: Intended[] = [];
  let submitOutcome: SubmitOutcome | null = null;
  let submitDetail: string | null = null;

  async function setText(ctx: AdapterContext, name: string, value: string | null) {
    if (value === null || value === "") return; // never invent; blank stays blank
    await ctx.page.locator(tid(name)).fill(value);
    intended.push({ testid: name, kind: "text", value });
  }
  async function setSelect(ctx: AdapterContext, name: string, label: string) {
    await ctx.page.locator(tid(name)).selectOption({ label });
    intended.push({ testid: name, kind: "select", value: label });
  }

  async function fillLocation(ctx: AdapterContext, opts: { radios: boolean; crossStreet2: boolean; houseNumber: boolean }) {
    const { payload, page } = ctx;
    const loc = parseAddress(payload.form.address, payload.form.borough);
    if (!loc.borough) needField("The form requires the borough of the problem location.", { field: "borough" });
    if (!loc.onStreet) needField("The form requires the street name of the problem location.", { field: "on_street" });
    let cross1 = loc.crossStreet1;
    if (!cross1) {
      // Only use the placeholder if the field genuinely accepts free text (no pattern / autocomplete / select).
      if (await acceptsFreeText(page, tid("cross_street_1"), CROSS_STREET_UNKNOWN)) {
        cross1 = CROSS_STREET_UNKNOWN;
        ctx.log("fill", "info", "no cross street known; cross_street_1 accepts free text, using the 'unknown — see description' note");
      } else needField("The form requires a cross street and does not accept a free-text note.", { field: "cross_street_1" });
    }
    await setSelect(ctx, "borough", loc.borough!);
    if (opts.radios) {
      const id = loc.locationType === "Intersection" ? "#location_type_intersection" : "#location_type_street";
      await page.locator(id).check();
      intended.push({ testid: id, kind: "radio", value: loc.locationType });
    }
    if (opts.houseNumber) await setText(ctx, "house_number", loc.houseNumber);
    await setText(ctx, "on_street", loc.onStreet);
    await setText(ctx, "cross_street_1", cross1);
    if (opts.crossStreet2) await setText(ctx, "cross_street_2", loc.crossStreet2);
    ctx.log("fill", "info", "location filled", { borough: loc.borough, houseNumber: loc.houseNumber, onStreet: loc.onStreet, crossStreet1: cross1, locationType: loc.locationType });
  }

  return {
    id: `demo-portal/${variant}`,

    async navigate(ctx) {
      const url = demoFormUrl(ctx.payload, variant);
      ctx.log("navigate", "info", `opening demo portal ${variant} form`, { url: sanitizeUrl(url) });
      await gotoWithRetries(ctx, url, variant === "pothole" ? tid("step1-form") : tid("street-repair-form"));
      await ctx.shot("navigate", "form-loaded");
    },

    async inspect(ctx) {
      await stopIfCaptchaOrLogin(ctx, "inspect");
      const known = variant === "pothole" ? STEP1_KNOWN : REPAIR_KNOWN;
      await stopIfUnexpected(ctx, "inspect", known);
      const requiredKnown = variant === "pothole" ? ["first_name", "last_name"] : ["borough", "on_street", "cross_street_1", "restoration_type", "description"];
      ctx.log("inspect", "info", "form inspected: no CAPTCHA, no login, no unexpected required fields", { requiredKnown });
      return { requiredKnown };
    },

    async fill(ctx) {
      const { page, payload } = ctx;
      const f = payload.form;
      if (variant === "pothole") {
        // ---- Step 1: Customer Information (first + last name are REQUIRED by the form) ----
        const name = splitName(f.contactName);
        if (!name) needField("name required — the form requires your first and last name.", { field: "first_name,last_name" });
        await setText(ctx, "first_name", name!.first);
        await setText(ctx, "last_name", name!.last);
        await setText(ctx, "email", f.contactEmail);
        await setText(ctx, "home_phone", f.contactPhone);
        await setText(ctx, "date_detected", isoToUsDate(f.dateObserved));
        ctx.log("fill", "info", "step 1 (customer information) filled with user-provided fields only", {
          fields: intended.map((i) => i.testid),
        });
        await ctx.shot("fill", "step1-filled");
        // verify step-1 values before leaving the page
        for (const i of intended) {
          const v = await page.locator(tid(i.testid)).inputValue();
          if (v !== i.value) throw new Outcome("FAILED", "BROWSER_ERROR", `Step 1 field ${i.testid} did not keep its value.`);
        }
        await stopIfCaptchaOrLogin(ctx, "fill"); // CAPTCHA check BEFORE clicking Next
        ctx.log("fill", "info", "clicking Next >> (step 1 → step 2; not a submission)");
        await Promise.all([
          page.waitForURL(/\/report\/pothole\/location/, { timeout: payload.limits.stepTimeoutMs }).catch(() => {}),
          page.locator(tid("next")).click(),
        ]);
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        ctx.checkGuard("fill");
        if (!/\/report\/pothole\/location/.test(page.url())) {
          await ctx.shot("fill", "step1-not-accepted");
          if (await page.locator(tid("captcha-error")).count()) throw new Outcome("HUMAN_ACTION_REQUIRED", "CAPTCHA", "The form requires a CAPTCHA to continue. 311Relay will not bypass it.");
          const err = await textOf(page, tid("form-error"));
          throw new Outcome("FAILED", "FORM_REJECTED", `The form rejected the customer information${err ? `: ${err}` : "."}`);
        }
        await page.waitForSelector(tid("step2-form"), { state: "visible" });
        await ctx.shot("fill", "step2-loaded");
        await stopIfCaptchaOrLogin(ctx, "fill");
        await stopIfUnexpected(ctx, "fill", STEP2_KNOWN);
        intended.length = 0; // step-1 fields are gone; validate() re-reads step-2 fields
        // ---- Step 2: Pothole Location ----
        await fillLocation(ctx, { radios: true, crossStreet2: true, houseNumber: true });
        await setText(ctx, "description", f.description);
        await ctx.shot("fill", "step2-filled");
      } else {
        // ---- Street repair: single page ----
        const rt = restorationTypeFrom(f.description);
        if (!rt) needField("The street-repair form requires the restoration type (street cut, trench or patch) and the description does not say which.", { field: "restoration_type" });
        await fillLocation(ctx, { radios: false, crossStreet2: false, houseNumber: false });
        await setSelect(ctx, "restoration_type", rt!);
        await setText(ctx, "description", f.description);
        const name = splitName(f.contactName);
        if (name) {
          await setText(ctx, "first_name", name.first);
          await setText(ctx, "last_name", name.last);
        }
        await setText(ctx, "email", f.contactEmail);
        await setText(ctx, "home_phone", f.contactPhone);
        await ctx.shot("fill", "form-filled");
      }
    },

    async validate(ctx) {
      const { page } = ctx;
      const problems: string[] = [];
      for (const i of intended) {
        const loc = i.kind === "radio" ? page.locator(i.testid) : page.locator(tid(i.testid));
        if (i.kind === "radio") {
          if (!(await loc.isChecked())) problems.push(`${i.testid} not checked`);
        } else if (i.kind === "select") {
          const label = await loc.evaluate((el) => (el as HTMLSelectElement).selectedOptions[0]?.text ?? "");
          if (label !== i.value) problems.push(`${i.testid}: expected "${i.value}", found "${label}"`);
        } else {
          const v = await loc.inputValue();
          if (v !== i.value) problems.push(`${i.testid}: expected "${i.value}", found "${v}"`);
        }
      }
      const emptyRequired = await page.evaluate(() =>
        Array.from(document.querySelectorAll("form [required]"))
          .filter((e) => !(e as HTMLInputElement).value?.trim())
          .map((e) => (e as HTMLInputElement).name),
      );
      for (const n of emptyRequired) problems.push(`required field ${n} is empty`);
      if (await page.locator(tid("form-error")).count()) problems.push(`form shows an error: ${await textOf(page, tid("form-error"))}`);
      await stopIfCaptchaOrLogin(ctx, "validate");
      await ctx.shot("validate", "before-submit", "All fields verified; form as it will be submitted");
      ctx.log("validate", problems.length ? "warn" : "info", problems.length ? "validation problems" : "all fields verified against the approved draft", { problems, checked: intended.length });
      return { ok: problems.length === 0, problems };
    },

    async submit(ctx) {
      const { page, payload, state } = ctx;
      const btn = page.locator(tid("submit"));
      await btn.waitFor({ state: "visible" });
      if (!(await btn.isEnabled())) throw new Outcome("FAILED", "BROWSER_ERROR", "The Submit button is disabled.");
      ctx.checkGuard("submit");
      const timeout = payload.limits.stepTimeoutMs;
      const failuresBefore = ctx.guard.mainFrameFailures.length;

      let resolveLost: (v: SubmitOutcome) => void = () => {};
      const lost = new Promise<SubmitOutcome>((r) => (resolveLost = r));
      const onFailed = (req: import("playwright-core").Request) => {
        if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
          submitDetail = req.failure()?.errorText ?? "request failed";
          resolveLost("connection-lost");
        }
      };
      const onResponse = (resp: import("playwright-core").Response) => {
        const req = resp.request();
        if (req.isNavigationRequest() && req.frame() === page.mainFrame() && resp.status() >= 500) {
          submitDetail = `HTTP ${resp.status()}`;
          resolveLost("server-error");
        }
      };
      const onClose = () => {
        submitDetail = "page/browser closed";
        resolveLost("connection-lost");
      };
      page.on("requestfailed", onFailed);
      page.on("response", onResponse);
      page.on("close", onClose);
      page.context().browser()?.on("disconnected", onClose);

      const waiters: Promise<SubmitOutcome>[] = [
        page.waitForURL(/\/confirmation\//, { timeout }).then(() => "confirmation" as const, () => "timeout" as const),
        page.locator(tid("form-error")).waitFor({ state: "visible", timeout }).then(() => "form-error" as const, () => "timeout" as const),
        page.locator(tid("captcha-error")).waitFor({ state: "visible", timeout }).then(() => "captcha-error" as const, () => "timeout" as const),
        lost,
      ];
      const first = (ps: Promise<SubmitOutcome>[]) =>
        new Promise<SubmitOutcome>((resolve) => {
          let pending = ps.length;
          for (const p of ps)
            p.then((v) => {
              if (v !== "timeout") resolve(v);
              else if (--pending === 0) resolve("timeout");
            });
        });

      // Exactly once. submitClicked is set BEFORE the click: if anything goes wrong from here on the outcome is unknown.
      state.submitClicked = true;
      ctx.log("submit", "info", "clicking Submit (exactly once; no automatic retry after this point)");
      try {
        await btn.click({ timeout: Math.min(timeout, 10000), noWaitAfter: true });
      } catch (err) {
        submitDetail = `click error: ${String((err as Error)?.message ?? err).split("\n")[0]}`;
        resolveLost("connection-lost");
      }
      submitOutcome = await first(waiters);
      if (submitOutcome === "timeout" && ctx.guard.mainFrameFailures.length > failuresBefore) submitOutcome = "connection-lost";
      page.off("requestfailed", onFailed);
      page.off("response", onResponse);
      page.off("close", onClose);
      ctx.log("submit", submitOutcome === "confirmation" ? "info" : "warn", `after submit: ${submitOutcome}`, submitDetail ? { detail: submitDetail } : undefined);
    },

    async confirm(ctx): Promise<ConfirmResult> {
      const { page } = ctx;
      ctx.checkGuard("confirm");
      if (submitOutcome === "connection-lost" || submitOutcome === "server-error") {
        await ctx.shot("confirm", "connection-lost");
        throw new Outcome(
          "SUBMISSION_UNKNOWN",
          "CONNECTION_LOST_AFTER_SUBMIT",
          "The connection dropped after Submit was clicked, so we could not read a confirmation. The portal may or may not have recorded the report. No automatic retry is allowed — check the request status before filing again.",
          { detail: submitDetail },
        );
      }
      if (submitOutcome === "form-error") {
        const err = await textOf(page, tid("form-error"));
        await ctx.shot("confirm", "form-rejected");
        await ctx.saveHtml("confirm", "form-rejected");
        throw new Outcome("FAILED", "FORM_REJECTED", `The portal rejected the report and did not issue a request number: ${err ?? "unknown reason"}`, { formError: err });
      }
      if (submitOutcome === "captcha-error") {
        await ctx.shot("confirm", "captcha-error");
        throw new Outcome("HUMAN_ACTION_REQUIRED", "CAPTCHA", "The portal required a CAPTCHA at submission and did not accept the report. A person needs to finish this step.");
      }
      // confirmation page (or timeout): parse the receipt; never synthesize an SR.
      await page.locator(tid("sr-number")).first().waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
      const sr = await textOf(page, tid("sr-number"));
      const confirmationText = await textOf(page, tid("confirmation"));
      await ctx.saveHtml("confirm", "confirmation-page");
      await ctx.shot("confirm", "confirmation", sr ? `Confirmation page showing ${sr}` : "Page after submit (no confirmation found)");
      if (sr && DEMO_SR_RE.test(sr) && confirmationText) {
        ctx.log("confirm", "info", `confirmation parsed: ${sr}`, { sr });
        return { officialRequestNumber: sr, confirmationText: `${sr} — ${confirmationText}`, receiptUrl: sanitizeUrl(page.url()) };
      }
      throw new Outcome(
        "SUBMISSION_UNKNOWN",
        "NO_CONFIRMATION",
        "Submit was clicked but no confirmation with a valid request number appeared. The report may or may not exist; no automatic retry.",
        { srText: sr, confirmationText },
      );
    },
  };
}
