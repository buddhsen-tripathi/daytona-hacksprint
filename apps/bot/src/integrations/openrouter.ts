/**
 * Thin OpenRouter chat-completions client with Zod-validated structured output.
 *
 * Strategy (design doc §19 "Model produces invalid JSON → retry safely or use
 * constrained fallback"):
 *  1. strict `json_schema` response_format (provider.require_parameters=true)
 *  2. HTTP 400 on the strict schema ⇒ retry once in plain JSON mode with the
 *     schema embedded in the prompt
 *  3. invalid JSON / Zod failure ⇒ retry once, feeding the error back
 *  4. still bad ⇒ throw OpenRouterError{kind:"schema"} (orchestrator asks a
 *     generic clarifying question)
 */
import { z } from "zod";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 45_000;

export type OpenRouterErrorKind = "missing_key" | "http" | "schema" | "timeout";

export class OpenRouterError extends Error {
  readonly kind: OpenRouterErrorKind;
  readonly status: number | null;
  readonly body: string | null;
  constructor(kind: OpenRouterErrorKind, message: string, opts: { status?: number | null; body?: string | null; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "OpenRouterError";
    this.kind = kind;
    this.status = opts.status ?? null;
    this.body = opts.body ?? null;
  }
}

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string | ContentPart[] };

export type ChatUsage = { promptTokens: number | null; completionTokens: number | null; costUsd: number | null };

export type ChatJsonOptions = {
  model: string;
  maxTokens?: number;
  temperature?: number;
  /** Name for the json_schema response format. */
  schemaName?: string;
  timeoutMs?: number;
  apiKey?: string;
};

export type ChatJsonResult<T> = {
  data: T;
  model: string;
  usage: ChatUsage;
  /** How many HTTP calls were made (1 = first try succeeded). */
  attempts: number;
  mode: "json_schema" | "json_prompt";
  raw: string;
};

/** Zod v4 → OpenAI-style strict JSON schema (no $schema/default/format; additionalProperties:false everywhere). */
export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { target: "draft-7", unrepresentable: "any" }) as Record<string, unknown>;
  return sanitizeSchema(js) as Record<string, unknown>;
}

const DROP_KEYS = new Set(["$schema", "default", "format", "pattern", "minLength", "maxLength", "$id", "examples"]);

export function sanitizeSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeSchema);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (DROP_KEYS.has(k)) continue;
    out[k] = sanitizeSchema(v);
  }
  if (out.type === "object" || (out.properties && typeof out.properties === "object")) {
    out.additionalProperties = false;
    // strict mode requires every property to be listed in `required`
    if (out.properties && typeof out.properties === "object") out.required = Object.keys(out.properties as object);
  }
  return out;
}

function parseUsage(json: any): ChatUsage {
  const u = json?.usage ?? {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return { promptTokens: num(u.prompt_tokens), completionTokens: num(u.completion_tokens), costUsd: num(u.cost) };
}

function addUsage(a: ChatUsage, b: ChatUsage): ChatUsage {
  const add = (x: number | null, y: number | null) => (x == null && y == null ? null : (x ?? 0) + (y ?? 0));
  return { promptTokens: add(a.promptTokens, b.promptTokens), completionTokens: add(a.completionTokens, b.completionTokens), costUsd: add(a.costUsd, b.costUsd) };
}

/** Extract a JSON object from model text (handles ```json fences and leading prose). */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* fall through */
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new SyntaxError("No JSON object found in model output");
}

type CallResult = { content: string; model: string; usage: ChatUsage };

async function callOnce(body: Record<string, unknown>, apiKey: string, timeoutMs: number): Promise<CallResult> {
  let res: Response;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/311relay",
        "X-Title": "311Relay",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = (err as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError") throw new OpenRouterError("timeout", `OpenRouter request timed out after ${timeoutMs}ms`, { cause: err });
    throw new OpenRouterError("http", `OpenRouter request failed: ${(err as Error)?.message ?? String(err)}`, { cause: err });
  }
  const text = await res.text();
  if (!res.ok) throw new OpenRouterError("http", `OpenRouter HTTP ${res.status}: ${text.slice(0, 500)}`, { status: res.status, body: text });
  let json: any;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new OpenRouterError("http", "OpenRouter returned a non-JSON body", { status: res.status, body: text, cause: err });
  }
  if (json?.error) {
    const code = typeof json.error.code === "number" ? json.error.code : res.status;
    throw new OpenRouterError("http", `OpenRouter error ${code}: ${json.error.message ?? "unknown"}`, { status: code, body: text });
  }
  const msg = json?.choices?.[0]?.message;
  let content: string = typeof msg?.content === "string" ? msg.content : Array.isArray(msg?.content) ? msg.content.map((p: any) => p?.text ?? "").join("") : "";
  if (!content && msg?.refusal) content = String(msg.refusal);
  return { content, model: typeof json?.model === "string" ? json.model : String(body.model), usage: parseUsage(json) };
}

