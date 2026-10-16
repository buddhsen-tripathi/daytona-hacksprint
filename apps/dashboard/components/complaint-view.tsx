"use client";

import Link from "next/link";
import { ArrowLeft, Check, ShieldAlert, ShieldCheck, ShieldQuestion, X } from "lucide-react";
import type { ReactNode } from "react";
import { usePoll, withMock } from "@/lib/api";
import { categoryLabel, categoryOfficial } from "@/lib/categories";
import { SAFETY_COPY, fmtDateTime, fmtMs, fmtTime, humanState, pct, evidenceSrc } from "@/lib/format";
import type { Actor, ComplaintDetail, ComplaintDraft, DuplicateCandidate, Evidence, FilingAttempt, Transition, WorkerEvent } from "@/lib/types";
import { ApiDownBanner, Card, Empty, ExtLink, Label, LiveTick, Mono, Section, SkeletonRows, StatePill } from "./ui";
import { MapPinView } from "./map-pin";
import { EvidenceGallery } from "./lightbox";

const ACTOR_STYLE: Record<Actor, string> = {
  user: "bg-signal text-white",
  system: "bg-ink text-paper",
  llm: "bg-transit text-white",
};

function ActorBadge({ actor }: { actor: Actor }) {
  return <span className={`inline-block rounded-[2px] px-1.5 py-px font-mono text-[9.5px] font-bold uppercase tracking-wider ${ACTOR_STYLE[actor]}`}>{actor}</span>;
}

