import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const BOT = (process.env.BOT_API_URL ?? "http://localhost:3312").replace(/\/$/, "");
/** #23: the bot API requires `Authorization: Bearer <OPERATOR_API_TOKEN>` when the token is set. Server-side only. */
const TOKEN = process.env.OPERATOR_API_TOKEN ?? "";

const PASS_HEADERS = ["content-type", "content-length", "cache-control", "content-disposition"];

/**
 * Headers safe to copy from the bot's response. `fetch` transparently decompresses gzip/br bodies (Render's edge
 * compresses JSON) but leaves the upstream `content-length` header in place, so forwarding it would announce the
 * compressed size for a decompressed body and the browser would cut the JSON short ("Unterminated string in JSON").
 */
function passHeaders(res: Response): Headers {
  const headers = new Headers();
  const encoded = !!res.headers.get("content-encoding");
  for (const h of PASS_HEADERS) {
    if (h === "content-length" && encoded) continue;
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  return headers;
}

async function forward(target: string, init: RequestInit): Promise<Response> {
  try {
    const res = await fetch(target, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
      headers: { ...(init.headers as Record<string, string> | undefined), ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    });
    return new Response(res.body, { status: res.status, headers: passHeaders(res) });
  } catch (err) {
    return Response.json(
      { error: "BOT_API_UNREACHABLE", message: `Could not reach ${BOT}: ${(err as Error).message}` },
      { status: 502 },
    );
  }
}

/** Thin GET proxy to the bot JSON API so the browser never deals with CORS. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  return forward(`${BOT}/${path.map(encodeURIComponent).join("/")}${req.nextUrl.search}`, { method: "GET" });
}

/** POST passthrough (#13): only the operator actions `api/repairs/:id/approve|reject`; the bot checks the token. */
const POST_ALLOWED = /^api\/repairs\/[^/]+\/(approve|reject)$/;

export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const rel = path.join("/");
  if (!POST_ALLOWED.test(rel)) return Response.json({ error: "not found" }, { status: 404 });
  const body = await req.text();
  return forward(`${BOT}/${path.map(encodeURIComponent).join("/")}`, {
    method: "POST",
    body: body || "{}",
    headers: { "content-type": "application/json" },
  });
}
