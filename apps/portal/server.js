// NYC311 Demo Portal — controlled replica of the NYC DOT pothole + street-repair flow.
// Zero dependencies. `node server.js` (env PORT=3311, MODE=normal|captcha|flaky|reject, HOST=0.0.0.0).
// Only relative URLs/redirects are used so it works behind the Daytona preview proxy.
import http from "node:http";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  BOROUGHS,
  RESTORATION_TYPES,
  confirmationPage,
  landingPage,
  notFoundPage,
  step1Page,
  step2Page,
  streetRepairPage,
} from "./views.js";

export const MODES = ["normal", "captcha", "flaky", "reject"];
const SR_RE = /^DEMO-\d{8}-[A-Z0-9]{6}$/;
const DATE_RE = /^(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/\d{4}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_BODY = 64 * 1024;

function newSr(now = new Date()) {
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const bytes = randomBytes(6);
  let tail = "";
  for (const b of bytes) tail += alphabet[b % 36];
  return `DEMO-${ymd}-${tail}`;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function formFields(raw, contentType) {
  if (String(contentType ?? "").includes("application/json")) {
    try {
      const j = JSON.parse(raw || "{}");
      return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, String(v ?? "").trim()]));
    } catch {
      return {};
    }
  }
  const p = new URLSearchParams(raw);
  const out = {};
  for (const [k, v] of p) out[k] = v.trim();
  return out;
}

const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k] ?? ""]));
const STEP1_KEYS = ["first_name", "last_name", "house_number", "street_name", "city", "state", "zip", "email", "home_phone", "work_phone", "date_detected"];
const STEP2_KEYS = ["borough", "location_type", "house_number", "on_street", "cross_street_1", "cross_street_2", "description"];
const REPAIR_KEYS = ["borough", "on_street", "cross_street_1", "restoration_type", "description", "first_name", "last_name", "email", "home_phone"];

