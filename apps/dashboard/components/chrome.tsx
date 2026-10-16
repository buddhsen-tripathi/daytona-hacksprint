"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { usePoll, withMock } from "@/lib/api";
import { normalizeHealth } from "@/lib/format";

export function Nav() {
  const pathname = usePathname();
  const mock = useSearchParams().get("mock") === "1";
  const items = [
    { href: "/", label: "Console", active: pathname === "/" || pathname.startsWith("/complaints") },
    { href: "/graph", label: "Graph", active: pathname.startsWith("/graph") },
  ];
  return (
    <nav aria-label="Primary" className="flex items-center gap-1">
      {items.map((it) => (
        <Link
          key={it.href}
          href={withMock(it.href, mock)}
          aria-current={it.active ? "page" : undefined}
          className={`px-3 py-1.5 font-wide text-[11.5px] font-bold uppercase tracking-[0.1em] transition-colors ${
            it.active ? "bg-ink text-paper" : "text-ink2 hover:bg-paper2 hover:text-ink"
          }`}
        >
          {it.label}
        </Link>
      ))}
      {mock && <span className="ml-2 rounded-[3px] border border-signal px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase text-signal-deep">mock data</span>}
    </nav>
  );
}

export function Footer() {
  const mock = useSearchParams().get("mock") === "1";
  const health = usePoll<unknown>("/api/health", { mock, intervalMs: 10000 });
  const h = health.data ? normalizeHealth(health.data) : null;
  const demo = !h || !h.filingTarget || h.filingTarget === "demo";
  return (
    <footer className="mt-16 border-t-2 border-ink">
      <div className="mx-auto flex max-w-[1480px] flex-wrap items-center gap-x-6 gap-y-2 px-6 py-4 text-[12px] text-ink2">
        <span className="font-wide font-extrabold uppercase tracking-wider text-ink">311Relay</span>
        {demo ? (
          <span className="inline-flex items-center gap-2">
            <span className="hazard inline-block h-3 w-6" aria-hidden />
            Filing target: <strong>controlled demo portal — not the official NYC311 site.</strong>
          </span>
        ) : (
          <span className="inline-flex items-center gap-2 font-semibold text-stop">
            <span className="size-2 rounded-full bg-stop" aria-hidden />
            Filing target: official NYC DOT form (real submissions)
          </span>
        )}
        <span className="ml-auto font-mono text-[11px] text-muted">read-only console · SR numbers are only ever parsed from a confirmation page</span>
      </div>
    </footer>
  );
}
