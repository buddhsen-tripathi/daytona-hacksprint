#!/usr/bin/env node
// Dry run of the MTA subway-delay adapter against the REAL contact.mta.info wizard. Never submits
// (realSubmitAuthorized: false) — must end HUMAN_ACTION_REQUIRED with the filled final page screenshot.
//   node scripts/run-mta-dryrun.mjs [--recipe] [--direction "toward Inwood"] [--line A] [--station "14 St"] [--borough Manhattan] [--no-station] [--no-time] [--name "Ada Lovelace"] [--email a@b.c]
// --recipe runs fixtures/recipes/subway-delay.json through the recipe adapter (automation "adapter:recipe") instead of
// the hand-written adapter. Requires `pnpm --filter @311relay/worker build` first. Uses local Chrome (cdpUrl null); HEADLESS=0 to watch.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workerDir = resolve(here, "..");
const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};

const useRecipe = args.includes("--recipe");
const runId = `mta_dryrun_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const workDir = resolve(workerDir, "../../.runs", runId);
const outDir = join(workDir, "out");
mkdirSync(outDir, { recursive: true });
const payload = {
  attemptId: runId,
  complaintId: "cmp_mta_dryrun",
  approvedVersion: 1,
  target: "real",
  category: "subway-delay",
  formUrl: "https://contact.mta.info/s/customer-feedback",
  allowedHosts: ["contact.mta.info", "mta.info", "new.mta.info"],
  extraHeaders: {},
  cdpUrl: null,
  liveViewUrl: null,
  realSubmitAuthorized: false,
  ...(useRecipe ? { automation: "adapter:recipe", recipe: JSON.parse(readFileSync(resolve(workerDir, "../../fixtures/recipes/subway-delay.json"), "utf8")) } : {}),
  form: {
    description: "A train held at 14 St for about 25 minutes around 8:30 this morning with no announcements.",
    address: null,
    borough: null,
    latitude: null,
    longitude: null,
    contactName: flag("--name", null),
    contactEmail: flag("--email", null),
    contactPhone: null,
    dateObserved: null,
    transit: {
      line: flag("--line", "A"),
      direction: flag("--direction", "downtown"),
      station: args.includes("--no-station") ? null : flag("--station", "14 St"),
      borough: flag("--borough", "Manhattan"),
      incidentTime: args.includes("--no-time") ? null : new Date(Date.now() - 3600_000).toISOString(),
      delayMinutes: 25,
    },
  },
  limits: { totalTimeoutMs: 150000, stepTimeoutMs: 25000, maxNavigationRetries: 1 },
};
const payloadPath = join(workDir, "payload.json");
writeFileSync(payloadPath, JSON.stringify(payload, null, 2));

console.log(`[mta-dryrun] ${runId}: ${useRecipe ? "RECIPE" : "hand-written"} line=${payload.form.transit.line} direction="${payload.form.transit.direction}" station=${payload.form.transit.station} realSubmitAuthorized=false`);
const t0 = Date.now();
const child = spawn(process.execPath, [join(workerDir, "dist/main.js"), payloadPath, outDir], { stdio: ["ignore", "pipe", "inherit"] });
let buf = "";
child.stdout.on("data", (b) => {
  buf += b.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.startsWith("EVT ")) continue;
    const e = JSON.parse(line.slice(4));
    console.log(`  [${e.step}] ${e.level === "info" ? "" : e.level.toUpperCase() + " "}${e.message}`);
  }
});
const code = await new Promise((r) => child.on("exit", r));
const result = JSON.parse(readFileSync(join(outDir, "result.json"), "utf8"));
const last = [...result.steps].reverse().find((s) => s.data && (s.data.filled || s.data.status));
console.log(`\n[mta-dryrun] exit=${code} in ${Date.now() - t0} ms`);
console.log(
  JSON.stringify(
    { status: result.status, errorCode: result.errorCode, submitClicked: result.submitClicked, officialRequestNumber: result.officialRequestNumber, finalUrl: result.finalUrl, message: result.message, filled: last?.data?.filled ?? null },
    null,
    2,
  ),
);
console.log("evidence:");
for (const e of result.evidence) console.log(`  ${join(outDir, e.name)}  (${e.type}, ${e.step}) ${e.summary}`);
const ok = result.status === "HUMAN_ACTION_REQUIRED" && result.errorCode === null && result.submitClicked === false;
console.log(ok ? "\nDRY RUN OK: stopped before the final Submit with everything filled." : "\nDRY RUN DID NOT END AT THE PRE-SUBMIT STOP (see message above).");
process.exit(ok ? 0 : 1);
