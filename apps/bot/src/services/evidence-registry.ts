/**
 * Maps Evidence ids → local file paths under .runs/ so the API can serve
 * evidence bytes at /api/evidence/:id without exposing paths. Persisted to
 * .runs/evidence-registry.json so restarts keep working.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Evidence } from "../core/contracts.js";
import { RUNS_DIR } from "../integrations/env.js";

const FILE = resolve(RUNS_DIR, "evidence-registry.json");
type Entry = { path: string; mime: string; attemptId: string; complaintId: string };
let cache: Record<string, Entry> | null = null;

function load(): Record<string, Entry> {
  if (cache) return cache;
  try {
    cache = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, "utf8")) as Record<string, Entry>) : {};
  } catch {
    cache = {};
  }
  return cache;
}

/** Called by the filing service after downloading an evidence file. Returns the API storage reference. */
export function registerEvidenceFile(evidence: Pick<Evidence, "id" | "mime" | "attemptId" | "complaintId">, localPath: string): string {
  const reg = load();
  const abs = resolve(localPath);
  if (!abs.startsWith(RUNS_DIR)) throw new Error("evidence must live under .runs/");
  reg[evidence.id] = { path: abs, mime: evidence.mime, attemptId: evidence.attemptId, complaintId: evidence.complaintId };
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(reg, null, 2));
  } catch (err) {
    console.warn("[evidence] could not persist registry:", (err as Error).message);
  }
  return evidenceUrl(evidence.id);
}

export function evidenceUrl(id: string): string {
  return `/api/evidence/${encodeURIComponent(id)}`;
}

export function resolveEvidencePath(id: string): { path: string; mime: string } | null {
  const e = load()[id];
  if (!e || !existsSync(e.path)) return null;
  return { path: e.path, mime: e.mime };
}
