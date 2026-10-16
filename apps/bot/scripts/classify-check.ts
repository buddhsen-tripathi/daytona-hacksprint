/**
 * Runs the real OpenRouter classifier over fixtures/example-complaints.json
 * and prints expected vs actual. Exits non-zero if any `clear` case
 * mismatches (target: 5/5 — subway delay, repaired patch ⇒ OUT_OF_SCOPE, bare photo, emergency, LIRR).
 *
 *   pnpm --filter @311relay/bot exec tsx scripts/classify-check.ts [--only id1,id2] [--dups]
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLASSIFY_CONFIDENCE_THRESHOLD } from "../src/core/contracts.js";
import { createOpenRouterClassifier } from "../src/services/classifier.js";
import { createDuplicateService } from "../src/services/duplicates.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const envFile = resolve(REPO, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

type Case = {
  id: string;
  scenario: string;
  clear: boolean;
  inputText: string | null;
  imageFixture: string | null;
  location: { latitude: number; longitude: number; address: string } | null;
  expected: {
    triage: string;
    /** Any of these triage values passes (e.g. a bare photo may be UNCLEAR or OUT_OF_SCOPE). */
    acceptTriage?: string[];
    category: string | null;
    asksForLocation?: boolean;
    emergency?: boolean;
    expectDuplicates?: boolean;
    transit?: { line?: string; directionIncludes?: string; stationIncludes?: string; delayMinutes?: number };
  };
};

const args = process.argv.slice(2);
const only = args.includes("--only") ? new Set(args[args.indexOf("--only") + 1].split(",")) : null;
const checkDups = args.includes("--dups");

const cases = (JSON.parse(readFileSync(resolve(REPO, "fixtures/example-complaints.json"), "utf8")) as Case[]).filter((c) => !only || only.has(c.id));
const classifier = createOpenRouterClassifier();
const dups = createDuplicateService();

type Row = { id: string; clear: boolean; expT: string; expC: string; actT: string; actC: string; conf: string; pass: boolean; ms: number; note: string };
const rows: Row[] = [];

await Promise.all(
  cases.map(async (c) => {
    const t0 = Date.now();
    try {
      const { result, usage } = await classifier.classify({
        text: c.inputText,
        imagePaths: c.imageFixture ? [resolve(REPO, c.imageFixture)] : [],
        priorDescription: null,
        locationKnown: !!c.location,
        conversation: [],
      });
      const exp = c.expected;
      let pass: boolean;
      if (exp.acceptTriage?.length) {
        pass = exp.acceptTriage.includes(result.triage) && result.category == null;
      } else if (exp.triage === "UNCLEAR") {
        // Ambiguous: UNCLEAR, or anything with low confidence (orchestrator will clarify), or EMERGENCY escalation.
        pass = result.triage === "UNCLEAR" || result.triage === "EMERGENCY" || result.confidence < CLASSIFY_CONFIDENCE_THRESHOLD;
      } else {
        pass = result.triage === exp.triage && (exp.category == null || result.category === exp.category) && (exp.triage !== "SUPPORTED" || result.confidence >= CLASSIFY_CONFIDENCE_THRESHOLD);
      }
      let note = result.clarifyingQuestion ? `Q: ${result.clarifyingQuestion}` : result.description;
      if (exp.transit) {
        const t = result.transit;
        const bad: string[] = [];
        if (exp.transit.line && t?.line !== exp.transit.line) bad.push(`line=${t?.line ?? "null"}`);
        if (exp.transit.directionIncludes && !(t?.direction ?? "").toLowerCase().includes(exp.transit.directionIncludes)) bad.push(`direction=${t?.direction ?? "null"}`);
        if (exp.transit.stationIncludes && !(t?.station ?? "").toLowerCase().includes(exp.transit.stationIncludes)) bad.push(`station=${t?.station ?? "null"}`);
        if (exp.transit.delayMinutes != null && t?.delayMinutes !== exp.transit.delayMinutes) bad.push(`delayMinutes=${t?.delayMinutes ?? "null"}`);
        if (bad.length) pass = false;
        note = `transit ${JSON.stringify(t)}${bad.length ? ` MISMATCH ${bad.join(",")}` : ""} | ${note}`;
      }
      if (checkDups && exp.expectDuplicates && c.location && result.category) {
        const d = await dups.findPotentialDuplicates({ category: result.category, latitude: c.location.latitude, longitude: c.location.longitude });
        note += ` | dups(${d.source}): ${d.candidates.map((x) => `${x.uniqueKey}@${x.distanceMeters}m=${x.matchScore}`).join(", ") || "none"}`;
        if (d.candidates.length === 0) pass = false;
      }
      rows.push({
        id: c.id,
        clear: c.clear,
        expT: exp.triage,
        expC: exp.category ?? "-",
        actT: result.triage,
        actC: result.category ?? "-",
        conf: result.confidence.toFixed(2),
        pass,
        ms: Date.now() - t0,
        note: `${note} [${usage.promptTokens ?? "?"}/${usage.completionTokens ?? "?"} tok]`,
      });
    } catch (err) {
      rows.push({ id: c.id, clear: c.clear, expT: c.expected.triage, expC: c.expected.category ?? "-", actT: "ERROR", actC: "-", conf: "-", pass: false, ms: Date.now() - t0, note: String((err as Error).message).slice(0, 200) });
    }
  }),
);

rows.sort((a, b) => cases.findIndex((c) => c.id === a.id) - cases.findIndex((c) => c.id === b.id));
const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
console.log(`model: ${process.env.OPENROUTER_VISION_MODEL || process.env.OPENROUTER_MODEL}`);
console.log([pad("case", 30), pad("clear", 5), pad("expected", 34), pad("actual", 34), pad("conf", 5), pad("ok", 4), pad("ms", 6), "note"].join(" "));
for (const r of rows) {
  console.log(
    [pad(r.id, 30), pad(r.clear ? "yes" : "", 5), pad(`${r.expT}/${r.expC}`, 34), pad(`${r.actT}/${r.actC}`, 34), pad(r.conf, 5), pad(r.pass ? "PASS" : "FAIL", 4), pad(String(r.ms), 6), r.note].join(" "),
  );
}
const clear = rows.filter((r) => r.clear);
const clearPass = clear.filter((r) => r.pass).length;
console.log(`\nclear cases: ${clearPass}/${clear.length}   all cases: ${rows.filter((r) => r.pass).length}/${rows.length}`);
process.exit(clearPass === clear.length ? 0 : 1);
