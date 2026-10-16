/**
 * Typed environment loader. Reads the repo-root `.env` (if present) without
 * overriding variables already set in the process environment.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
/** apps/bot/src/integrations → repo root */
export const REPO_ROOT = resolve(here, "../../../..");
export const RUNS_DIR = resolve(REPO_ROOT, ".runs");

let loaded = false;
export function loadDotEnv() {
  if (loaded) return;
  loaded = true;
  const file = resolve(REPO_ROOT, ".env");
  if (!existsSync(file)) return;
  try {
    const parsed = parseEnv(readFileSync(file, "utf8")) as Record<string, string>;
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch (err) {
    console.warn("[env] could not parse .env:", (err as Error).message);
  }
}
loadDotEnv();

function str(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}
function int(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && process.env[name] !== "" && process.env[name] !== undefined ? n : fallback;
}

/** Getters so tests/scripts can mutate process.env after import. */
export const env = {
  get TELEGRAM_BOT_TOKEN() { return str("TELEGRAM_BOT_TOKEN"); },
  get TELEGRAM_WEBHOOK_SECRET() { return str("TELEGRAM_WEBHOOK_SECRET"); },
  get PUBLIC_WEBHOOK_URL() { return str("PUBLIC_WEBHOOK_URL"); },
  get OPENROUTER_API_KEY() { return str("OPENROUTER_API_KEY"); },
  get OPENROUTER_MODEL() { return str("OPENROUTER_MODEL", "anthropic/claude-sonnet-4.5"); },
  get OPENROUTER_VISION_MODEL() { return str("OPENROUTER_VISION_MODEL", str("OPENROUTER_MODEL", "anthropic/claude-sonnet-4.5")); },
  get OPENROUTER_STT_MODEL() { return str("OPENROUTER_STT_MODEL"); },
  get DAYTONA_API_KEY() { return str("DAYTONA_API_KEY"); },
  get DAYTONA_SNAPSHOT() { return str("DAYTONA_SNAPSHOT"); },
  get SANDBOX_PROVIDER() { return str("SANDBOX_PROVIDER"); },
  get ANCHOR_API_KEY() { return str("ANCHOR_API_KEY"); },
  get BROWSER_PROVIDER() { return str("BROWSER_PROVIDER"); },
  get SURREALDB_URL() { return str("SURREALDB_URL"); },
  get SURREALDB_NAMESPACE() { return str("SURREALDB_NAMESPACE", "relay311"); },
  get SURREALDB_DATABASE() { return str("SURREALDB_DATABASE", "main"); },
  get SURREALDB_USERNAME() { return str("SURREALDB_USERNAME", "root"); },
  get SURREALDB_PASSWORD() { return str("SURREALDB_PASSWORD", "root"); },
  /** "memory" forces the in-memory store; anything else ⇒ SurrealDB (embedded or remote). */
  get STORE_BACKEND() { return str("STORE_BACKEND"); },
  get PHOENIX_COLLECTOR_ENDPOINT() { return str("PHOENIX_COLLECTOR_ENDPOINT", "http://localhost:6006"); },
  get PHOENIX_API_KEY() { return str("PHOENIX_API_KEY", str("ARIZE_API_KEY", str("ARISE_KEY"))); },
  get PHOENIX_PROJECT() { return str("PHOENIX_PROJECT", "311relay"); },
  get NYC_OPEN_DATA_APP_TOKEN() { return str("NYC_OPEN_DATA_APP_TOKEN"); },
  /** "1" lets real-site adapters click the FINAL Submit (after the resident's approval). Unset ⇒ dry run: fill everything, stop before Submit. */
  get ALLOW_REAL_SUBMIT() { return str("ALLOW_REAL_SUBMIT"); },
  get PORT_API() { return int("PORT_API", 3312); },
};

export function hasTelegram(): boolean {
  return env.TELEGRAM_BOT_TOKEN.length > 0;
}

export function webhookMode(): boolean {
  return hasTelegram() && env.PUBLIC_WEBHOOK_URL.length > 0 && env.TELEGRAM_WEBHOOK_SECRET.length > 0;
}