function schemaPromptSuffix(jsonSchema: Record<string, unknown>) {
  return [
    "",
    "Respond with ONLY a single JSON object (no markdown, no prose) that validates against this JSON Schema:",
    JSON.stringify(jsonSchema),
  ].join("\n");
}

function withSchemaInSystem(messages: ChatMessage[], jsonSchema: Record<string, unknown>): ChatMessage[] {
  const suffix = schemaPromptSuffix(jsonSchema);
  const idx = messages.findIndex((m) => m.role === "system");
  if (idx < 0) return [{ role: "system", content: suffix.trim() }, ...messages];
  return messages.map((m, i) => (i === idx ? { ...m, content: typeof m.content === "string" ? m.content + "\n" + suffix : [...m.content, { type: "text", text: suffix }] } : m));
}

/**
 * Call OpenRouter and return Zod-validated JSON. Throws OpenRouterError.
 */
export async function chatJson<T>(schema: z.ZodType<T>, messages: ChatMessage[], opts: ChatJsonOptions): Promise<ChatJsonResult<T>> {
  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY ?? "";
  if (!apiKey) throw new OpenRouterError("missing_key", "OPENROUTER_API_KEY is not set");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const jsonSchema = toStrictJsonSchema(schema);
  const base: Record<string, unknown> = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 1200,
    temperature: opts.temperature ?? 0,
    usage: { include: true },
  };

  let mode: "json_schema" | "json_prompt" = "json_schema";
  let attempts = 0;
  let usage: ChatUsage = { promptTokens: null, completionTokens: null, costUsd: null };
  let convo: ChatMessage[] = messages;

  const bodyFor = (msgs: ChatMessage[]) =>
    mode === "json_schema"
      ? {
          ...base,
          messages: msgs,
          response_format: { type: "json_schema", json_schema: { name: opts.schemaName ?? "result", strict: true, schema: jsonSchema } },
          provider: { require_parameters: true },
        }
      : { ...base, messages: withSchemaInSystem(msgs, jsonSchema) };

  let call: CallResult;
  attempts++;
  try {
    call = await callOnce(bodyFor(convo), apiKey, timeoutMs);
  } catch (err) {
    // Strict schema rejected (or no provider supports it) ⇒ plain JSON mode once.
    if (err instanceof OpenRouterError && err.kind === "http" && (err.status === 400 || err.status === 404 || err.status === 422)) {
      mode = "json_prompt";
      attempts++;
      call = await callOnce(bodyFor(convo), apiKey, timeoutMs);
    } else throw err;
  }
  usage = addUsage(usage, call.usage);

  const validate = (content: string): { ok: true; data: T } | { ok: false; error: string } => {
    let parsed: unknown;
    try {
      parsed = extractJson(content);
    } catch (e) {
      return { ok: false, error: `Output was not valid JSON: ${(e as Error).message}` };
    }
    const r = schema.safeParse(parsed);
    if (r.success) return { ok: true, data: r.data };
    return { ok: false, error: `Output did not match the schema: ${z.prettifyError(r.error)}` };
  };

  let v = validate(call.content);
  if (!v.ok) {
    // One repair attempt with the error fed back.
    convo = [
      ...convo,
      { role: "assistant", content: call.content || "(empty)" },
      { role: "user", content: `${v.error}\nReturn ONLY the corrected JSON object.` },
    ];
    attempts++;
    const retry = await callOnce(bodyFor(convo), apiKey, timeoutMs);
    usage = addUsage(usage, retry.usage);
    call = retry;
    v = validate(retry.content);
    if (!v.ok) throw new OpenRouterError("schema", v.error, { body: retry.content });
  }
  return { data: v.data, model: call.model, usage, attempts, mode, raw: call.content };
}
