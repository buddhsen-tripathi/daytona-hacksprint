// node --test apps/portal/tests/  — runs against BASE_URL if set, else starts an in-process portal on a free port.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startPortal } from "../server.js";

let BASE = process.env.BASE_URL?.replace(/\/+$/, "");
let portal = null;

before(async () => {
  if (!BASE) {
    portal = await startPortal({ port: 0, host: "127.0.0.1", flakyDelayMs: 300, log: () => {} });
    BASE = `http://127.0.0.1:${portal.port}`;
  }
  await fetch(`${BASE}/api/reset`, { method: "POST" });
});
after(() => portal?.server.close());

const form = (obj) => ({
  method: "POST",
  redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(obj).toString(),
});

const STEP1 = { first_name: "Ada", last_name: "Lovelace", email: "ada@example.com", date_detected: "10/16/2026" };
const STEP2 = { borough: "Manhattan", location_type: "Street", house_number: "1515", on_street: "Broadway", cross_street_1: "W 44th St", description: "Pothole about 2 ft wide in the right lane" };

async function step1(mode) {
  const r = await fetch(`${BASE}/report/pothole/step1`, form({ ...STEP1, mode }));
  assert.equal(r.status, 302);
  const loc = r.headers.get("location");
  assert.match(loc, /^\/report\/pothole\/location\?draft=[0-9a-f]+$/, "relative redirect to step 2");
  return new URL(loc, BASE).searchParams.get("draft");
}

test("health + landing", async () => {
  const h = await (await fetch(`${BASE}/health`)).json();
  assert.equal(h.ok, true);
  const html = await (await fetch(`${BASE}/`)).text();
  assert.match(html, /NYC311 Demo Portal — controlled replica, not the official site/);
});

test("step 1 renders the DOT customer-information shape with label/name/id/testid", async () => {
  const html = await (await fetch(`${BASE}/report/pothole?mode=normal`)).text();
  for (const n of ["first_name", "last_name", "house_number", "street_name", "city", "state", "zip", "email", "home_phone", "work_phone", "date_detected"]) {
    assert.match(html, new RegExp(`<label for="${n}">`), `label for ${n}`);
    assert.match(html, new RegExp(`id="${n}" name="${n}" data-testid="${n}"`), `input ${n}`);
  }
  assert.match(html, /data-testid="next" value="Next &gt;&gt;"/);
  assert.doesNotMatch(html, /g-recaptcha/);
});

test("normal: two-step flow → DEMO SR → status lookup", async () => {
  const draft = await step1("normal");
  const s2 = await (await fetch(`${BASE}/report/pothole/location?draft=${draft}&mode=normal`)).text();
  assert.match(s2, /data-testid="borough"/);
  assert.match(s2, /data-testid="submit"/);
  const r = await fetch(`${BASE}/report/pothole/submit`, form({ ...STEP2, draft, mode: "normal" }));
  assert.equal(r.status, 302);
  const loc = r.headers.get("location");
  const sr = decodeURIComponent(loc.split("/").pop());
  assert.match(sr, /^DEMO-\d{8}-[A-Z0-9]{6}$/);
  const conf = await (await fetch(new URL(loc, BASE))).text();
  assert.match(conf, new RegExp(`data-testid="sr-number">${sr}<`));
  assert.match(conf, /data-testid="confirmation">Your pothole report has been submitted\. Please keep this number for your records\./);
  const st = await fetch(`${BASE}/api/status/${sr}`);
  assert.equal(st.status, 200);
  const j = await st.json();
  assert.deepEqual(Object.keys(j).sort(), ["borough", "category", "createdAt", "sr", "status"]);
  assert.equal(j.status, "Open");
  assert.equal(j.borough, "Manhattan");
  assert.equal((await fetch(`${BASE}/api/status/DEMO-20260101-ZZZZZZ`)).status, 404);
});

test("step 1 validation: missing last name → 400 form-error", async () => {
  const r = await fetch(`${BASE}/report/pothole/step1`, form({ first_name: "Ada", mode: "normal" }));
  assert.equal(r.status, 400);
  assert.match(await r.text(), /data-testid="form-error"/);
});

