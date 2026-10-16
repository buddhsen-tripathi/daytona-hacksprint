/**
 * Arize Phoenix tracing (design doc §13). Implements the `Tracer` contract.
 *
 * - `register()` from @arizeai/phoenix-otel builds a NodeTracerProvider and
 *   installs the AsyncLocalStorage context manager. It runs inside
 *   `createTracer()` BEFORE anything touches the context API — otherwise the
 *   no-op context manager silently drops the session context.
 * - Spans are created through an `OITracer` so `setSession/setUser/setMetadata/
 *   setTags` context attributes are copied onto every span of a Telegram chat.
 * - Export is filtered to spans that carry `openinference.span.kind`.
 * - Span kind is derived from the span name (§13.1 hierarchy).
 * - Evaluations (§13.2) are written as span attributes AND, best effort, as
 *   Phoenix span annotations through @arizeai/phoenix-client.
 * - Everything attached to a span goes through `redact()`.
 */
import { ROOT_CONTEXT, SpanStatusCode, context, propagation, trace, type Attributes, type Span } from "@opentelemetry/api";
import {
  MimeType,
  OITracer,
  OpenInferenceSpanKind,
  SemanticConventions,
  detachGlobalTracerProvider,
  getDefaultSpanProcessor,
  getEvaluationAttributes,
  getInputAttributes,
  getLLMAttributes,
  getMetadata,
  getMetadataAttributes,
  getOutputAttributes,
  getRetrieverAttributes,
  getToolAttributes,
  register,
  setMetadata,
  setSession,
  setTags,
  setUser,
  type NodeTracerProvider,
  type RegisterParams,
} from "@arizeai/phoenix-otel";
import type { SpanHelpers, Tracer } from "../core/contracts.js";
import { env } from "./env.js";

type SpanProcessor = NonNullable<RegisterParams["spanProcessors"]>[number];
type ReadableSpan = Parameters<SpanProcessor["onEnd"]>[0];

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------
export const MAX_ATTR_CHARS = 4000;
const SENSITIVE_KEY =
  /(token|secret|password|passwd|api[-_]?key|authorization|cookie|session[-_]?key|cdp|signed|phone|email|contactname|contact_name|localpath|imagepaths|path$|fileid|file_id|bearer|credential)/i;
