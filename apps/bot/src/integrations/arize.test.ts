import { afterEach, describe, expect, it } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { __resetTracingForTests, createTracer, redact, redactString, spanKindFor, type TracerOptions } from "./arize.js";

type Processor = NonNullable<TracerOptions["spanProcessors"]>[number];
type Ended = Parameters<Processor["onEnd"]>[0];

function capture() {
  const spans: Ended[] = [];
  const processor: Processor = {
    onStart() {},
    onEnd(span) {
      spans.push(span);
    },
    forceFlush: async () => {},
    shutdown: async () => {},
  };
  return { spans, processor, byName: (n: string) => spans.find((s) => s.name === n)! };
}

afterEach(() => __resetTracingForTests());

describe("arize tracer", () => {
  it("propagates the session id + metadata to every span in the chat", async () => {
    const cap = capture();
    const t = createTracer({ spanProcessors: [cap.processor], endpoint: "http://localhost:6006", projectName: "test" });
    let traceId: string | null = null;
    await t.withSession({ sessionId: "tg-123", userId: "res_123", metadata: { complaintId: "cmp_1" }, tags: ["demo"] }, () =>
      t.span("telegram.message", { "telegram.kind": "text" }, async () => {
        traceId = t.currentTraceId();
        await t.span("draft.generate", {}, async () => "ok");
      }),
    );
    expect(cap.spans).toHaveLength(2);
    for (const s of cap.spans) {
      expect(s.attributes["session.id"]).toBe("tg-123");
      expect(s.attributes["user.id"]).toBe("res_123");
      expect(String(s.attributes["metadata"])).toContain("cmp_1");
    }
    const root = cap.byName("telegram.message");
    const child = cap.byName("draft.generate");
    expect(root.attributes["openinference.span.kind"]).toBe("CHAIN");
    expect(child.spanContext().traceId).toBe(root.spanContext().traceId);
    expect(traceId).toBe(root.spanContext().traceId);
    expect(t.traceUrl(traceId!)).toBe(`http://localhost:6006/redirects/traces/${traceId}`);
    expect(t.sessionUrl("tg-123")).toContain("tg-123");
  });

  it("records LLM attributes on routing.classify", async () => {
    const cap = capture();
    const t = createTracer({ spanProcessors: [cap.processor], endpoint: null });
    await t.span("routing.classify", {}, async (_set, oi) => {
      oi.llm({
        provider: "openrouter",
        modelName: "anthropic/claude-sonnet-4.5",
        inputMessages: [{ role: "user", content: "pothole on 5th ave, call me 212-555-1234" }],
        outputMessages: [{ role: "assistant", content: '{"triage":"SUPPORTED"}' }],
        tokenCount: { prompt: 100, completion: 20, total: null },
        costUsd: 0.001,
      });
      oi.input({ text: "pothole" });
      oi.output({ category: "street-pothole" });
    });
    const s = cap.byName("routing.classify");
    expect(s.attributes["openinference.span.kind"]).toBe("LLM");
    expect(s.attributes["llm.model_name"]).toBe("anthropic/claude-sonnet-4.5");
    expect(s.attributes["llm.provider"]).toBe("openrouter");
    expect(s.attributes["llm.token_count.prompt"]).toBe(100);
    expect(s.attributes["llm.token_count.total"]).toBe(120);
    expect(s.attributes["llm.input_messages.0.message.role"]).toBe("user");
    expect(String(s.attributes["llm.input_messages.0.message.content"])).toContain("[phone]");
    expect(String(s.attributes["llm.input_messages.0.message.content"])).not.toContain("555-1234");
    expect(s.attributes["input.mime_type"]).toBe("application/json");
    expect(t.traceUrl("abc")).toBeNull();
  });

  it("records retriever documents for duplicate search", async () => {
    const cap = capture();
    const t = createTracer({ spanProcessors: [cap.processor], endpoint: null });
    await t.span("nyc311.search_duplicates", { radius: 50 }, async (_set, oi) => {
      oi.retriever([
        { id: "61234567", content: "Street Condition / Pothole at 102 E 14th St", score: 0.82, metadata: { distanceMeters: 14 } },
        { id: "61234568", content: "Street Condition / Pothole at 110 E 14th St", score: 0.6 },
      ]);
    });
    const s = cap.byName("nyc311.search_duplicates");
    expect(s.attributes["openinference.span.kind"]).toBe("RETRIEVER");
    expect(s.attributes["retrieval.documents.0.document.id"]).toBe("61234567");
    expect(s.attributes["retrieval.documents.0.document.score"]).toBe(0.82);
    expect(s.attributes["retrieval.documents.1.document.content"]).toContain("110 E 14th");
    expect(s.attributes["radius"]).toBe(50);
  });

  it("records tool attributes and error status", async () => {
    const cap = capture();
    const t = createTracer({ spanProcessors: [cap.processor], endpoint: null });
    await expect(
      t.span("daytona.create_worker", { token: "should-not-appear" }, async (_set, oi) => {
        oi.tool({ name: "daytona.create_worker", description: "provision sandbox", parameters: { snapshot: "relay", apiKey: "dtn_supersecretvalue123456" } });
        throw new Error("sandbox failed for Bearer abc.def.ghi");
      }),
    ).rejects.toThrow("sandbox failed");
    const s = cap.byName("daytona.create_worker");
    expect(s.attributes["openinference.span.kind"]).toBe("TOOL");
    expect(s.attributes["tool.name"]).toBe("daytona.create_worker");
    expect(String(s.attributes["tool.parameters"])).not.toContain("supersecret");
    expect(s.attributes["token"]).toBeUndefined();
    expect(s.status.code).toBe(SpanStatusCode.ERROR);
    expect(s.status.message).toContain("Bearer [REDACTED]");
    expect(s.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("attaches evaluations to the active span", async () => {
    const cap = capture();
    const t = createTracer({ spanProcessors: [cap.processor], endpoint: null });
    await t.span("receipt.verify", {}, async () => {
      t.evaluate("outcome_accuracy", { label: "correct", score: 1, explanation: "SR parsed from confirmation" });
    });
    const s = cap.byName("receipt.verify");
    expect(s.attributes["eval.outcome_accuracy.label"]).toBe("correct");
    expect(s.attributes["eval.outcome_accuracy.score"]).toBe(1);
    expect(Object.keys(s.attributes).some((k) => k.startsWith("evaluation") || k.startsWith("annotation"))).toBe(true);
    // no active span ⇒ silently ignored
    expect(() => t.evaluate("x", { label: "y" })).not.toThrow();
  });

  it("maps span names to kinds", () => {
    expect(spanKindFor("intake.extract")).toBe("LLM");
    expect(spanKindFor("location.validate")).toBe("TOOL");
    expect(spanKindFor("browser.submit")).toBe("TOOL");
    expect(spanKindFor("anchor.create_session")).toBe("TOOL");
    expect(spanKindFor("telegram.respond")).toBe("TOOL");
    expect(spanKindFor("user.approve")).toBe("CHAIN");
    expect(spanKindFor("surrealdb.persist")).toBe("CHAIN");
    expect(spanKindFor("something.else")).toBe("CHAIN");
  });

  it("redacts secrets, contacts and paths", () => {
    const r = redact({
      telegramFileId: "AgACAgQ",
      localPath: "/Users/x/.runs/media/a.jpg",
      contactEmail: "a@b.com",
      note: "email me at jane@example.com or see /Users/jane/secret.txt token=abc123",
      nested: { cdpUrl: "wss://connect.anchorbrowser.io?apiKey=sk_live", ok: 1 },
    }) as Record<string, unknown>;
    expect(r.telegramFileId).toBe("[REDACTED]");
    expect(r.localPath).toBe("[REDACTED]");
    expect(r.contactEmail).toBe("[REDACTED]");
    expect(r.note).not.toContain("jane@example.com");
    expect(r.note).not.toContain("/Users/jane");
    expect(r.note).not.toContain("abc123");
    expect((r.nested as Record<string, unknown>).cdpUrl).toBe("[REDACTED]");
    expect(redactString("x".repeat(5000)).length).toBeLessThan(4100);
    expect(redactString("DEMO-20261016-ABC123 at 40.7359, -73.9911")).toBe("DEMO-20261016-ABC123 at 40.7359, -73.9911");
  });
});
