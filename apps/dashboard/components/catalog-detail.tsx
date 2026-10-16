"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { asList, usePoll, withMock } from "@/lib/api";
import { asEntry, triState } from "@/lib/catalog";
import { fmtAgo } from "@/lib/format";
import type { ComplaintDraft } from "@/lib/types";
import { AutomationTag } from "./catalog-view";
import { ApiDownBanner, Card, Empty, ExtLink, Label, Mono, Section, SkeletonRows, StatePill } from "./ui";

export function CatalogDetail({ id, mock }: { id: string; mock: boolean }) {
  const q = usePoll<unknown>(`/api/catalog/${encodeURIComponent(id)}`, { mock, intervalMs: 30000 });
  const cq = usePoll<unknown>("/api/complaints", { mock, intervalMs: 10000 });
  const e = asEntry(q.data);
  const back = withMock("/catalog", mock);
  const recent = asList<ComplaintDraft>(cq.data, "complaints")
    .filter((c) => c.category === id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 8);

  if (!e) {
    return (
      <div>
        <Link href={back} className="mb-4 inline-flex items-center gap-1 font-mono text-[11px] text-ink2 hover:text-ink">
          <ArrowLeft className="size-3.5" aria-hidden /> catalog
        </Link>
        {q.error ? (
          q.error.includes("404") ? (
            <Empty title={`Category ${id} not found`} hint="It is not in the catalog snapshot the bot loaded." />
          ) : (
            <ApiDownBanner error={q.error} onMockHref="/catalog/mta-bus-complaint?mock=1" />
          )
        ) : (
          <SkeletonRows rows={5} />
        )}
      </div>
    );
  }

  const facts: [string, React.ReactNode][] = [
    ["Agency", e.agency ?? "—"],
    ["Topic", e.topic ?? "—"],
    ["Channel", e.channel],
    ["Automation", <AutomationTag key="a" a={e.automation} />],
    ["CAPTCHA", triState(e.hasCaptcha)],
    ["Login", triState(e.requiresLogin)],
    ["Last verified", fmtAgo(e.lastVerifiedAt)],
  ];

  return (
    <div>
      <Link href={back} className="mb-3 inline-flex items-center gap-1 font-mono text-[11px] text-ink2 hover:text-ink">
        <ArrowLeft className="size-3.5" aria-hidden /> catalog
      </Link>
      <div className="rise mb-6 flex flex-wrap items-end gap-x-6 gap-y-3 border-b-2 border-ink pb-4">
        <div>
          <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-signal-deep">
            Category · {e.kaNumber}
          </div>
          <h1 className="font-wide mt-1 text-[38px] leading-none font-black tracking-tight">{e.title}</h1>
          <p className="mt-2 max-w-2xl text-[13.5px] text-ink2">{e.summary}</p>
        </div>
        <div className="ml-auto flex gap-1.5">
          <ExtLink href={e.articleUrl}>311 article</ExtLink>
          <ExtLink href={e.officialUrl}>official form</ExtLink>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-6">
        <div className="col-span-12 space-y-6 lg:col-span-4">
          <Section no="A" title="Filing route">
            <Card className="p-3">
              <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
                {facts.map(([k, v]) => (
                  <div key={k}>
                    <dt>
                      <Label>{k}</Label>
                    </dt>
                    <dd className="font-mono text-[12px] font-semibold">{v}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          </Section>
        </div>
        <div className="col-span-12 space-y-6 lg:col-span-4">
          <Section no="B" title="Learned schema" aside={<Mono className="text-[10.5px]">#11</Mono>}>
            {e.requiredFields ? (
              <Card className="p-3">
                <Label>Required fields</Label>
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {e.requiredFields.map((f) => (
                    <li key={f} className="rounded-[3px] border border-rule2 px-1.5 py-px font-mono text-[11px]">
                      {f}
                    </li>
                  ))}
                </ul>
              </Card>
            ) : (
              <Empty title="Not learned yet" hint="Required fields are learned from filing runs against the official form." />
            )}
          </Section>
          <Section no="C" title="Recipe" aside={<Mono className="text-[10.5px]">#9</Mono>}>
            <Empty title="Not learned yet" hint="A replayable form recipe appears here after a successful run." />
          </Section>
        </div>
        <div className="col-span-12 lg:col-span-4">
          <Section no="D" title="Recent complaints" aside={<Mono className="text-[10.5px]">{recent.length}</Mono>}>
            {recent.length === 0 ? (
              <Empty title="None yet" hint="Complaints classified into this category show up here." />
            ) : (
              <ul className="space-y-2">
                {recent.map((c) => (
                  <li key={c.id}>
                    <Card className="flex items-center gap-2 p-2.5">
                      <Link href={withMock(`/complaints/${encodeURIComponent(c.id)}`, mock)} className="font-mono text-[12px] font-bold hover:underline">
                        {c.id}
                      </Link>
                      <span className="font-mono text-[10.5px] text-muted">{fmtAgo(c.createdAt)}</span>
                      <span className="ml-auto">
                        <StatePill state={c.status} />
                      </span>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}
