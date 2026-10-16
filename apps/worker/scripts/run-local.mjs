#!/usr/bin/env node
// Local read-only check of the worker against the official NYC DOT pothole form. The worker fills the resident's
// fields and stops at the reCAPTCHA (HUMAN_ACTION_REQUIRED/CAPTCHA_REQUIRED) — it never submits.
//   node scripts/run-local.mjs [--category street-repair] [--no-name]
// Requires `pnpm --filter @311relay/worker build` first. Uses local Chrome (cdpUrl null); CHROME_PATH overrides.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workerDir = resolve(here, "..");
const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const category = flag("--category") === "street-repair" ? "street-repair-defect" : "street-pothole";
const noName = args.includes("--no-name");

const today = new Date();
const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

const runId = `local_${category === "street-pothole" ? "pothole" : "repair"}_real_${Date.now().toString(36)}`;
const workDir = resolve(workerDir, "../../.runs", runId);
const outDir = join(workDir, "out");
mkdirSync(outDir, { recursive: true });
const payload = {
  attemptId: runId,
  complaintId: "cmp_local",
  approvedVersion: 1,
  target: "real",
  category,
  formUrl: category === "street-pothole" ? "https://a841-dotvweb01.nyc.gov/potholeform" : "https://portal.311.nyc.gov/",
  allowedHosts: ["a841-dotvweb01.nyc.gov", "portal.311.nyc.gov"],
  extraHeaders: {},
  cdpUrl: null,
  liveViewUrl: null,
  realSubmitAuthorized: false,
  form: {
    description:
      category === "street-pothole" ? "Pothole about 2 ft wide in the right lane" : "Sunken trench patch about 3 ft long, an inch below street level",
    address: "1515 Broadway, Manhattan",
    borough: "Manhattan",
    latitude: 40.7577,
    longitude: -73.9857,
    contactName: noName ? null : "Ada Lovelace",
    contactEmail: null,
    contactPhone: null,
    dateObserved: iso,
  },
  limits: { totalTimeoutMs: 90000, stepTimeoutMs: 20000, maxNavigationRetries: 1 },
};
const payloadPath = join(workDir, "payload.json");
writeFileSync(payloadPath, JSON.stringify(payload, null, 2));

console.log(`[run-local] ${runId}: target=real category=${category} (read-only)`);
const t0 = Date.now();
const child = spawn(process.execPath, [join(workerDir, "dist/main.js"), payloadPath, outDir], { stdio: ["ignore", "pipe", "inherit"] });
let events = 0;
child.stdout.on("data", (b) => {
  for (const line of b.toString().split("\n")) {
    if (!line.startsWith("EVT ")) continue;
    events++;
    const e = JSON.parse(line.slice(4));
    console.log(`  [${e.step}] ${e.level === "info" ? "" : e.level.toUpperCase() + " "}${e.message}`);
  }
});
const code = await new Promise((r) => child.on("exit", r));
const result = JSON.parse(readFileSync(join(outDir, "result.json"), "utf8"));
console.log(`\n[run-local] exit=${code} in ${Date.now() - t0} ms, ${events} events`);
console.log(
  JSON.stringify(
    {
      status: result.status,
      errorCode: result.errorCode,
      officialRequestNumber: result.officialRequestNumber,
      submitClicked: result.submitClicked,
      finalUrl: result.finalUrl,
      confirmationText: result.confirmationText,
      message: result.message,
    },
    null,
    2,
  ),
);
console.log("evidence:");
for (const e of result.evidence) console.log(`  ${e.name}  (${e.type}, ${e.step}) ${e.summary}`);
console.log(`out dir: ${outDir}`);
process.exit(0);