function Bar({ value, tone = "bg-ink" }: { value: number; tone?: string }) {
  return (
    <div className="h-1.5 w-full bg-paper2" aria-hidden>
      <div className={`h-full ${tone}`} style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}

/* ---------------------------------------------------------------- left */

function Conversation({ c }: { c: ComplaintDraft }) {
  const cl = c.classification;
  return (
    <div className="space-y-4">
      <Card className="p-3">
        <Label>Resident · chat {c.telegramChatId}</Label>
        <ol className="mt-2 space-y-1.5">
          {c.userMessages.length === 0 && <li className="text-[12px] text-muted">no messages recorded</li>}
          {c.userMessages.map((m, i) => {
            const meta = m.match(/^\[(.+?)\]\s*(.*)$/);
            return (
              <li key={i} className="flex items-start gap-2">
                <span className="mt-0.5 font-mono text-[9.5px] text-muted tabular">{String(i + 1).padStart(2, "0")}</span>
                <div className="rounded-[10px] rounded-tl-[2px] bg-paper2 px-2.5 py-1.5 text-[12.5px] leading-snug">
                  {meta && <span className="mr-1.5 font-mono text-[10px] font-semibold uppercase text-signal-deep">{meta[1]}</span>}
                  {meta ? meta[2] : m}
                </div>
              </li>
            );
          })}
        </ol>
        {c.media.length > 0 && <div className="mt-2 font-mono text-[10.5px] text-muted">{c.media.length} media item(s): {c.media.map((m) => m.type).join(", ")}</div>}
      </Card>

      <Card className="p-3">
        <div className="flex items-center justify-between">
          <Label>Classification</Label>
          {c.triage && <Mono className="text-[10.5px] font-bold">{c.triage}</Mono>}
        </div>
        {cl ? (
          <div className="mt-2 space-y-2.5">
            <div>
              <div className="font-wide text-[15px] font-extrabold">{cl.category ? categoryOfficial(cl.category) : humanState(cl.triage)}</div>
              <div className="mt-1 flex items-center gap-2">
                <Bar value={cl.confidence} tone={cl.confidence >= 0.6 ? "bg-go" : "bg-caution"} />
                <Mono className="text-[11px] font-bold tabular">{pct(cl.confidence)}</Mono>
              </div>
              <div className="mt-0.5 font-mono text-[9.5px] text-muted">confidence · routing signal only · &lt; 60% ⇒ clarify</div>
            </div>
            <p className="text-[12.5px] leading-snug">
              <span className="font-semibold">Rationale. </span>
              {cl.rationale}
            </p>
            {cl.alternativeConsidered && (
              <p className="border-l-2 border-rule2 pl-2 text-[12px] leading-snug text-ink2">
                <span className="font-semibold text-ink">Alternative considered. </span>
                {cl.alternativeConsidered}
              </p>
            )}
            {cl.safetyFlags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {cl.safetyFlags.map((f) => (
                  <span key={f} className="bg-stop-wash px-1.5 font-mono text-[10px] text-stop">
                    {f}
                  </span>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="mt-2 text-[12px] text-muted">not classified yet</div>
        )}
      </Card>

      <Card className="p-3">
        <div className="mb-2 flex items-center justify-between">
          <Label>Location</Label>
          <Mono className="text-[10px] text-muted">
            source: {c.location.source}
            {c.location.userConfirmed ? " · user-confirmed" : ""}
          </Mono>
        </div>
        <MapPinView lat={c.location.latitude} lon={c.location.longitude} label={c.location.address ?? "location"} />
        <div className="mt-2 text-[13px] font-semibold">{c.location.address ?? <span className="font-normal text-muted italic">awaiting location from resident</span>}</div>
        <div className="font-mono text-[10.5px] text-muted">
          {c.location.borough ?? "—"} · within NYC: {c.location.withinNyc == null ? "?" : c.location.withinNyc ? "yes" : "no"} · never inferred from photo
        </div>
      </Card>
    </div>
  );
}

function Duplicates({ list, asOf, reviewed }: { list: DuplicateCandidate[]; asOf?: string | null; reviewed: boolean }) {
  return (
    <Card className="p-3">
      <div className="flex items-center justify-between">
        <Label>Possible duplicates · NYC Open Data erm2-nwe9</Label>
        {reviewed && <Mono className="shrink-0 text-[10px] whitespace-nowrap text-go">reviewed ✓</Mono>}
      </div>
      <div className="mt-0.5 font-mono text-[10px] text-muted">public data as of {asOf ? fmtDateTime(asOf) : "unknown"} · 50 m / 90 days · score ≥ 0.55</div>
      {list.length === 0 ? (
        <div className="mt-3 text-[12px] text-muted">No nearby open or recent requests matched.</div>
      ) : (
        <ul className="mt-3 space-y-3">
          {list.map((d) => (
            <li key={d.uniqueKey} className="border-t border-rule pt-2.5 first:border-t-0 first:pt-0">
              <div className="flex items-start gap-3">
                <div className="grid size-12 shrink-0 place-items-center border-2 border-ink font-wide text-[15px] font-black tabular">{Math.round(d.matchScore * 100)}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Mono className="font-bold">SR {d.uniqueKey}</Mono>
                    <span className={`px-1 font-mono text-[9.5px] font-bold uppercase ${d.status === "Closed" ? "bg-neutral-wash text-ink2" : "bg-caution-wash text-caution"}`}>{d.status ?? "?"}</span>
                  </div>
                  <div className="truncate text-[12px]">
                    {d.descriptor ?? d.complaintType} · {d.incidentAddress ?? "—"}
                  </div>
                  <div className="font-mono text-[10px] text-muted">
                    {d.distanceMeters != null ? `${Math.round(d.distanceMeters)} m` : "? m"} · {d.ageDays} d old{d.closedDate ? ` · closed ${fmtDateTime(d.closedDate)}` : ""}
                  </div>
                </div>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2">
                {(["location", "category", "recency"] as const).map((k) => (
                  <div key={k}>
                    <div className="flex justify-between font-mono text-[9.5px] text-muted">
                      <span>{k}</span>
                      <span className="tabular">{d.scoreBreakdown[k].toFixed(2)}</span>
                    </div>
                    <Bar value={d.scoreBreakdown[k]} tone="bg-signal" />
                  </div>
                ))}
              </div>
              {d.resolutionDescription && <p className="mt-1.5 text-[11px] leading-snug text-ink2 italic">“{d.resolutionDescription}”</p>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ---------------------------------------------------------------- middle */

const HAPPY: string[] = ["RECEIVED", "TRIAGING", "NEEDS_INFORMATION", "DUPLICATE_REVIEW", "READY_FOR_APPROVAL", "APPROVED", "FILING", "SUBMITTED", "TRACKING"];

function deriveTransitions(c: ComplaintDraft): (Transition & { derived: true })[] {
  // Fallback when the API has no audit log: walk the happy path up to the current state.
  const path: string[] = [];
  const idx = HAPPY.indexOf(c.status);
  if (idx >= 0) path.push(...HAPPY.slice(0, idx + 1));
  else if (["HUMAN_ACTION_REQUIRED", "SUBMISSION_UNKNOWN", "FAILED"].includes(c.status)) path.push(...HAPPY.slice(0, 7), c.status);
  else path.push("RECEIVED", "TRIAGING", c.status);
  return path.slice(1).map((to, i) => ({
    complaintId: c.id,
    from: path[i] as Transition["from"],
    to: to as Transition["to"],
    reason: "derived from current status",
    actor: to === "APPROVED" || (to === "READY_FOR_APPROVAL" && path[i] === "DUPLICATE_REVIEW") ? "user" : "system",
    at: to === "APPROVED" && c.approvedAt ? c.approvedAt : "",
    derived: true,
  }));
}

function Timeline({ c, transitions }: { c: ComplaintDraft; transitions?: Transition[] }) {
  const real = transitions && transitions.length > 0;
  const stamp = (t: Transition) => t.at || t.ts || "";
  const list = real ? [...transitions].map((t) => ({ ...t, at: stamp(t) })).sort((a, b) => a.at.localeCompare(b.at)) : deriveTransitions(c);
  return (
    <Card className="p-3">
      <div className="mb-2 flex items-center justify-between">
        <Label>State transitions</Label>
        <Mono className="text-[10px] text-muted">{real ? `${list.length} recorded` : "derived"}</Mono>
      </div>
      <ol className="relative">
        <li className="relative flex gap-3 pb-2">
          <span className="absolute top-3 left-[5px] h-full w-[2px] bg-ink/80" aria-hidden />
          <span className="relative mt-1 size-3 shrink-0 rounded-full border-2 border-ink bg-card" aria-hidden />
          <div>
            <Mono className="text-[11px] font-semibold">RECEIVED</Mono>
            <div className="font-mono text-[10px] text-muted">{fmtTime(c.createdAt)}</div>
          </div>
        </li>
        {list.map((t, i) => {
          const last = i === list.length - 1;
          return (
            <li key={`${t.to}-${i}`} className="relative flex gap-3 pb-3">
              {!last && <span className="absolute top-3 left-[5px] h-full w-[2px] bg-ink/80" aria-hidden />}
              <span className={`relative mt-1 size-3 shrink-0 rounded-full border-2 border-ink ${last ? "bg-signal" : "bg-ink"}`} aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  {last ? <StatePill state={t.to} /> : <Mono className="text-[11px] font-semibold">{t.to}</Mono>}
                  <ActorBadge actor={t.actor} />
                </div>
                <div className="mt-0.5 text-[11.5px] leading-snug text-ink2">{t.reason}</div>
                <div className="font-mono text-[10px] text-muted tabular">{t.at ? fmtTime(t.at) : "—"}</div>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="mt-1 flex gap-3 border-t border-rule pt-2 font-mono text-[9.5px] text-muted">
        <span className="flex items-center gap-1"><ActorBadge actor="user" /> resident tap</span>
        <span className="flex items-center gap-1"><ActorBadge actor="llm" /> model</span>
        <span className="flex items-center gap-1"><ActorBadge actor="system" /> code</span>
      </div>
    </Card>
  );
}

function Approval({ c }: { c: ComplaintDraft }) {
  const approved = c.approvedVersion != null;
  const match = approved && c.approvedVersion === c.draftVersion;
  return (
    <Card className="p-3">
      <Label>Approval record</Label>
      <div className="mt-2 grid grid-cols-2 gap-px bg-rule">
        <div className="bg-card p-2">
          <div className="font-mono text-[9.5px] text-muted">draftVersion</div>
          <div className="font-wide text-[26px] leading-none font-black tabular">v{c.draftVersion}</div>
        </div>
        <div className="bg-card p-2">
          <div className="font-mono text-[9.5px] text-muted">approvedVersion</div>
          <div className={`font-wide text-[26px] leading-none font-black tabular ${approved ? "" : "text-rule2"}`}>{approved ? `v${c.approvedVersion}` : "—"}</div>
        </div>
      </div>
      <div className={`mt-2 flex items-center gap-1.5 text-[12px] font-semibold ${!approved ? "text-muted" : match ? "text-go" : "text-stop"}`}>
        {approved ? match ? <Check className="size-3.5" aria-hidden /> : <X className="size-3.5" aria-hidden /> : null}
        {!approved ? "Awaiting resident approval" : match ? "Approval binds to the current draft" : "Draft changed after approval — re-approval required"}
      </div>
      <div className="font-mono text-[10px] text-muted">approved at {fmtDateTime(c.approvedAt)} · via Telegram button (user-gated)</div>
    </Card>
  );
}

/* ---------------------------------------------------------------- right */

function Outcome({ a }: { a: FilingAttempt }) {
  const box = (cls: string, icon: ReactNode, head: ReactNode, body: string, extra?: ReactNode) => (
    <div className={`border-2 p-3 ${cls}`}>
      <div className="flex items-center gap-2">
        {icon}
        {head}
      </div>
      {extra}
      <p className="mt-2 text-[12.5px] leading-snug whitespace-pre-line">{body}</p>
    </div>
  );
  switch (a.outcome) {
    case "SUBMITTED":
      return box(
        "border-go bg-go-wash text-ink",
        <ShieldCheck className="size-5 text-go" aria-hidden />,
        <span className="font-mono text-[10.5px] font-bold uppercase tracking-widest text-go">Confirmed · {a.verified ? "receipt verified" : "unverified"}</span>,
        SAFETY_COPY.SUBMITTED(a.officialRequestNumber ?? "—"),
        <div className="mt-2">
          <div className="font-mono text-[9.5px] uppercase tracking-widest text-ink2">Service request</div>
          <div className="font-mono text-[30px] leading-tight font-extrabold tracking-tight text-ink">{a.officialRequestNumber}</div>
        </div>,
      );
    case "HUMAN_ACTION_REQUIRED":
      return box(
        "border-caution bg-caution-wash",
        <ShieldAlert className="size-5 text-caution" aria-hidden />,
        <span className="font-mono text-[10.5px] font-bold uppercase tracking-widest text-caution">Human action required · {a.errorCode ?? "—"}</span>,
        SAFETY_COPY.HUMAN_ACTION_REQUIRED,
      );
    case "SUBMISSION_UNKNOWN":
      return box(
        "border-rule2 hatch-unknown",
        <ShieldQuestion className="size-5 text-ink2" aria-hidden />,
        <span className="font-mono text-[10.5px] font-bold uppercase tracking-widest text-ink2">Submission unknown · {a.errorCode ?? "—"} · no auto-retry</span>,
        SAFETY_COPY.SUBMISSION_UNKNOWN,
      );
    case "FAILED":
      return box(
        "border-stop bg-stop-wash",
        <X className="size-5 text-stop" aria-hidden />,
        <span className="font-mono text-[10.5px] font-bold uppercase tracking-widest text-stop">Failed · {a.errorCode ?? "—"}</span>,
        SAFETY_COPY.FAILED,
      );
    default:
      return (
        <div className="flex items-center gap-2 border-2 border-transit bg-transit-wash p-3">
          <span className="size-2.5 rounded-full bg-transit pulse-dot" aria-hidden />
          <span className="font-mono text-[11px] font-bold uppercase tracking-widest text-transit">Filing in progress — worker running in sandbox</span>
        </div>
      );
  }
}

const LEVEL: Record<WorkerEvent["level"], string> = { info: "text-ink2", warn: "text-caution", error: "text-stop font-semibold" };

function StepLog({ events }: { events: WorkerEvent[] }) {
  if (events.length === 0) return <div className="font-mono text-[11px] text-muted">waiting for worker events…</div>;
  return (
    <div className="max-h-64 overflow-auto border border-ink bg-ink p-2 font-mono text-[10.5px] leading-[1.6] text-paper">
      {events.map((e, i) => (
        <div key={i} className="grid grid-cols-[58px_64px_1fr] gap-2">
          <span className="text-paper/45 tabular">{fmtTime(e.ts)}</span>
          <span className="text-signal uppercase">{e.step}</span>
          <span className={e.level === "info" ? "text-paper/90" : e.level === "warn" ? "text-[#f3c35a]" : "text-[#ff8a80]"}>
            {e.level !== "info" && <span className="mr-1 uppercase">[{e.level}]</span>}
            {e.message}
          </span>
        </div>
      ))}
    </div>
  );
}

function Timing({ t }: { t: FilingAttempt["timing"] }) {
  const parts = [
    { k: "sandbox", v: t.sandboxMs, c: "bg-ink" },
    { k: "browser", v: t.browserMs, c: "bg-signal" },
    { k: "worker", v: t.workerMs, c: "bg-transit" },
  ];
  const total = parts.reduce((s, p) => s + (p.v ?? 0), 0) || 1;
  return (
    <div>
      <div className="flex h-2 w-full overflow-hidden bg-paper2" aria-hidden>
        {parts.map((p) => (p.v ? <div key={p.k} className={p.c} style={{ width: `${(p.v / total) * 100}%` }} /> : null))}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 font-mono text-[10px] text-ink2">
        {parts.map((p) => (
          <span key={p.k} className="flex items-center gap-1">
            <span className={`size-2 ${p.c}`} aria-hidden />
            {p.k} {fmtMs(p.v)}
          </span>
        ))}
        <span className="ml-auto font-bold text-ink">total {fmtMs(t.totalMs)}</span>
      </div>
    </div>
  );
}

function AttemptCard({ a, evidence }: { a: FilingAttempt; evidence: Evidence[] }) {
  const kv = (k: string, v: ReactNode) => (
    <div className="min-w-0">
      <dt className="font-mono text-[9.5px] uppercase tracking-wider text-muted">{k}</dt>
      <dd className="truncate font-mono text-[11.5px] font-semibold">{v ?? "—"}</dd>
    </div>
  );
  return (
    <Card className="space-y-3 p-3">
      <div className="flex items-center gap-2">
        <Mono className="text-[13px] font-bold">{a.id}</Mono>
        <span className="font-mono text-[10px] text-muted">
          {fmtDateTime(a.createdAt)} · target {a.target}
        </span>
        <span className="ml-auto">
          <StatePill state={a.outcome ?? "FILING"} size="md" />
        </span>
      </div>
      <Outcome a={a} />
      <dl className="grid grid-cols-3 gap-x-3 gap-y-2">
        {kv("sandbox", a.sandboxProvider)}
        {kv("sandbox id", a.sandboxId)}
        {kv("approved ver.", `v${a.approvedVersion}`)}
        {kv("browser", a.browserProvider)}
        {kv("session id", a.browserSessionId)}
        {kv("verified", a.verified ? "yes" : "no")}
      </dl>
      <Timing t={a.timing} />
      <div className="flex flex-wrap gap-1.5">
        <ExtLink href={a.outcome == null ? a.liveViewUrl : null}>Anchor live view</ExtLink>
        <ExtLink href={a.recordingUrl ? evidenceSrc(a.recordingUrl) : null}>recording</ExtLink>
        <ExtLink href={a.traceUrl}>Arize / Phoenix trace</ExtLink>
      </div>
      <div>
        <div className="mb-1 flex items-center justify-between">
          <Label>Worker step log</Label>
          <Mono className="text-[10px] text-muted">{a.workerEvents.length} events · stdout EVT stream</Mono>
        </div>
        <StepLog events={a.workerEvents} />
      </div>
      <div>
        <div className="mb-1 flex items-center justify-between">
          <Label>Evidence</Label>
          <Mono className="text-[10px] text-muted">{evidence.length} file(s) · click to enlarge</Mono>
        </div>
        <EvidenceGallery items={evidence} />
      </div>
      {a.verificationNotes && (
        <div className="border-t border-rule pt-2 text-[11.5px] leading-snug text-ink2">
          <span className="font-mono text-[9.5px] font-bold uppercase tracking-wider text-ink">Receipt verifier · </span>
          {a.verificationNotes}
        </div>
      )}
    </Card>
  );
}

/* ---------------------------------------------------------------- page */

export function ComplaintView({ id, mock }: { id: string; mock: boolean }) {
  const q = usePoll<ComplaintDetail>(`/api/complaints/${encodeURIComponent(id)}`, { mock });
  const d = q.data;
  const back = withMock("/", mock);

  if (!d) {
    return (
      <div>
        <Link href={back} className="mb-4 inline-flex items-center gap-1 font-mono text-[11px] text-ink2 hover:text-ink">
          <ArrowLeft className="size-3.5" aria-hidden /> console
        </Link>
        {q.error ? (
          q.error.includes("404") ? (
            <Empty title={`Complaint ${id} not found`} hint="It may belong to a different store backend, or the bot restarted with the in-memory store." />
          ) : (
            <ApiDownBanner error={q.error} onMockHref="/complaints/mock?mock=1" />
          )
        ) : (
          <SkeletonRows rows={6} />
        )}
      </div>
    );
  }

  const c = d.complaint;
  const attempts = [...(d.attempts ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const evFor = (a: FilingAttempt) => {
    const map = new Map<string, Evidence>();
    for (const e of [...(a.evidence ?? []), ...(d.evidence ?? []).filter((e) => e.attemptId === a.id)]) map.set(e.id, e);
    return [...map.values()];
  };

  return (
    <div>
      {q.error && <ApiDownBanner error={q.error} />}
      <Link href={back} className="mb-3 inline-flex items-center gap-1 font-mono text-[11px] text-ink2 hover:text-ink">
        <ArrowLeft className="size-3.5" aria-hidden /> console
      </Link>

      <div className="rise mb-6 flex flex-wrap items-end gap-x-6 gap-y-3 border-b-2 border-ink pb-4">
        <div>
          <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-signal-deep">
            Complaint · {c.category ? categoryLabel(c.category) : (c.triage ?? "untriaged")}
          </div>
          <h1 className="font-wide mt-1 text-[38px] leading-none font-black tracking-tight">{c.id}</h1>
          <p className="mt-2 max-w-2xl text-[13.5px] text-ink2">{c.description || "No description yet."}</p>
        </div>
        <div className="ml-auto flex items-end gap-6">
          {c.officialRequestNumber && (
            <div className="text-right">
              <div className="font-mono text-[9.5px] uppercase tracking-widest text-muted">Official service request</div>
              <div className="font-mono text-[22px] font-extrabold text-go">{c.officialRequestNumber}</div>
            </div>
          )}
          <div className="text-right">
            <div className="mb-1 font-mono text-[9.5px] uppercase tracking-widest text-muted">Current state</div>
            <StatePill state={c.status} size="lg" />
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <div className="flex gap-1.5">
              <ExtLink href={d.traceUrl}>intake trace</ExtLink>
              <ExtLink href={d.sessionUrl}>Phoenix session</ExtLink>
            </div>
            <LiveTick updatedAt={q.updatedAt} error={q.error} />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-6">
        <div className="col-span-12 space-y-4 lg:col-span-4">
          <Section no="A" title="Conversation">
            <Conversation c={c} />
          </Section>
          <Duplicates list={c.duplicates} asOf={d.duplicatesDataAsOf} reviewed={c.duplicateReviewed} />
        </div>
        <div className="col-span-12 space-y-4 lg:col-span-3">
          <Section no="B" title="Timeline">
            <div className="space-y-4">
              <Timeline c={c} transitions={d.transitions} />
              <Approval c={c} />
              {c.statusReason && (
                <Card className="p-3">
                  <Label>Status reason</Label>
                  <Mono className="mt-1 block font-semibold">{c.statusReason}</Mono>
                </Card>
              )}
            </div>
          </Section>
        </div>
        <div className="col-span-12 lg:col-span-5">
          <Section no="C" title="Filing attempts" aside={<Mono className="text-[10.5px]">{attempts.length} attempt(s)</Mono>}>
            {attempts.length === 0 ? (
              <Empty
                title="Not filed"
                hint={c.approvedVersion == null ? "Nothing is filed until the resident approves the draft in Telegram." : "Approved — waiting for the filing worker to start."}
              />
            ) : (
              <div className="space-y-4">
                {attempts.map((a) => (
                  <AttemptCard key={a.id} a={a} evidence={evFor(a)} />
                ))}
              </div>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}

