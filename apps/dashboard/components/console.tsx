"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { Activity, Box, Bot, Database, Globe, Radar, Sparkles, Target } from "lucide-react";
import type { ReactNode } from "react";
import { asList, usePoll, withMock } from "@/lib/api";
import { fmtAgo, fmtMs, fmtTime, normalizeHealth, providerState } from "@/lib/format";
import type { ComplaintDraft, FilingAttempt } from "@/lib/types";
import { CATEGORY_LABEL } from "@/lib/categories";
import { ApiDownBanner, Card, Empty, ExtLink, LiveTick, Mono, Section, SkeletonRows, StatePill } from "./ui";
import { StateLine } from "./state-line";

function ProviderCell({ icon, label, value, state }: { icon: ReactNode; label: string; value: string; state: "on" | "off" | "warn" | "unknown" }) {
  const dot = { on: "bg-go", off: "bg-stop", warn: "bg-caution", unknown: "bg-rule2" }[state];
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5 border-r border-rule px-4 py-2.5 last:border-r-0">
      <span className="text-ink2" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0">
        <div className="font-mono text-[9.5px] font-semibold uppercase tracking-[0.14em] text-muted">{label}</div>
        <div className="flex items-center gap-1.5">
          <span className={`size-1.5 shrink-0 rounded-full ${dot}`} aria-hidden />
          <span className="truncate font-mono text-[12.5px] font-semibold" title={value}>
            {value.split(" (")[0]}
          </span>
        </div>
      </div>
    </div>
  );
}

function Stat({ n, label, tone }: { n: number; label: string; tone?: string }) {
  return (
    <div className="flex flex-col">
      <span className={`font-wide text-[34px] leading-none font-black tabular ${tone ?? ""}`}>{String(n).padStart(2, "0")}</span>
      <span className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{label}</span>
    </div>
  );
}

