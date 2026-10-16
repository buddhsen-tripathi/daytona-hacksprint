/**
 * Daytona sandbox provider — one disposable, isolated sandbox per filing attempt (design doc §10).
 *
 * provision(): create sandbox (snapshot DAYTONA_SNAPSHOT, fallback node:20-slim image) → upload
 * apps/worker (package.json + dist) and, for the demo target, apps/portal → `npm i --omit=dev`
 * (playwright-core only) in parallel with starting the portal on :3311 → signed preview URL so the
 * Anchor cloud browser can reach the replica. No API keys are ever uploaded: the worker receives
 * only the ephemeral CDP URL inside payload.json.
 *
 * CDP bridge: sandbox egress on this Daytona tier is firewalled (only essential services such as
 * the npm registry are reachable), so the worker cannot dial Anchor directly. Instead an in-sandbox
 * relay (`relay.mjs`, `ws` from npm) listens on :9222; the BOT dials Anchor's CDP websocket and the
 * relay's signed preview URL and pipes frames between them. The worker connects Playwright to
 * ws://127.0.0.1:9222/cdp. Side effect: Anchor's CDP URL (and anything in it) never enters the
 * sandbox, and the sandbox still has no general internet access.
 *
 * Signed preview URL tokens are never logged or stored separately (they are embedded in the
 * preview hostname; they are expired in destroy()).
 */
import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { Daytona, Image, type Sandbox } from "@daytona/sdk";
import type { FilingPayload, SandboxHandle, SandboxProvider } from "../core/contracts.js";
import { env } from "./env.js";
import { createEventLineParser, ensureWorkerBuilt, parseWorkerResult, PORTAL_DIR, PORTAL_PORT, safeEvidenceName, WORKER_DIR } from "./local-sandbox.js";

export const PREVIEW_HEADERS = { "X-Daytona-Skip-Preview-Warning": "true" } as const;

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function walk(dir: string, skip: (rel: string) => boolean, root = dir): Promise<string[]> {
  const out: string[] = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, ent.name);
    const rel = relative(root, abs);
    if (skip(rel)) continue;
    if (ent.isDirectory()) out.push(...(await walk(abs, skip, root)));
    else if (ent.isFile()) out.push(abs);
  }
  return out;
}

async function collectUploads(home: string, target: "demo" | "real") {
  const files: { source: Buffer; destination: string }[] = [];
  const add = async (abs: string, dest: string) => files.push({ source: await readFile(abs), destination: dest });
  await add(join(WORKER_DIR, "package.json"), `${home}/work/worker/package.json`);
  for (const f of await walk(join(WORKER_DIR, "dist"), () => false)) await add(f, `${home}/work/worker/dist/${relative(join(WORKER_DIR, "dist"), f)}`);
  if (target === "demo") {
    const skip = (rel: string) => /^(node_modules|tests?|\.)/.test(rel) || rel.endsWith(".log");
    for (const f of await walk(PORTAL_DIR, skip)) await add(f, `${home}/work/portal/${relative(PORTAL_DIR, f)}`);
  }
  return files;
}

/** In-sandbox health probe (images like node:20-slim have no curl). */
const HEALTH_SCRIPT = `const url = process.argv[2]; const deadline = Date.now() + Number(process.argv[3] || 30000);
for (;;) {
  try { const r = await fetch(url); if (r.ok) { console.log("HEALTH_OK"); process.exit(0); } } catch {}
  if (Date.now() > deadline) { console.log("HEALTH_TIMEOUT"); process.exit(1); }
  await new Promise((r) => setTimeout(r, 300));
}
`;

export const RELAY_PORT = 9222;