export function createPortal({ mode: defaultMode = process.env.MODE ?? "normal", flakyDelayMs = Number(process.env.FLAKY_DELAY_MS ?? 2000), log = console.log } = {}) {
  if (!MODES.includes(defaultMode)) defaultMode = "normal";
  /** @type {Map<string, any>} */
  const requests = new Map();
  /** step-1 drafts keyed by draft id */
  const drafts = new Map();
  /** idempotency: form token (pothole draft id / street-repair form_token) → SR already created for it */
  const submissions = new Map();

  function resolveMode(req, url, body) {
    const q = url.searchParams.get("mode");
    if (q && MODES.includes(q)) return { mode: q, setCookie: true };
    if (body?.mode && MODES.includes(body.mode)) return { mode: body.mode, setCookie: false };
    const c = parseCookies(req.headers.cookie).demo_mode;
    if (c && MODES.includes(c)) return { mode: c, setCookie: false };
    return { mode: defaultMode, setCookie: false };
  }

  function send(res, status, body, { type = "text/html; charset=utf-8", headers = {} } = {}) {
    res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...headers });
    res.end(body);
  }
  const json = (res, status, obj) => send(res, status, JSON.stringify(obj, null, 2), { type: "application/json; charset=utf-8" });
  const redirect = (res, location, headers = {}) => {
    res.writeHead(302, { location, "cache-control": "no-store", ...headers });
    res.end();
  };

  function saveRecord(category, mode, fields, contact) {
    let sr = newSr();
    while (requests.has(sr)) sr = newSr();
    const rec = {
      sr,
      category,
      status: "Open",
      borough: fields.borough,
      on_street: fields.on_street,
      cross_street_1: fields.cross_street_1,
      cross_street_2: fields.cross_street_2 || null,
      house_number: fields.house_number || null,
      location_type: fields.location_type || null,
      restoration_type: fields.restoration_type || null,
      description: fields.description,
      contact,
      mode,
      responseDelivered: mode !== "flaky",
      createdAt: new Date().toISOString(),
    };
    requests.set(sr, rec);
    return rec;
  }

  /** Apply the mode to a final submission. Returns true if the response was handled. */
  function dropSocketLater(req, sr) {
    setTimeout(() => {
      log(`[portal] flaky: destroying socket for ${sr}`);
      req.socket.destroy();
    }, flakyDelayMs);
  }

  function finalize(req, res, category, mode, fields, contact, rerender, token) {
    if (mode === "captcha") {
      send(res, 400, rerender({ captchaError: "Please complete the CAPTCHA to continue." }));
      return;
    }
    if (mode === "reject") {
      send(res, 200, rerender({ error: "We could not locate this street in New York City." }));
      return;
    }
    // Idempotent per form token: a replayed POST never creates a second report.
    const existing = token ? submissions.get(token) : undefined;
    if (existing && requests.has(existing)) {
      log(`[portal] duplicate submission for token → ${existing}`);
      if (mode === "flaky") return dropSocketLater(req, existing);
      return redirect(res, `/confirmation/${encodeURIComponent(existing)}`);
    }
    const rec = saveRecord(category, mode, fields, contact);
    if (token) submissions.set(token, rec.sr);
    log(`[portal] saved ${rec.sr} (${category}, mode=${mode})`);
    if (mode === "flaky") {
      // Record is persisted BEFORE the connection is dropped: the report exists but the client never learns the SR.
      return dropSocketLater(req, rec.sr);
    }
    redirect(res, `/confirmation/${encodeURIComponent(rec.sr)}`);
  }

  function validateLocation(f, { repair = false } = {}) {
    const missing = [];
    if (!BOROUGHS.includes(f.borough)) missing.push("Borough");
    if (!f.on_street) missing.push("On Street");
    if (!f.cross_street_1) missing.push("Cross Street 1");
    if (repair && !RESTORATION_TYPES.includes(f.restoration_type)) missing.push("Restoration Type");
    if (!f.description) missing.push("Additional details");
    if (f.location_type && !["Street", "Intersection"].includes(f.location_type)) missing.push("Location Type");
    return missing.length ? `Please complete the required fields: ${missing.join(", ")}.` : null;
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://portal.local");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";

    let body = null;
    if (method === "POST") {
      try {
        body = formFields(await readBody(req), req.headers["content-type"]);
      } catch {
        return send(res, 413, "payload too large", { type: "text/plain" });
      }
    }
    const { mode, setCookie } = resolveMode(req, url, body);
    // flaky: one socket per request so the browser cannot transparently replay the POST on a reused keep-alive socket.
    if (mode === "flaky") res.setHeader("connection", "close");
    const cookieHeader = setCookie ? { "set-cookie": `demo_mode=${mode}; Path=/; SameSite=Lax` } : {};

    // ---- JSON API ----
    if (path === "/health" && method === "GET") return json(res, 200, { ok: true, service: "311relay-demo-portal", defaultMode, requests: requests.size });
    if (path === "/api/requests" && method === "GET") return json(res, 200, { requests: [...requests.values()] });
    if (path === "/api/reset" && method === "POST") {
      requests.clear();
      drafts.clear();
      submissions.clear();
      return json(res, 200, { ok: true });
    }
    const statusMatch = path.match(/^\/api\/status\/([^/]+)$/);
    if (statusMatch && method === "GET") {
      const sr = decodeURIComponent(statusMatch[1]).toUpperCase();
      const rec = SR_RE.test(sr) ? requests.get(sr) : undefined;
      if (!rec) return json(res, 404, { error: "not_found", sr });
      return json(res, 200, { sr: rec.sr, status: rec.status, category: rec.category, createdAt: rec.createdAt, borough: rec.borough });
    }

    // ---- HTML pages ----
    if (method === "GET") {
      if (path === "/") return send(res, 200, landingPage(mode), { headers: cookieHeader });
      if (path === "/report/pothole") return send(res, 200, step1Page({ mode }), { headers: cookieHeader });
      if (path === "/report/pothole/location") {
        const draftId = url.searchParams.get("draft") ?? "";
        if (!drafts.has(draftId)) return redirect(res, "/report/pothole", cookieHeader);
        return send(res, 200, step2Page({ mode, draftId }), { headers: cookieHeader });
      }
      if (path === "/report/street-repair") return send(res, 200, streetRepairPage({ mode, formToken: randomBytes(8).toString("hex") }), { headers: cookieHeader });
      const conf = path.match(/^\/confirmation\/([^/]+)$/);
      if (conf) {
        const rec = requests.get(decodeURIComponent(conf[1]));
        if (!rec) return send(res, 404, notFoundPage());
        return send(res, 200, confirmationPage(rec));
      }
      return send(res, 404, notFoundPage());
    }

    if (method === "POST") {
      const f = body ?? {};
      if (path === "/report/pothole/step1") {
        const values = pick(f, STEP1_KEYS);
        if (mode === "captcha") return send(res, 400, step1Page({ mode, values, captchaError: "Please complete the CAPTCHA to continue." }));
        const missing = [];
        if (!values.first_name) missing.push("First Name");
        if (!values.last_name) missing.push("Last Name");
        let error = missing.length ? `Please complete the required fields: ${missing.join(", ")}.` : null;
        if (!error && values.date_detected && !DATE_RE.test(values.date_detected)) error = 'Date Detected must use the format "MM/DD/YYYY".';
        if (!error && values.email && !EMAIL_RE.test(values.email)) error = "Email format: defect@server.com";
        if (error) return send(res, 400, step1Page({ mode, values, error }));
        const draftId = randomBytes(8).toString("hex");
        drafts.set(draftId, { contact: values, createdAt: Date.now() });
        if (drafts.size > 1000) drafts.delete(drafts.keys().next().value);
        return redirect(res, `/report/pothole/location?draft=${draftId}`);
      }
      if (path === "/report/pothole/submit") {
        const values = pick(f, STEP2_KEYS);
        const draftId = f.draft ?? "";
        const draft = drafts.get(draftId);
        const rerender = (extra) => step2Page({ mode, draftId, values, ...extra });
        if (!draft) return send(res, 400, step1Page({ mode, error: "Your session expired. Please start again from Customer Information." }));
        const error = mode === "captcha" ? null : validateLocation(values);
        if (error) return send(res, 400, rerender({ error }));
        return finalize(req, res, "pothole", mode, values, draft.contact, rerender, `draft:${draftId}`);
      }
      if (path === "/report/street-repair/submit") {
        const values = pick(f, REPAIR_KEYS);
        const rerender = (extra) => streetRepairPage({ mode, values, formToken: f.form_token ?? "", ...extra });
        const error = mode === "captcha" ? null : validateLocation(values, { repair: true });
        if (error) return send(res, 400, rerender({ error }));
        const contact = pick(values, ["first_name", "last_name", "email", "home_phone"]);
        return finalize(req, res, "street-repair", mode, values, contact, rerender, f.form_token ? `sr-form:${f.form_token}` : null);
      }
    }
    return send(res, 404, notFoundPage());
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(`[portal] error ${err?.stack ?? err}`);
      if (!res.headersSent) send(res, 500, "internal error", { type: "text/plain" });
      else res.end();
    });
  });
  return { server, requests, drafts, submissions };
}

export function startPortal({ port = Number(process.env.PORT ?? 3311), host = process.env.HOST ?? "0.0.0.0", ...opts } = {}) {
  const portal = createPortal(opts);
  return new Promise((resolve, reject) => {
    portal.server.once("error", reject);
    portal.server.listen(port, host, () => {
      const addr = portal.server.address();
      resolve({ ...portal, port: typeof addr === "object" && addr ? addr.port : port });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { port } = await startPortal();
  console.log(`[portal] NYC311 Demo Portal listening on 0.0.0.0:${port} (default mode=${process.env.MODE ?? "normal"})`);
  const stop = () => process.exit(0);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
