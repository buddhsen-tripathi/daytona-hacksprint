"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { asList, usePoll, withMock } from "@/lib/api";
import { automationLabel, catalogHaystack, triState, type CatalogEntry } from "@/lib/catalog";
import { ApiDownBanner, Card, Empty, ExtLink, LiveTick, Mono, Section, SkeletonRows } from "./ui";

export function AutomationTag({ a }: { a: string }) {
  const l = automationLabel(a);
  return <span className={`inline-block whitespace-nowrap rounded-[3px] border px-1.5 py-px font-mono text-[10.5px] font-semibold uppercase ${l.tone}`}>{l.text}</span>;
}

function Flag({ v, bad }: { v: boolean | null; bad: string }) {
  const s = triState(v);
  return <span className={`font-mono text-[11px] ${v ? "font-bold text-caution" : v === false ? "text-ink2" : "text-muted"}`} title={v ? bad : undefined}>{s}</span>;
}

export function CatalogView({ mock }: { mock: boolean }) {
  // The bot filters with ?q=, but the table also filters client-side so typing stays instant.
  const q = usePoll<unknown>("/api/catalog", { mock, intervalMs: 30000 });
  const [query, setQuery] = useState("");
  const all = asList<CatalogEntry>(q.data, "entries");
  const source = q.data && typeof q.data === "object" && "source" in q.data ? String((q.data as { source: unknown }).source) : null;
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? all.filter((e) => catalogHaystack(e).includes(needle)) : all;
  }, [all, query]);
  const down = !mock && q.error && !q.data;

  return (
    <div>
      {down && <ApiDownBanner error={q.error ?? "unreachable"} onMockHref="/catalog?mock=1" />}
      <div className="rise mb-6">
        <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-signal-deep">NYC311 knowledge articles → where each one files</div>
        <h1 className="font-wide mt-1 text-[40px] leading-[0.95] font-black tracking-tight">Catalog</h1>
        <p className="mt-2 max-w-xl text-[13px] text-ink2">
          Every category the bot knows: who handles it, how it is filed, and whether a robot may file it. &ldquo;?&rdquo; means not verified yet.
        </p>
      </div>

      <Section
        no="01"
        title="Categories"
        aside={
          <>
            <Mono className="text-[10.5px]">
              {rows.length}/{all.length}
              {source ? ` · ${source}` : ""}
            </Mono>
            <LiveTick updatedAt={q.updatedAt} error={q.error} />
          </>
        }
      >
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search title, agency, topic, KA number…"
          aria-label="Search catalog"
          className="mb-3 w-full border border-rule2 bg-card px-3 py-2 font-mono text-[12.5px] outline-none focus:border-ink"
        />
        {q.loading && !q.data ? (
          <SkeletonRows rows={5} />
        ) : rows.length === 0 ? (
          <Empty title={all.length ? "No matches" : "Catalog is empty"} hint={all.length ? "Try an agency (DOT, HPD) or a KA number." : "Run the catalog crawler (#7) to populate it."} />
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-ink font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
                  <th className="px-3 py-2 font-semibold">Title</th>
                  <th className="px-3 py-2 font-semibold">Agency</th>
                  <th className="px-3 py-2 font-semibold">Channel</th>
                  <th className="px-3 py-2 font-semibold">Automation</th>
                  <th className="px-3 py-2 font-semibold">CAPTCHA</th>
                  <th className="px-3 py-2 font-semibold">Login</th>
                  <th className="px-3 py-2 font-semibold">Fields known</th>
                  <th className="px-3 py-2 text-right font-semibold">Official</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id} className="border-b border-rule last:border-b-0 hover:bg-paper2">
                    <td className="px-3 py-2.5">
                      <Link href={withMock(`/catalog/${encodeURIComponent(e.id)}`, mock)} className="text-[13px] font-semibold hover:underline">
                        {e.title}
                      </Link>
                      <span className="block font-mono text-[10.5px] text-muted">{e.kaNumber}</span>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[12px]">{e.agency ?? <span className="text-muted">—</span>}</td>
                    <td className="px-3 py-2.5 font-mono text-[11px] whitespace-nowrap text-ink2">{e.channel}</td>
                    <td className="px-3 py-2.5">
                      <AutomationTag a={e.automation} />
                    </td>
                    <td className="px-3 py-2.5">
                      <Flag v={e.hasCaptcha} bad="CAPTCHA: a human must finish" />
                    </td>
                    <td className="px-3 py-2.5">
                      <Flag v={e.requiresLogin} bad="login required: a human must finish" />
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[11px]">
                      {e.requiredFields ? <span className="font-semibold text-go">{e.requiredFields.length} fields</span> : <span className="text-muted">not learned</span>}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <ExtLink href={e.officialUrl}>open</ExtLink>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </Section>
    </div>
  );
}