/** In-sandbox CDP relay: pairs the worker's local connection with the bot's bridge connection. */
const RELAY_SCRIPT = `import http from "node:http";
import { WebSocketServer } from "ws";
const secret = process.argv[2];
const port = Number(process.argv[3] || 9222);
const server = http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, bridge: !!bridge, worker: !!worker })); return; }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 * 1024 });
let bridge = null, worker = null;
const toWorker = [], toBridge = [];
const send = (ws, q, data, isBinary) => (ws && ws.readyState === 1 ? ws.send(data, { binary: isBinary }) : q.push([data, isBinary]));
const flush = (ws, q) => { while (q.length) { const [d, b] = q.shift(); ws.send(d, { binary: b }); } };
wss.on("connection", (ws, req) => {
  const url = req.url || "";
  if (url === "/bridge/" + secret) {
    if (bridge) { ws.close(1013, "bridge busy"); return; }
    bridge = ws; flush(ws, toBridge); console.log("bridge connected");
    ws.on("message", (d, b) => send(worker, toWorker, d, b));
    ws.on("close", () => { console.log("bridge closed"); bridge = null; worker && worker.close(); });
  } else if (url.startsWith("/bridge")) {
    ws.close(1008, "forbidden");
  } else {
    if (worker) { ws.close(1013, "worker busy"); return; }
    worker = ws; flush(ws, toWorker); console.log("worker connected");
    ws.on("message", (d, b) => send(bridge, toBridge, d, b));
    ws.on("close", () => { console.log("worker closed"); worker = null; bridge && bridge.close(); });
  }
});
server.listen(port, "0.0.0.0", () => console.log("relay listening", port));
`;

type Bridge = { close(): void; stats: { up: number; down: number } };

