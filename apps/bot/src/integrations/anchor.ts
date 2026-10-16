/**
 * Anchor Browser provider (REST only). The BOT creates the cloud browser session and hands
 * the ephemeral CDP URL to the worker inside the sandbox — no API key ever enters the sandbox.
 * Playwright is connected by the worker (apps/worker), not here.
 */
import type { BrowserProvider, BrowserSessionInfo } from "../core/contracts.js";
import { env } from "./env.js";

const API = "https://api.anchorbrowser.io/v1";

type AnchorSession = { id: string; cdp_url: string; live_view_url?: string | null };
type AnchorRecording = { id?: string; is_primary?: boolean; file_link?: string | null; status?: string };

async function anchorFetch(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const key = env.ANCHOR_API_KEY;
  if (!key) throw new Error("ANCHOR_API_KEY is not set");
  const { timeoutMs = 30_000, ...rest } = init;
  return fetch(`${API}${path}`, {
    ...rest,
    headers: { "anchor-api-key": key, "content-type": "application/json", ...(rest.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * Download an Anchor recording file_link (an API /fetch URL that needs the anchor-api-key header).
 * The key is only ever sent to *.anchorbrowser.io; other hosts (signed CDN links) get no header.
 */
export async function downloadAnchorRecording(url: string, destPath: string, opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<{ bytes: number }> {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new Error("recording link is not https");
  const anchorHost = u.hostname === "anchorbrowser.io" || u.hostname.endsWith(".anchorbrowser.io");
  const key = env.ANCHOR_API_KEY;
  const res = await fetch(url, { headers: anchorHost && key ? { "anchor-api-key": key } : {}, redirect: "follow", signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000) });
  if (!res.ok) throw new Error(`recording download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (opts.maxBytes && buf.length > opts.maxBytes) throw new Error(`recording too large (${buf.length} bytes)`);
  if (buf.length < 1024) throw new Error(`recording too small (${buf.length} bytes)`);
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, buf);
  return { bytes: buf.length };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createAnchorBrowserProvider(opts: { maxDurationMin?: number; idleTimeoutMin?: number } = {}): BrowserProvider {
  return {
    name: "anchor",
    async createSession({ attemptId, onEvent }): Promise<BrowserSessionInfo> {
      const t0 = Date.now();
      onEvent("Starting cloud browser…", { provider: "anchor", attemptId });
      const res = await anchorFetch("/sessions", {
        method: "POST",
        body: JSON.stringify({
          session: {
            recording: { active: true },
            timeout: { max_duration: opts.maxDurationMin ?? 15, idle_timeout: opts.idleTimeoutMin ?? 5 },
          },
          browser: { headless: { active: false }, viewport: { width: 1280, height: 900 } },
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Anchor session create failed: HTTP ${res.status} ${body.slice(0, 200)}`);
      }
      const json = (await res.json()) as { data?: AnchorSession };
      const s = json.data;
      if (!s?.id || !s.cdp_url) throw new Error("Anchor session create returned no id/cdp_url");
      const ms = Date.now() - t0;
      onEvent(`Cloud browser ready (${s.id.slice(0, 8)}, ${(ms / 1000).toFixed(1)} s)`, { provider: "anchor", sessionId: s.id, durationMs: ms });
      if (s.live_view_url) onEvent("Live view available", { provider: "anchor", sessionId: s.id, liveViewUrl: s.live_view_url });

      let closed = false;
      return {
        id: s.id,
        provider: "anchor",
        cdpUrl: s.cdp_url,
        liveViewUrl: s.live_view_url ?? null,
        async close() {
          if (closed) return;
          closed = true;
          try {
            const r = await anchorFetch(`/sessions/${encodeURIComponent(s.id)}`, { method: "DELETE", timeoutMs: 15_000 });
            onEvent("Cloud browser closed", { provider: "anchor", sessionId: s.id, http: r.status });
          } catch (err) {
            onEvent("Cloud browser close failed (will time out on its own)", { provider: "anchor", sessionId: s.id, error: (err as Error).message });
          }
        },
        /** Recordings are finalized asynchronously after the session ends; poll briefly. */
        async getRecordingUrl(waitMs = 8_000): Promise<string | null> {
          const deadline = Date.now() + waitMs;
          for (;;) {
            try {
              const r = await anchorFetch(`/sessions/${encodeURIComponent(s.id)}/recordings`, { timeoutMs: 10_000 });
              if (r.ok) {
                const j = (await r.json()) as { data?: { items?: AnchorRecording[] } };
                const items = j.data?.items ?? [];
                const rec = items.find((i) => i.is_primary && i.file_link) ?? items.find((i) => i.file_link);
                if (rec?.file_link) return rec.file_link;
              }
            } catch {
              /* transient — retry until deadline */
            }
            if (Date.now() >= deadline) return null;
            await sleep(2_000);
          }
        },
      } as BrowserSessionInfo;
    },
  };
}
