import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { chatJson, OpenRouterError, toStrictJsonSchema } from "./openrouter.js";

const S = z.object({ a: z.string(), n: z.number().nullable() });
const ok = (content: string, usage = { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 }) =>
  new Response(JSON.stringify({ model: "m", choices: [{ message: { content } }], usage }), { status: 200 });

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "test";
});
afterEach(() => vi.unstubAllGlobals());

describe("toStrictJsonSchema", () => {
  it("drops $schema and sets additionalProperties false + required", () => {
    const js = toStrictJsonSchema(z.object({ x: z.string().default("y"), y: z.string().url().optional() }));
    expect(js.$schema).toBeUndefined();
    expect(js.additionalProperties).toBe(false);
    expect(JSON.stringify(js)).not.toContain('"default"');
    expect(JSON.stringify(js)).not.toContain('"format"');
  });
});

describe("chatJson", () => {
  it("returns parsed data + usage on first try", async () => {
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.response_format.type).toBe("json_schema");
      expect(body.response_format.json_schema.strict).toBe(true);
      expect(body.provider).toEqual({ require_parameters: true });
      expect(body.usage).toEqual({ include: true });
      return ok('{"a":"x","n":1}');
    });
    vi.stubGlobal("fetch", f);
    const r = await chatJson(S, [{ role: "user", content: "hi" }], { model: "m" });
    expect(r.data).toEqual({ a: "x", n: 1 });
    expect(r.usage).toEqual({ promptTokens: 10, completionTokens: 5, costUsd: 0.001 });
    expect(r.attempts).toBe(1);
  });
  it("falls back to plain JSON mode on 400", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"error":{"message":"schema unsupported"}}', { status: 400 }))
      .mockImplementationOnce(async (_u: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        expect(body.response_format).toBeUndefined();
        expect(JSON.stringify(body.messages)).toContain("JSON Schema");
        return ok('```json\n{"a":"y","n":null}\n```');
      });
    vi.stubGlobal("fetch", f);
    const r = await chatJson(S, [{ role: "system", content: "sys" }, { role: "user", content: "hi" }], { model: "m" });
    expect(r).toMatchObject({ data: { a: "y", n: null }, mode: "json_prompt", attempts: 2 });
  });
  it("repairs once on invalid output, then throws schema error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(ok("not json")).mockResolvedValueOnce(ok('{"a":"z","n":2}')));
    expect((await chatJson(S, [{ role: "user", content: "hi" }], { model: "m" })).data).toEqual({ a: "z", n: 2 });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(ok('{"a":1}')).mockResolvedValueOnce(ok('{"a":2}')));
    await expect(chatJson(S, [{ role: "user", content: "hi" }], { model: "m" })).rejects.toMatchObject({ kind: "schema" });
  });
  it("typed errors: missing key, http, timeout", async () => {
    await expect(chatJson(S, [], { model: "m", apiKey: "" , })).rejects.toBeInstanceOf(OpenRouterError);
    delete process.env.OPENROUTER_API_KEY;
    await expect(chatJson(S, [], { model: "m" })).rejects.toMatchObject({ kind: "missing_key" });
    process.env.OPENROUTER_API_KEY = "test";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    await expect(chatJson(S, [], { model: "m" })).rejects.toMatchObject({ kind: "http", status: 500 });
    vi.stubGlobal("fetch", vi.fn(async () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; }));
    await expect(chatJson(S, [], { model: "m" })).rejects.toMatchObject({ kind: "timeout" });
  });
});