/** Bot side of the CDP bridge: Anchor CDP websocket <-> relay preview websocket. */
async function openCdpBridge(anchorCdpUrl: string, relayWsUrl: string, headers: Record<string, string>): Promise<Bridge> {
  const WS = globalThis.WebSocket as unknown as new (url: string, init?: unknown) => WebSocket;
  const stats = { up: 0, down: 0 };
  const opened = (ws: WebSocket, label: string) =>
    new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${label} websocket open timeout`)), 20_000);
      ws.addEventListener("open", () => (clearTimeout(t), res()), { once: true });
      ws.addEventListener("error", () => (clearTimeout(t), rej(new Error(`${label} websocket error`))), { once: true });
    });
  const relay = new WS(relayWsUrl, { headers });
  relay.binaryType = "arraybuffer";
  await opened(relay, "relay");
  const anchor = new WS(anchorCdpUrl);
  anchor.binaryType = "arraybuffer";
  try {
    await opened(anchor, "anchor");
  } catch (err) {
    relay.close();
    throw err;
  }
  anchor.addEventListener("message", (ev) => {
    stats.down++;
    if (relay.readyState === 1) relay.send(ev.data as string | ArrayBuffer);
  });
  relay.addEventListener("message", (ev) => {
    stats.up++;
    if (anchor.readyState === 1) anchor.send(ev.data as string | ArrayBuffer);
  });
  const closeBoth = () => {
    try { anchor.close(); } catch { /* already closed */ }
    try { relay.close(); } catch { /* already closed */ }
  };
  anchor.addEventListener("close", closeBoth);
  relay.addEventListener("close", closeBoth);
  return { close: closeBoth, stats };
}

export function createDaytonaSandboxProvider(opts: { daytona?: Daytona } = {}): SandboxProvider {
  let client = opts.daytona ?? null;
  const daytona = () => (client ??= new Daytona());

  return {
    name: "daytona",
    async provision({ attemptId, target, portalMode, onEvent }): Promise<SandboxHandle> {
      const tAll = Date.now();
      ensureWorkerBuilt(onEvent);

      // 1. create
      onEvent("Creating isolated sandbox…", { provider: "daytona" });
      const tc = Date.now();
      const base = {
        labels: { app: "311relay", attempt: attemptId, target },
        autoStopInterval: 15,
        autoDeleteInterval: 0,
      };
      let sandbox: Sandbox;
      const snapshot = env.DAYTONA_SNAPSHOT;
      try {
        sandbox = snapshot
          ? await daytona().create({ ...base, snapshot }, { timeout: 120 })
          : await daytona().create({ ...base, image: Image.base("node:20-slim") }, { timeout: 300 });
      } catch (err) {
        if (!snapshot) throw err;
        onEvent(`Snapshot ${snapshot} unavailable, building node:20-slim…`, { error: (err as Error).message });
        sandbox = await daytona().create({ ...base, image: Image.base("node:20-slim") }, { timeout: 300 });
      }
      const createMs = Date.now() - tc;
      onEvent(`Sandbox ready (${sandbox.id.slice(0, 8)}, ${secs(createMs)})`, { provider: "daytona", sandboxId: sandbox.id, durationMs: createMs, snapshot: snapshot || "node:20-slim" });

      let previewToken: string | null = null;
      let relayToken: string | null = null;
      let bridge: Bridge | null = null;
      let destroyed = false;
      const destroy = async () => {
        if (destroyed) return;
        destroyed = true;
        const td = Date.now();
        bridge?.close();
        if (previewToken) await sandbox.expireSignedPreviewUrl(PORTAL_PORT, previewToken).catch(() => {});
        if (relayToken) await sandbox.expireSignedPreviewUrl(RELAY_PORT, relayToken).catch(() => {});
        previewToken = null;
        relayToken = null;
        try {
          await sandbox.delete(60);
          onEvent(`Sandbox destroyed (${sandbox.id.slice(0, 8)}, ${secs(Date.now() - td)})`, { provider: "daytona", sandboxId: sandbox.id, durationMs: Date.now() - td });
        } catch (err) {
          onEvent("Sandbox delete failed (auto-stop/auto-delete will reclaim it)", { sandboxId: sandbox.id, error: (err as Error).message });
        }
      };

      try {
        const home = (await sandbox.getUserHomeDir().catch(() => null)) || "/home/daytona";
        const work = `${home}/work`;

        // 2. upload
        const tu = Date.now();
        const files = await collectUploads(home, target);
        files.push({ source: Buffer.from(HEALTH_SCRIPT), destination: `${work}/health.mjs` });
        files.push({ source: Buffer.from(RELAY_SCRIPT), destination: `${work}/relay/relay.mjs` });
        files.push({ source: Buffer.from(JSON.stringify({ name: "cdp-relay", private: true, type: "module", dependencies: { ws: "8.22.0" } })), destination: `${work}/relay/package.json` });
        await sandbox.process.executeCommand(`sh -c "mkdir -p ${work}/worker/dist ${work}/portal ${work}/out ${work}/relay"`, undefined, undefined, 30);
        await sandbox.fs.uploadFiles(files, 120);
        const uploadMs = Date.now() - tu;
        onEvent(`Uploaded worker${target === "demo" ? " + demo portal" : ""} (${files.length} files, ${secs(uploadMs)})`, { files: files.length, durationMs: uploadMs });

        // 3. npm i (playwright-core) ‖ start portal
        const install = (async () => {
          onEvent("Installing browser driver…", { package: "playwright-core" });
          const ti = Date.now();
          const r = await sandbox.process.executeCommand(`sh -c "cd ${work}/worker && npm i --omit=dev --no-audit --no-fund 2>&1"`, undefined, undefined, 180);
          const ms = Date.now() - ti;
          if (r.exitCode !== 0) throw new Error(`npm install failed (exit ${r.exitCode}): ${r.result.slice(-400)}`);
          onEvent(`Browser driver installed (${secs(ms)})`, { durationMs: ms });
          return ms;
        })();

        const portal = (async (): Promise<{ url: string; ms: number } | null> => {
          if (target !== "demo") return null;
          const tp = Date.now();
          let h = { result: "", exitCode: -1 };
          for (let attemptNo = 1; attemptNo <= 2 && !h.result.includes("HEALTH_OK"); attemptNo++) {
            const sid = `portal-${attemptNo}`;
            await sandbox.process.createSession(sid);
            await sandbox.process.executeSessionCommand(sid, {
              command: `cd ${work}/portal && PORT=${PORTAL_PORT} MODE=${portalMode} node server.js > ${work}/portal-${attemptNo}.log 2>&1`,
              runAsync: true,
            });
            h = await sandbox.process
              .executeCommand(`node ${work}/health.mjs http://127.0.0.1:${PORTAL_PORT}/health 15000`, undefined, undefined, 25)
              .catch((err: Error) => ({ result: `health probe error: ${err.message}`, exitCode: -1 }));
            if (!h.result.includes("HEALTH_OK") && attemptNo === 1) {
              onEvent("Demo portal slow to start, restarting it…", { attempt: attemptNo });
              await sandbox.process.deleteSession(sid).catch(() => {});
            }
          }
          if (!h.result.includes("HEALTH_OK")) {
            const log = await sandbox.process.executeCommand(`sh -c "tail -c 600 ${work}/portal-2.log"`, undefined, undefined, 10).catch(() => null);
            throw new Error(`demo portal did not become healthy in the sandbox: ${log?.result ?? h.result}`);
          }
          const signed = await sandbox.getSignedPreviewUrl(PORTAL_PORT, 3600);
          previewToken = signed.token;
          const url = signed.url.replace(/\/+$/, "");
          // verify from the bot side, like the cloud browser will reach it
          let ok = false;
          for (let i = 0; i < 5 && !ok; i++) {
            try {
              const r = await fetch(`${url}/health`, { headers: PREVIEW_HEADERS, signal: AbortSignal.timeout(8_000) });
              ok = r.ok;
            } catch {
              /* retry */
            }
            if (!ok) await sleep(1_000);
          }
          if (!ok) throw new Error("demo portal preview URL not reachable from outside the sandbox");
          const ms = Date.now() - tp;
          onEvent(`Demo portal live (${portalMode} mode, ${secs(ms)})`, { portalMode, durationMs: ms });
          return { url, ms };
        })();

        const relaySecret = randomBytes(18).toString("base64url");
        const relay = (async (): Promise<{ wsUrl: string; ms: number }> => {
          const tr = Date.now();
          const r = await sandbox.process.executeCommand(`sh -c "cd ${work}/relay && npm i --omit=dev --no-audit --no-fund 2>&1"`, undefined, undefined, 120);
          if (r.exitCode !== 0) throw new Error(`relay install failed (exit ${r.exitCode}): ${r.result.slice(-300)}`);
          await sandbox.process.createSession("relay");
          await sandbox.process.executeSessionCommand("relay", {
            command: `cd ${work}/relay && node relay.mjs ${relaySecret} ${RELAY_PORT} > ${work}/relay.log 2>&1`,
            runAsync: true,
          });
          const h = await sandbox.process.executeCommand(`node ${work}/health.mjs http://127.0.0.1:${RELAY_PORT}/health 20000`, undefined, undefined, 30);
          if (!h.result.includes("HEALTH_OK")) throw new Error("CDP relay did not start in the sandbox");
          const signed = await sandbox.getSignedPreviewUrl(RELAY_PORT, 3600);
          relayToken = signed.token;
          const wsUrl = `${signed.url.replace(/\/+$/, "").replace(/^http/, "ws")}/bridge/${relaySecret}`;
          const ms = Date.now() - tr;
          onEvent(`Secure browser channel ready (${secs(ms)})`, { durationMs: ms });
          return { wsUrl, ms };
        })();

        const [installMs, portalRes, relayRes] = await Promise.all([install, portal, relay]);
        const totalMs = Date.now() - tAll;
        onEvent(`Isolated worker provisioned (${secs(totalMs)})`, { durationMs: totalMs, createMs, uploadMs, installMs, portalMs: portalRes?.ms ?? null, relayMs: relayRes.ms });

        const handle: SandboxHandle = {
          id: sandbox.id,
          provider: "daytona",
          portalUrl: portalRes?.url ?? null,
          portalHeaders: target === "demo" ? { ...PREVIEW_HEADERS } : {},

          async runWorker(payload: FilingPayload, onWorkerEvent) {
            const tw = Date.now();
            let sandboxPayload = payload;
            if (payload.cdpUrl) {
              // Anchor's CDP URL stays in the bot; the worker talks to the in-sandbox relay.
              bridge = await openCdpBridge(payload.cdpUrl, relayRes.wsUrl, PREVIEW_HEADERS);
              sandboxPayload = { ...payload, cdpUrl: `ws://127.0.0.1:${RELAY_PORT}/cdp` };
              onEvent(`Browser bridged into sandbox (${secs(Date.now() - tw)})`, { durationMs: Date.now() - tw });
            }
            await sandbox.fs.uploadFiles([{ source: Buffer.from(JSON.stringify(sandboxPayload, null, 2)), destination: `${work}/payload.json` }], 30);
            onEvent("Running filing worker…", { provider: "daytona", sandboxId: sandbox.id });
            const timeoutMs = payload.limits.totalTimeoutMs + 30_000;
            const sid = "worker";
            await sandbox.process.createSession(sid);
            const cmd = await sandbox.process.executeSessionCommand(sid, {
              command: `cd ${work}/worker && node dist/main.js ${work}/payload.json ${work}/out`,
              runAsync: true,
            });
            const cmdId = cmd.cmdId!;
            let stdout = "";
            let stderr = "";
            const parser = createEventLineParser(onWorkerEvent);

            // Live streaming of stdout so EVT lines reach Telegram while the worker runs.
            let timedOut = false;
            const streamed = sandbox.process
              .getSessionCommandLogs(
                sid,
                cmdId,
                (chunk) => {
                  stdout += chunk;
                  parser.push(chunk);
                },
                (chunk) => (stderr += chunk),
              )
              .then(() => true)
              .catch(() => false);
            let timerHandle: NodeJS.Timeout | undefined;
            const timer = new Promise<boolean>((res) => {
              timerHandle = setTimeout(() => {
                timedOut = true;
                res(false);
              }, timeoutMs);
            });
            const streamOk = await Promise.race([streamed, timer]);
            clearTimeout(timerHandle);
            parser.end();

            // Exit code (poll until the command reports one, or give up on timeout).
            let exitCode = -1;
            const exitDeadline = timedOut ? Date.now() : Math.max(Date.now() + 5_000, streamOk ? 0 : tw + timeoutMs);
            for (;;) {
              const info = await sandbox.process.getSessionCommand(sid, cmdId).catch(() => null);
              if (info?.exitCode !== undefined && info?.exitCode !== null) {
                exitCode = info.exitCode;
                break;
              }
              if (Date.now() >= exitDeadline) break;
              await sleep(1_000);
            }

            // Streaming failed (e.g. websocket unavailable) ⇒ fetch a log snapshot and replay missed events.
            if (!streamOk) {
              const snap = await sandbox.process.getSessionCommandLogs(sid, cmdId).catch(() => null);
              if (snap) {
                let seen = 0;
                const already = parser.count;
                const replay = createEventLineParser((e) => {
                  if (++seen > already) onWorkerEvent(e);
                });
                replay.push(snap.stdout ?? snap.output ?? "");
                replay.end();
                stdout = snap.stdout ?? snap.output ?? stdout;
                stderr = snap.stderr ?? stderr;
              }
            }

            const bridgeStats = bridge?.stats ?? null;
            bridge?.close();
            bridge = null;
            const raw = await sandbox.fs.downloadFile(`${work}/out/result.json`, 30).catch(() => null);
            const { result, error } = parseWorkerResult(raw);
            const ms = Date.now() - tw;
            onEvent(`Filing worker finished (exit ${exitCode}${timedOut ? ", timed out" : ""}, ${secs(ms)})`, {
              exitCode,
              timedOut,
              durationMs: ms,
              streamed: streamOk,
              resultError: error,
              cdpFrames: bridgeStats,
            });
            return { result, stdout: stdout + (stderr ? `\n[stderr]\n${stderr}` : ""), exitCode };
          },

          async downloadEvidence(name: string) {
            return sandbox.fs.downloadFile(`${work}/out/${safeEvidenceName(name)}`, 60);
          },

          destroy,
        };
        return handle;
      } catch (err) {
        await destroy();
        throw err;
      }
    },
  };
}

/** For smoke checks: true when the sandbox no longer exists (or is being destroyed). */
export async function daytonaSandboxGone(id: string, client = new Daytona()): Promise<{ gone: boolean; state: string | null }> {
  try {
    const s = await client.get(id);
    const state = String(s.state ?? "");
    return { gone: /destroy|delet/i.test(state), state };
  } catch {
    return { gone: true, state: null };
  }
}