const STRING_RULES: [RegExp, string][] = [
  [/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, "[data-url]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"],
  [/\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g, "[telegram-token]"],
  [/\b(?:sk|pk|rk|phx|dtn|ak|ghp|gho|xox[abp]|anchor|sk-or-v1)[-_][A-Za-z0-9_-]{12,}\b/gi, "[secret]"],
  [/([?&](?:token|key|api[-_]?key|secret|signature|sig|auth|access_token)=)[^&\s"']+/gi, "$1[REDACTED]"],
  [/\b(?:secret|password|api[-_]?key|token)\s*[:=]\s*["']?[^\s"',}]+/gi, "[REDACTED]"],
  [/wss?:\/\/[^\s"']*(?:connect|cdp|devtools)[^\s"']*/gi, "[cdp-url]"],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]"],
  [/(?:\+?1[-.\s]?)?\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g, "[phone]"],
  [/(?:\/Users|\/home|\/private|\/var\/folders|\/tmp|\/work)\/[^\s"',)]+/g, "[path]"],
];

export function redactString(s: string): string {
  let out = s;
  for (const [re, rep] of STRING_RULES) out = out.replace(re, rep);
  return out.length > MAX_ATTR_CHARS ? `${out.slice(0, MAX_ATTR_CHARS)}…[truncated]` : out;
}

/** Deep-redact any value: sensitive keys dropped, strings scrubbed + truncated. */
export function redact(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) return redactString(value.message);
  if (depth > 6) return "[depth]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined || typeof v === "function") continue;
      out[k] = SENSITIVE_KEY.test(k) ? (v == null ? v : "[REDACTED]") : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

function toJson(value: unknown): string {
  try {
    return redactString(JSON.stringify(redact(value)));
  } catch {
    return "[unserializable]";
  }
}

function cleanAttrs(attrs: Record<string, string | number | boolean | null | undefined>): Attributes {
  const out: Attributes = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (SENSITIVE_KEY.test(k)) continue;
    out[k] = typeof v === "string" ? redactString(v) : v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Span kinds (§13.1)
// ---------------------------------------------------------------------------
export function spanKindFor(name: string): OpenInferenceSpanKind {
  if (name === "intake.extract" || name === "routing.classify" || name.startsWith("llm.")) return OpenInferenceSpanKind.LLM;
  if (name === "nyc311.search_duplicates" || name === "mta.live_alerts" || name === "memory.recall") return OpenInferenceSpanKind.RETRIEVER;
  if (name === "memory.remember") return OpenInferenceSpanKind.TOOL;
  if (name === "location.validate" || name === "telegram.respond" || name === "receipt.verify") return OpenInferenceSpanKind.TOOL;
  if (/^(daytona|anchor|browser|sandbox|worker|geosearch|nyc311)\./.test(name)) return OpenInferenceSpanKind.TOOL;
  if (/^(eval|evaluation)\./.test(name)) return OpenInferenceSpanKind.EVALUATOR;
  // telegram.message, draft.generate, user.approve, surrealdb.*, filing.* …
  return OpenInferenceSpanKind.CHAIN;
}

// ---------------------------------------------------------------------------
// Export filter: only OpenInference spans reach Phoenix
// ---------------------------------------------------------------------------
class OpenInferenceOnlyProcessor implements SpanProcessor {
  constructor(private readonly delegate: SpanProcessor) {}
  onStart(span: Parameters<SpanProcessor["onStart"]>[0], ctx: Parameters<SpanProcessor["onStart"]>[1]) {
    this.delegate.onStart(span, ctx);
  }
  onEnd(span: ReadableSpan) {
    if (span.attributes[SemanticConventions.OPENINFERENCE_SPAN_KIND] !== undefined) this.delegate.onEnd(span);
  }
  forceFlush() {
    return this.delegate.forceFlush();
  }
  shutdown() {
    return this.delegate.shutdown();
  }
}

// ---------------------------------------------------------------------------
// Phoenix REST (annotations) — best effort, never throws
// ---------------------------------------------------------------------------
export type AnnotationTarget = { spanId: string } | { traceId: string } | { sessionId: string };
export type AnnotationInput = { name: string; label?: string; score?: number; explanation?: string; metadata?: Record<string, unknown> };

export function phoenixBaseUrl(endpoint = env.PHOENIX_COLLECTOR_ENDPOINT): string | null {
  const e = (endpoint ?? "").trim();
  if (!e || /^(off|none|disabled|false)$/i.test(e)) return null;
  return e.replace(/\/v1\/traces\/?$/, "").replace(/\/+$/, "");
}

/** Post one annotation to Phoenix (span / trace / session). Returns false on any failure. */
export async function logPhoenixAnnotation(
  target: AnnotationTarget,
  a: AnnotationInput,
  opts: { baseUrl?: string | null; apiKey?: string; annotatorKind?: "CODE" | "LLM" | "HUMAN"; retries?: number; retryDelayMs?: number } = {},
): Promise<boolean> {
  const baseUrl = opts.baseUrl === undefined ? phoenixBaseUrl() : opts.baseUrl;
  if (!baseUrl) return false;
  try {
    const { createClient } = await import("@arizeai/phoenix-client");
    const apiKey = opts.apiKey ?? env.PHOENIX_API_KEY;
    const client = createClient({ options: { baseUrl, headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} } });
    const base = {
      name: a.name,
      label: a.label,
      score: a.score,
      explanation: a.explanation ? redactString(a.explanation) : undefined,
      metadata: a.metadata ? (redact(a.metadata) as Record<string, unknown>) : undefined,
      annotatorKind: opts.annotatorKind ?? "CODE",
    };
    const send = async () => {
      if ("spanId" in target) {
        const { addSpanAnnotation } = await import("@arizeai/phoenix-client/spans");
        await addSpanAnnotation({ client, spanAnnotation: { ...base, spanId: target.spanId }, sync: true });
      } else if ("traceId" in target) {
        const { addTraceAnnotation } = await import("@arizeai/phoenix-client/traces");
        await addTraceAnnotation({ client, traceAnnotation: { ...base, traceId: target.traceId }, sync: true });
      } else {
        const { addSessionAnnotation } = await import("@arizeai/phoenix-client/sessions");
        await addSessionAnnotation({ client, sessionAnnotation: { ...base, sessionId: target.sessionId }, sync: true });
      }
    };
    // Phoenix ingests spans asynchronously: a fresh span/trace 404s for a moment.
    const retries = opts.retries ?? 5;
    for (let i = 0; ; i++) {
      try {
        await send();
        return true;
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (i >= retries || !/404|not found/i.test(msg)) throw err;
        await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 1000));
      }
    }
  } catch (err) {
    if (process.env.ARIZE_DEBUG) console.warn("[arize] annotation failed:", (err as Error).message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tracer
// ---------------------------------------------------------------------------
export type TracerOptions = {
  /** Phoenix base URL (http://localhost:6006). null/"off" ⇒ nothing exported. Defaults to PHOENIX_COLLECTOR_ENDPOINT. */
  endpoint?: string | null;
  apiKey?: string;
  projectName?: string;
  /** Replace the exporter entirely (tests use a capturing processor). */
  spanProcessors?: SpanProcessor[];
  batch?: boolean;
  /** Post evaluations to Phoenix as span annotations (default: when an endpoint is configured). */
  annotations?: boolean;
};

export type PhoenixTracer = Tracer & {
  provider: NodeTracerProvider;
  projectName: string;
  baseUrl: string | null;
  currentSpanId(): string | null;
  shutdown(): Promise<void>;
};

let activeProvider: NodeTracerProvider | null = null;

export function createTracer(opts: TracerOptions = {}): PhoenixTracer {
  const projectName = opts.projectName ?? env.PHOENIX_PROJECT;
  const baseUrl = opts.endpoint === null ? null : phoenixBaseUrl(opts.endpoint ?? env.PHOENIX_COLLECTOR_ENDPOINT);
  const apiKey = opts.apiKey ?? env.PHOENIX_API_KEY;
  const exporting = !opts.spanProcessors && !!baseUrl;
  const processors: SpanProcessor[] =
    opts.spanProcessors ??
    (baseUrl ? [new OpenInferenceOnlyProcessor(getDefaultSpanProcessor({ url: baseUrl, apiKey: apiKey || undefined, batch: opts.batch ?? true }))] : []);

  // 1) provider + global context manager FIRST.
  const provider = register({ projectName, spanProcessors: processors, global: true });
  activeProvider = provider;
  const oi = new OITracer({ tracer: provider.getTracer("311relay") });
  const annotate = opts.annotations ?? exporting;
  const pending: { spanId: string; a: AnnotationInput }[] = [];
  let drainTimer: NodeJS.Timeout | null = null;

  async function drain() {
    drainTimer = null;
    if (!pending.length) return;
    try {
      await provider.forceFlush();
    } catch {
      /* ignore */
    }
    const batch = pending.splice(0, pending.length);
    await Promise.all(batch.map((p) => logPhoenixAnnotation({ spanId: p.spanId }, p.a, { baseUrl, apiKey })));
  }

  function helpersFor(span: Span): SpanHelpers {
    const setAll = (attrs: Attributes) => span.setAttributes(attrs);
    return {
      set(k, v) {
        if (SENSITIVE_KEY.test(k)) return;
        span.setAttribute(k, typeof v === "string" ? redactString(v) : Array.isArray(v) ? v.map((s) => redactString(String(s))) : v);
      },
      input(value) {
        setAll(
          typeof value === "string"
            ? getInputAttributes({ value: redactString(value), mimeType: MimeType.TEXT })
            : getInputAttributes({ value: toJson(value), mimeType: MimeType.JSON }),
        );
      },
      output(value) {
        setAll(
          typeof value === "string"
            ? getOutputAttributes({ value: redactString(value), mimeType: MimeType.TEXT })
            : getOutputAttributes({ value: toJson(value), mimeType: MimeType.JSON }),
        );
      },
      llm(o) {
        const tc = o.tokenCount;
        const tokenCount = tc
          ? {
              ...(tc.prompt != null ? { prompt: tc.prompt } : {}),
              ...(tc.completion != null ? { completion: tc.completion } : {}),
              ...(tc.total != null ? { total: tc.total } : tc.prompt != null && tc.completion != null ? { total: tc.prompt + tc.completion } : {}),
            }
          : undefined;
        setAll(
          getLLMAttributes({
            provider: o.provider,
            system: o.system,
            modelName: o.modelName,
            invocationParameters: o.invocationParameters ? (redact(o.invocationParameters) as Record<string, unknown>) : undefined,
            inputMessages: o.inputMessages?.map((m) => ({ role: m.role, content: m.content != null ? redactString(m.content) : undefined })),
            outputMessages: o.outputMessages?.map((m) => ({ role: m.role, content: m.content != null ? redactString(m.content) : undefined })),
            tokenCount,
          }),
        );
        if (o.costUsd != null) span.setAttribute(SemanticConventions.LLM_COST_TOTAL, o.costUsd);
      },
      retriever(documents) {
        setAll(
          getRetrieverAttributes({
            documents: documents.map((d) => ({
              id: d.id,
              content: redactString(d.content),
              score: d.score,
              metadata: d.metadata ? (redact(d.metadata) as Record<string, unknown>) : undefined,
            })),
          }),
        );
      },
      tool(t) {
        setAll(getToolAttributes({ name: t.name, description: t.description, parameters: (redact(t.parameters ?? {}) as Record<string, unknown>) ?? {} }));
      },
      metadata(meta) {
        // merge with session metadata from context so we don't clobber it
        const ctxMeta = getMetadata(context.active()) ?? {};
        setAll(getMetadataAttributes(redact({ ...ctxMeta, ...meta }) as Record<string, unknown>));
      },
    };
  }

  const tracer: PhoenixTracer = {
    provider,
    projectName,
    baseUrl,

    async span(name, attrs, fn) {
      const kind = (typeof attrs?.["openinference.span.kind"] === "string" ? attrs["openinference.span.kind"] : spanKindFor(name)) as OpenInferenceSpanKind;
      return oi.startActiveSpan(name, { attributes: { ...cleanAttrs(attrs ?? {}), [SemanticConventions.OPENINFERENCE_SPAN_KIND]: kind } }, async (span: Span) => {
        const helpers = helpersFor(span);
        if (kind === OpenInferenceSpanKind.TOOL) span.setAttribute(SemanticConventions.TOOL_NAME, name);
        try {
          const result = await fn(helpers.set, helpers);
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          span.recordException({ name: e.name, message: redactString(e.message) });
          span.setStatus({ code: SpanStatusCode.ERROR, message: redactString(e.message) });
          throw err;
        } finally {
          span.end();
        }
      });
    },

    async withSession(session, fn) {
      let ctx = trace.getActiveSpan() ? context.active() : ROOT_CONTEXT;
      ctx = setSession(ctx, { sessionId: session.sessionId });
      if (session.userId) ctx = setUser(ctx, { userId: session.userId });
      if (session.metadata) ctx = setMetadata(ctx, redact(session.metadata) as Record<string, unknown>);
      if (session.tags?.length) ctx = setTags(ctx, session.tags);
      return context.with(ctx, fn);
    },

    currentTraceId() {
      const sc = trace.getActiveSpan()?.spanContext();
      return sc && sc.traceId && !/^0+$/.test(sc.traceId) ? sc.traceId : null;
    },
    currentSpanId() {
      const sc = trace.getActiveSpan()?.spanContext();
      return sc && sc.spanId && !/^0+$/.test(sc.spanId) ? sc.spanId : null;
    },
    traceUrl(traceId) {
      return baseUrl && traceId ? `${baseUrl}/redirects/traces/${traceId}` : null;
    },
    sessionUrl(sessionId) {
      return baseUrl && sessionId ? `${baseUrl}/redirects/sessions/${encodeURIComponent(sessionId)}` : null;
    },

    evaluate(name, result) {
      try {
        const span = trace.getActiveSpan();
        if (!span) return;
        const explanation = result.explanation ? redactString(result.explanation) : undefined;
        const evaluation = { name, label: result.label, score: result.score, explanation, annotatorKind: "CODE" };
        span.setAttributes(getEvaluationAttributes({ evaluations: [evaluation] }));
        span.setAttribute(`eval.${name}.label`, result.label);
        if (result.score != null) span.setAttribute(`eval.${name}.score`, result.score);
        if (explanation) span.setAttribute(`eval.${name}.explanation`, explanation);
        if (annotate && baseUrl) {
          pending.push({ spanId: span.spanContext().spanId, a: { name, label: result.label, score: result.score, explanation } });
          if (!drainTimer) {
            drainTimer = setTimeout(() => void drain().catch(() => {}), 5000);
            drainTimer.unref?.();
          }
        }
      } catch {
        /* evaluations must never break the flow */
      }
    },

    async flush() {
      try {
        await provider.forceFlush();
      } catch {
        /* ignore */
      }
      if (drainTimer) {
        clearTimeout(drainTimer);
        drainTimer = null;
      }
      await drain().catch(() => {});
    },

    async shutdown() {
      await tracer.flush();
      await provider.shutdown().catch(() => {});
    },
  };
  return tracer;
}

/** Tests: drop the global provider + context manager + propagator. */
export function __resetTracingForTests() {
  try {
    detachGlobalTracerProvider();
  } catch {
    /* ignore */
  }
  activeProvider = null;
  trace.disable();
  context.disable();
  propagation.disable();
}

export function __activeProviderForTests() {
  return activeProvider;
}