export function Console({ mock }: { mock: boolean }) {
  const router = useRouter();
  const health = usePoll<unknown>("/api/health", { mock });
  const cq = usePoll<unknown>("/api/complaints", { mock });
  const aq = usePoll<unknown>("/api/attempts", { mock });

  const complaints = asList<ComplaintDraft>(cq.data, "complaints").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const attempts = asList<FilingAttempt>(aq.data, "attempts").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const h = health.data ? normalizeHealth(health.data) : null;
  const down = !mock && (health.error || cq.error) && !cq.data;

  const counts: Record<string, number> = {};
  for (const c of complaints) counts[c.status] = (counts[c.status] ?? 0) + 1;
  const submitted = (counts.SUBMITTED ?? 0) + (counts.TRACKING ?? 0);
  const human = (counts.HUMAN_ACTION_REQUIRED ?? 0) + (counts.SUBMISSION_UNKNOWN ?? 0) + (counts.FAILED ?? 0);
  const inflight = (counts.FILING ?? 0) + (counts.APPROVED ?? 0);

  const prov = providerState;

  return (
    <div>
      {down && <ApiDownBanner error={cq.error ?? health.error ?? "unreachable"} onMockHref="/?mock=1" />}

      {/* Masthead */}
      <div className="rise mb-6 grid grid-cols-12 items-end gap-6">
        <div className="col-span-12 lg:col-span-5">
          <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-signal-deep">NYC street conditions · Telegram → NYC311</div>
          <h1 className="font-wide mt-1 text-[40px] leading-[0.95] font-black tracking-tight">Operations console</h1>
          <p className="mt-2 max-w-md text-[13px] text-ink2">
            Every complaint, every filing attempt, every receipt. A prepared complaint is not a filing; a filing is not a confirmed service request.
          </p>
        </div>
        <div className="col-span-12 flex items-end gap-8 lg:col-span-7 lg:justify-end">
          <Stat n={complaints.length} label="complaints" />
          <Stat n={inflight} label="in flight" tone="text-transit" />
          <Stat n={submitted} label="confirmed SRs" tone="text-go" />
          <Stat n={human} label="need a human" tone="text-caution" />
        </div>
      </div>

      {/* Provider board */}
      <Card className="rise mb-8 flex flex-wrap items-stretch">
        <div className="flex items-center gap-2 border-r border-rule bg-ink px-4 text-paper">
          <Radar className="size-4" aria-hidden />
          <span className="font-wide text-[11px] font-extrabold uppercase tracking-[0.12em]">Providers</span>
        </div>
        <ProviderCell icon={<Bot className="size-4" />} label="Telegram" value={h?.telegram == null ? "—" : h.telegram ? "polling" : "off"} state={h?.telegram == null ? "unknown" : h.telegram ? "on" : "off"} />
        <ProviderCell icon={<Database className="size-4" />} label="Store" value={h?.store ?? "—"} state={h?.store && /memory/i.test(h.store) ? "warn" : prov(h?.store)} />
        <ProviderCell icon={<Box className="size-4" />} label="Sandbox" value={h?.sandbox ?? "—"} state={prov(h?.sandbox)} />
        <ProviderCell icon={<Globe className="size-4" />} label="Browser" value={h?.browser ?? "—"} state={prov(h?.browser)} />
        <ProviderCell icon={<Target className="size-4" />} label="Filing target" value={h?.filingTarget ?? "—"} state={h?.filingTarget === "real" ? "warn" : prov(h?.filingTarget)} />
        <ProviderCell icon={<Sparkles className="size-4" />} label="Classifier" value={h?.classifier ?? "—"} state={prov(h?.classifier)} />
        <ProviderCell icon={<Activity className="size-4" />} label="Phoenix" value={h?.phoenix ?? "—"} state={prov(h?.phoenix)} />
        <div className="flex items-center px-4">
          <LiveTick updatedAt={health.updatedAt} error={health.error} />
        </div>
      </Card>

      <div className="grid grid-cols-12 gap-8">
        <div className="col-span-12 xl:col-span-8">
          <Section no="01" title="Complaints" aside={<span className="font-mono">newest first · {complaints.length} total</span>}>
            {cq.loading && !cq.data ? (
              <SkeletonRows rows={5} />
            ) : complaints.length === 0 ? (
              <Empty title="No complaints yet" hint="Send a pothole photo to the Telegram bot, or run the demo script. New complaints appear here within 2 seconds." />
            ) : (
              <Card className="overflow-x-auto">
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="border-b border-ink/80 bg-paper2/60 font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
                      <th scope="col" className="px-3 py-2 font-semibold">Complaint</th>
                      <th scope="col" className="px-3 py-2 font-semibold">State</th>
                      <th scope="col" className="px-3 py-2 font-semibold">Category</th>
                      <th scope="col" className="px-3 py-2 font-semibold">Location</th>
                      <th scope="col" className="px-3 py-2 font-semibold whitespace-nowrap">Created · updated</th>
                      <th scope="col" className="px-3 py-2 text-right font-semibold whitespace-nowrap">SR number</th>
                    </tr>
                  </thead>
                  <tbody>
                    {complaints.map((c, i) => {
                      const href = withMock(`/complaints/${encodeURIComponent(c.id)}`, mock);
                      return (
                        <motion.tr
                          key={c.id}
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: i * 0.03, duration: 0.25 }}
                          onClick={() => router.push(href)}
                          className="group cursor-pointer border-b border-rule last:border-b-0 hover:bg-signal-wash/50"
                        >
                          <td className="px-3 py-2.5">
                            <Link href={href} className="font-mono text-[12px] font-semibold whitespace-nowrap underline-offset-2 group-hover:underline" onClick={(e) => e.stopPropagation()}>
                              {c.id}
                            </Link>
                          </td>
                          <td className="px-3 py-2.5">
                            <StatePill state={c.status} />
                          </td>
                          <td className="w-[110px] px-3 py-2.5 text-[12px] leading-tight">{c.category ? CATEGORY_LABEL[c.category] ?? c.category : <span className="text-muted">{c.triage ?? "—"}</span>}</td>
                          <td className="max-w-[190px] truncate px-3 py-2.5 text-[12.5px]" title={c.location.address ?? undefined}>
                            {c.location.address ?? <span className="text-muted italic">awaiting location</span>}
                          </td>
                          <td className="px-3 py-2.5 font-mono text-[11.5px] whitespace-nowrap text-ink2 tabular">
                            {fmtTime(c.createdAt).slice(0, 5)} <span className="text-muted">· {fmtAgo(c.updatedAt)}</span>
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            {c.officialRequestNumber ? (
                              <span className="font-mono text-[11.5px] font-bold whitespace-nowrap text-go">{c.officialRequestNumber}</span>
                            ) : (
                              <span className="font-mono text-[11px] text-rule2">none</span>
                            )}
                          </td>
                        </motion.tr>
                      );
                    })}
                  </tbody>
                </table>
              </Card>
            )}
          </Section>
          <Section no="03" title="State machine" className="mt-8" aside={<Mono className="text-[10.5px]">§8.3 · live counts</Mono>}>
            <Card className="grid grid-cols-1 gap-6 p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <StateLine counts={counts} />
              <div className="space-y-4 border-t border-rule pt-4 md:border-t-0 md:border-l md:pt-0 md:pl-6">
                <div>
                  <div className="font-wide text-[12px] font-extrabold uppercase tracking-[0.08em]">Reading the board</div>
                  <ul className="mt-2 space-y-2 text-[12px] leading-snug text-ink2">
                    <li className="flex items-start gap-2"><StatePill state="SUBMITTED" /> <span>confirmation page parsed and SR number verified</span></li>
                    <li className="flex items-start gap-2"><StatePill state="FILING" /> <span>isolated Daytona worker driving an Anchor browser</span></li>
                    <li className="flex items-start gap-2"><StatePill state="HUMAN_ACTION_REQUIRED" /> <span>CAPTCHA, login or a new required field: handed back, nothing filed</span></li>
                    <li className="flex items-start gap-2"><StatePill state="SUBMISSION_UNKNOWN" /> <span>submit clicked, no reliable receipt: never retried automatically</span></li>
                    <li className="flex items-start gap-2"><StatePill state="FAILED" /> <span>stopped before submit; safe to re-approve</span></li>
                  </ul>
                </div>
                <p className="border-t border-rule pt-3 text-[12px] leading-snug text-ink2">
                  <strong className="text-ink">READY_FOR_APPROVAL → APPROVED</strong> is user-gated: only the resident&apos;s button tap, bound to a draft version, can move a complaint into filing. No LLM output or timer can.
                </p>
              </div>
            </Card>
          </Section>
        </div>

        <aside className="col-span-12 space-y-8 xl:col-span-4">
          <Section no="02" title="Filing attempts" aside={<LiveTick updatedAt={aq.updatedAt} error={aq.error} />}>
            {aq.loading && !aq.data ? (
              <SkeletonRows rows={3} />
            ) : attempts.length === 0 ? (
              <Empty title="No filing attempts" hint="An attempt starts only after the resident taps “Approve and file”." />
            ) : (
              <ol className="space-y-3">
                {attempts.slice(0, 8).map((a) => (
                  <li key={a.id}>
                    <Card className={`relative p-3 ${a.outcome == null ? "border-transit/50" : ""}`}>
                      <div className="flex items-center gap-2">
                        <Link href={withMock(`/complaints/${encodeURIComponent(a.complaintId)}`, mock)} className="font-mono text-[12px] font-bold hover:underline">
                          {a.id}
                        </Link>
                        <span className="font-mono text-[10.5px] text-muted">→ {a.complaintId}</span>
                        <span className="ml-auto">
                          <StatePill state={a.outcome ?? "FILING"} />
                        </span>
                      </div>
                      <dl className="mt-2 grid grid-cols-3 gap-x-3 gap-y-1 font-mono text-[10.5px]">
                        <div>
                          <dt className="text-muted">sandbox</dt>
                          <dd className="truncate font-semibold" title={a.sandboxId ?? undefined}>
                            {a.sandboxProvider ?? "—"}
                            <span className="block truncate font-normal text-ink2">{a.sandboxId ?? "—"}</span>
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted">browser</dt>
                          <dd className="truncate font-semibold">
                            {a.browserProvider ?? "—"}
                            <span className="block truncate font-normal text-ink2">{a.browserSessionId ?? "—"}</span>
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted">duration</dt>
                          <dd className="font-semibold tabular">
                            {a.outcome == null ? <span className="text-transit">running…</span> : fmtMs(a.timing.totalMs)}
                            <span className="block font-normal text-ink2">{a.errorCode ?? a.officialRequestNumber ?? a.target}</span>
                          </dd>
                        </div>
                      </dl>
                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        <ExtLink href={a.outcome == null ? a.liveViewUrl : null}>live view</ExtLink>
                        <ExtLink href={a.recordingUrl}>recording</ExtLink>
                        <ExtLink href={a.traceUrl}>trace</ExtLink>
                      </div>
                    </Card>
                  </li>
                ))}
              </ol>
            )}
          </Section>

        </aside>
      </div>
    </div>
  );
}