test("captcha: block present on step 1 and POST rejected with 400", async () => {
  const html = await (await fetch(`${BASE}/report/pothole?mode=captcha`)).text();
  assert.match(html, /class="g-recaptcha[^"]*" data-sitekey="/);
  assert.match(html, /Verify you are human/);
  const r = await fetch(`${BASE}/report/pothole/step1`, form({ ...STEP1, mode: "captcha" }));
  assert.equal(r.status, 400);
  assert.match(await r.text(), /data-testid="captcha-error"/);
});

test("mode persists via cookie", async () => {
  const r = await fetch(`${BASE}/report/pothole?mode=captcha`);
  assert.match(r.headers.get("set-cookie") ?? "", /demo_mode=captcha/);
  const html = await (await fetch(`${BASE}/report/pothole`, { headers: { cookie: "demo_mode=captcha" } })).text();
  assert.match(html, /g-recaptcha/);
});

test("reject: step 2 re-rendered with form-error and no SR", async () => {
  const before = (await (await fetch(`${BASE}/api/requests`)).json()).requests.length;
  const draft = await step1("reject");
  const r = await fetch(`${BASE}/report/pothole/submit`, form({ ...STEP2, draft, mode: "reject" }));
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /data-testid="form-error">We could not locate this street in New York City\./);
  assert.doesNotMatch(html, /data-testid="sr-number"/);
  const afterN = (await (await fetch(`${BASE}/api/requests`)).json()).requests.length;
  assert.equal(afterN, before);
});

test("flaky: record persisted, then socket destroyed (no response)", async () => {
  const draft = await step1("flaky");
  await assert.rejects(fetch(`${BASE}/report/pothole/submit`, form({ ...STEP2, draft, description: "flaky-marker", mode: "flaky" })));
  const { requests } = await (await fetch(`${BASE}/api/requests`)).json();
  const rec = requests.find((x) => x.description === "flaky-marker");
  assert.ok(rec, "record visible in /api/requests");
  assert.match(rec.sr, /^DEMO-\d{8}-[A-Z0-9]{6}$/);
  assert.equal(rec.responseDelivered, false);
});

test("replayed POST never creates a second report (flaky + normal)", async () => {
  const draft = await step1("flaky");
  const body = { ...STEP2, draft, description: "replay-marker", mode: "flaky" };
  await assert.rejects(fetch(`${BASE}/report/pothole/submit`, form(body)));
  await assert.rejects(fetch(`${BASE}/report/pothole/submit`, form(body)));
  let { requests } = await (await fetch(`${BASE}/api/requests`)).json();
  assert.equal(requests.filter((x) => x.description === "replay-marker").length, 1);
  const d2 = await step1("normal");
  const b2 = { ...STEP2, draft: d2, description: "replay-normal", mode: "normal" };
  const l1 = (await fetch(`${BASE}/report/pothole/submit`, form(b2))).headers.get("location");
  const l2 = (await fetch(`${BASE}/report/pothole/submit`, form(b2))).headers.get("location");
  assert.equal(l1, l2);
  ({ requests } = await (await fetch(`${BASE}/api/requests`)).json());
  assert.equal(requests.filter((x) => x.description === "replay-normal").length, 1);
});

test("street-repair: single page happy path", async () => {
  const html = await (await fetch(`${BASE}/report/street-repair?mode=normal`)).text();
  for (const n of ["borough", "on_street", "cross_street_1", "restoration_type", "description"]) assert.match(html, new RegExp(`data-testid="${n}"`));
  const r = await fetch(`${BASE}/report/street-repair/submit`, form({ borough: "Brooklyn", on_street: "Atlantic Ave", cross_street_1: "Nevins St", restoration_type: "Trench", description: "Sunken trench", mode: "normal" }));
  assert.equal(r.status, 302);
  const sr = decodeURIComponent(r.headers.get("location").split("/").pop());
  assert.match(sr, /^DEMO-\d{8}-[A-Z0-9]{6}$/);
  const conf = await (await fetch(new URL(r.headers.get("location"), BASE))).text();
  assert.match(conf, /data-testid="confirmation">Your street repair complaint has been submitted/);
  const j = await (await fetch(`${BASE}/api/status/${sr}`)).json();
  assert.equal(j.category, "street-repair");
});

test("reset clears the store", async () => {
  await fetch(`${BASE}/api/reset`, { method: "POST" });
  const { requests } = await (await fetch(`${BASE}/api/requests`)).json();
  assert.equal(requests.length, 0);
});
