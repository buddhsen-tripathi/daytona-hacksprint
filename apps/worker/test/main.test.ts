import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { testPayload } from "./helpers.js";

const workerDir = resolve(__dirname, "..");
let distDir = "";

beforeAll(() => {
  // Compile the worker to a temp dir (same tsc settings as `build`) and run the real entry point.
  // Inside node_modules (git-ignored) so `playwright-core` still resolves from the compiled files.
  distDir = join(workerDir, "node_modules/.cache/relay-test-dist");
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });
  execFileSync(join(workerDir, "node_modules/.bin/tsc"), ["-p", join(workerDir, "tsconfig.json"), "--outDir", distDir], { stdio: "inherit" });
  writeFileSync(join(distDir, "package.json"), JSON.stringify({ type: "module" }));
});

function runWorker(payload: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "relay-worker-run-"));
  const payloadPath = join(dir, "payload.json");
  writeFileSync(payloadPath, JSON.stringify(payload));
  const out = join(dir, "out");
  const stdout = execFileSync(process.execPath, [join(distDir, "main.js"), payloadPath, out], { encoding: "utf8" });
  return { stdout, result: JSON.parse(readFileSync(join(out, "result.json"), "utf8")) };
}

describe("main.ts registry gate", () => {
  it("unknown category ⇒ FAILED/NO_ADAPTER before any browser opens", () => {
    // cdpUrl points nowhere: if the worker tried to open a browser it would end BROWSER_ERROR instead.
    const { stdout, result } = runWorker(testPayload({ category: "graffiti", cdpUrl: "ws://127.0.0.1:9/never" }));
    expect(result.status).toBe("FAILED");
    expect(result.errorCode).toBe("NO_ADAPTER");
    expect(result.submitClicked).toBe(false);
    expect(result.message).toMatch(/No filing adapter for category "graffiti"/);
    expect(stdout).not.toMatch(/connected to remote browser|launched local Chrome/);
  });

  it("automation none ⇒ FAILED/NO_ADAPTER", () => {
    const { result } = runWorker(testPayload({ category: "noise-from-neighbor", automation: "none", cdpUrl: "ws://127.0.0.1:9/never" }));
    expect([result.status, result.errorCode]).toEqual(["FAILED", "NO_ADAPTER"]);
  });
});
