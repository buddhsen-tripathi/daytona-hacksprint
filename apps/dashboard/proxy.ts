import { type NextRequest, NextResponse } from "next/server";

/**
 * Optional HTTP Basic auth for a public deployment. With DASHBOARD_PASSWORD set, every page and the
 * /api/bot proxy (which carries the operator token) need it; any username is accepted. Unset ⇒ open (local dev).
 */
export function proxy(req: NextRequest) {
  const password = process.env.DASHBOARD_PASSWORD ?? "";
  if (!password) return NextResponse.next();
  const m = /^Basic\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
  if (m) {
    const decoded = atob(m[1]);
    const given = decoded.slice(decoded.indexOf(":") + 1);
    if (safeEqual(given, password)) return NextResponse.next();
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="311Relay console", charset="UTF-8"' },
  });
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
