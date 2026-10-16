import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const BOT = (process.env.BOT_API_URL ?? "http://localhost:3312").replace(/\/$/, "");
/** #23: the bot API requires `Authorization: Bearer <OPERATOR_API_TOKEN>` when the token is set. Server-side only. */
const TOKEN = process.env.OPERATOR_API_TOKEN ?? "";

/** Thin GET proxy to the bot JSON API so the browser never deals with CORS. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const target = `${BOT}/${path.map(encodeURIComponent).join("/")}${req.nextUrl.search}`;
  try {
    const res = await fetch(target, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
      headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : undefined,
    });
    const headers = new Headers();
    for (const h of ["content-type", "content-length", "cache-control", "content-disposition"]) {
      const v = res.headers.get(h);
      if (v) headers.set(h, v);
    }
    return new Response(res.body, { status: res.status, headers });
  } catch (err) {
    return Response.json(
      { error: "BOT_API_UNREACHABLE", message: `Could not reach ${BOT}: ${(err as Error).message}` },
      { status: 502 },
    );
  }
}
