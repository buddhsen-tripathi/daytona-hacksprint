"use client";

import Link from "next/link";
import { useState } from "react";
import { asList, usePoll, withMock } from "@/lib/api";
import { fmtAgo } from "@/lib/format";
import type { Evidence, RepairProposal } from "@/lib/types";
import { EvidenceGallery } from "./lightbox";
import { ApiDownBanner, Card, Empty, Label, Mono, Section } from "./ui";

/** GET /api/repairs row (#13): the proposal plus the evidence it cites and the attempt's outcome. */
type RepairRow = RepairProposal & { evidence: Evidence[]; traceId: string | null; outcome: string | null; errorCode: string | null };

const shot = (id: string, attemptId: string, complaintId: string, summary: string): Evidence => ({
  id,
  attemptId,
  complaintId,
  type: "screenshot",
  step: "validate",
  summary,
  storageReference: "",
  mime: "image/png",
  createdAt: "2026-10-16T08:10:00Z",
});

const MOCK_REPAIRS: RepairRow[] = [
  {
    id: "rep_7a1",
    category: "subway-delay",
    attemptId: "att_ho91",
    complaintId: "mock-needs",
    cause: "missing_required_field",
    confidence: 0.82,
    proposedChanges: [{ kind: "requiredField", before: null, after: "Cross Street 2", evidence: ["ev_m1"] }],
    status: "pending",
    createdAt: "2026-10-16T08:10:00Z",
    decidedAt: null,
    evidence: [shot("ev_m1", "att_ho91", "mock-needs", "Validation error: 'Cross Street 2 is required'")],
    traceId: null,
    outcome: "HUMAN_ACTION_REQUIRED",
    errorCode: "UNEXPECTED_REQUIRED_FIELD",
  },
  {
    id: "rep_7a2",
    category: "subway-delay",
    attemptId: "att_n0i5",
    complaintId: "mock-handoff",
    cause: "confirmation_pattern",
    confidence: 0.6,
    proposedChanges: [{ kind: "confirmRegex", before: "Service Request #", after: "SR Number", evidence: ["ev_m2"] }],
    status: "pending",
    createdAt: "2026-10-16T07:42:00Z",
    decidedAt: null,
    evidence: [shot("ev_m2", "att_n0i5", "mock-handoff", "Confirmation page without a recognised SR number")],
    traceId: null,
    outcome: "SUBMISSION_UNKNOWN",
    errorCode: "NO_CONFIRMATION",
  },
];

const KIND_NOTE: Record<RepairProposal["proposedChanges"][number]["kind"], string> = {
  requiredField: "approve ⇒ added to the category's required fields (asked up front next time)",
  recipeStep: "proposal only: recipe steps are not applied automatically",
  confirmRegex: "proposal only: affects submit verification, never applied automatically",
  questionText: "proposal only",
};

function ChangeLine({ c }: { c: RepairProposal["proposedChanges"][number] }) {
  return (
    <li className="text-[13px]">
      <span className="mr-2 font-mono text-[10.5px] font-semibold uppercase text-signal-deep">{c.kind}</span>
      {c.before ? (
        <>
          <span className="line-through text-muted">{c.before}</span> → <strong>{c.after}</strong>
        </>
      ) : (
        <>
          + <strong>{c.after}</strong>
        </>
      )}
      <div className="font-mono text-[10.5px] text-muted">
        {KIND_NOTE[c.kind]} · evidence {c.evidence.join(", ")}
      </div>
    </li>
  );
}

function RepairCard({ r, mock, onDecided }: { r: RepairRow; mock: boolean; onDecided: (r: RepairRow) => void }) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const pending = r.status === "pending";

  async function decide(action: "approve" | "reject") {
    if (mock) {
      onDecided({ ...r, status: action === "approve" ? "approved" : "rejected", decidedAt: new Date().toISOString() });
      return;
    }
    setBusy(action);
    setErr(null);
    try {
      const res = await fetch(`/api/bot/api/repairs/${encodeURIComponent(r.id)}/${action}`, { method: "POST" });
      const j = (await res.json().catch(() => ({}))) as { repair?: RepairRow; error?: string; message?: string };
      if (!res.ok || !j.repair) throw new Error(j.message ?? j.error ?? `HTTP ${res.status}`);
      onDecided(j.repair);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[12px] font-bold">{r.id}</span>
        <span className="rounded-[3px] border border-caution/50 px-1.5 py-px font-mono text-[10.5px] font-semibold uppercase text-caution">{r.cause}</span>
        {r.errorCode && <span className="font-mono text-[10.5px] text-muted">{r.outcome}/{r.errorCode}</span>}
        <Link href={withMock(`/catalog/${encodeURIComponent(r.category)}`, mock)} className="font-mono text-[11px] hover:underline">
          {r.category}
        </Link>
        <Link href={withMock(`/complaints/${encodeURIComponent(r.complaintId)}`, mock)} className="font-mono text-[11px] text-muted hover:underline">
          {r.attemptId} → {r.complaintId}
        </Link>
        <span className="ml-auto font-mono text-[10.5px] text-muted">
          confidence {Math.round(r.confidence * 100)}% · {fmtAgo(r.createdAt)}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <Label>Proposed changes</Label>
          <ul className="mt-1 space-y-2">
            {r.proposedChanges.map((c, i) => (
              <ChangeLine key={i} c={c} />
            ))}
          </ul>
          {r.applied && r.applied.length > 0 && (
            <div className="mt-3 font-mono text-[11px] text-signal-deep">
              applied{r.decidedBy === "auto" ? " automatically" : ""}: {r.applied.join(", ")}
            </div>
          )}
        </div>
        <div>
          <Label>Screenshots</Label>
          <div className="mt-1">
            <EvidenceGallery items={r.evidence} />
          </div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-rule pt-3">
        {pending ? (
          <>
            <button
              type="button"
              disabled={busy != null}
              onClick={() => decide("approve")}
              className="border border-ink px-3 py-1 font-wide text-[11px] font-bold uppercase tracking-[0.1em] hover:bg-ink hover:text-paper disabled:opacity-50"
            >
              {busy === "approve" ? "Approving…" : "Approve"}
            </button>
            <button
              type="button"
              disabled={busy != null}
              onClick={() => decide("reject")}
              className="border border-rule2 px-3 py-1 font-wide text-[11px] font-bold uppercase tracking-[0.1em] text-ink2 hover:border-ink disabled:opacity-50"
            >
              {busy === "reject" ? "Rejecting…" : "Reject"}
            </button>
          </>
        ) : (
          <Mono className="text-[11px]">
            {r.status} {r.decidedBy ? `by ${r.decidedBy}` : ""} {r.decidedAt ? fmtAgo(r.decidedAt) : ""}
          </Mono>
        )}
        {err && <span className="font-mono text-[11px] text-caution">{err}</span>}
      </div>
    </Card>
  );
}

export function RepairsView({ mock }: { mock: boolean }) {
  const poll = usePoll<unknown>(mock ? null : "/api/repairs?limit=200", { mock, intervalMs: 5000 });
  const [local, setLocal] = useState<Record<string, RepairRow>>({});
  const fetched = mock ? MOCK_REPAIRS : asList<RepairRow>(poll.data, "repairs");
  const all = fetched.map((r) => (local[r.id] && local[r.id]!.status !== "pending" ? local[r.id]! : r));
  const pending = all.filter((r) => r.status === "pending");
  const decided = all.filter((r) => r.status !== "pending");
  const onDecided = (r: RepairRow) => setLocal((m) => ({ ...m, [r.id]: r }));

  return (
    <div>
      <div className="rise mb-6">
        <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-signal-deep">Failed runs → proposed fixes</div>
        <h1 className="font-wide mt-1 text-[40px] leading-[0.95] font-black tracking-tight">Repairs queue</h1>
        <p className="mt-2 max-w-xl text-[13px] text-ink2">
          Post-mortem proposals from failed filing attempts. Nothing changes until a human approves, except new required fields diagnosed with ≥ 90% confidence. Approving applies required-field changes only; nothing that affects submit is ever applied automatically.
        </p>
      </div>
      {!mock && poll.error && <ApiDownBanner error={poll.error} onMockHref="/repairs?mock=1" />}
      <Section no="01" title="Pending proposals" aside={<Mono className="text-[10.5px]">{pending.length} pending</Mono>}>
        {pending.length === 0 ? (
          <Empty title="No pending repairs" hint={!mock && poll.loading ? "Loading…" : "Failed or ambiguous filing attempts are diagnosed here automatically."} />
        ) : (
          <ul className="space-y-4">
            {pending.map((r) => (
              <li key={r.id}>
                <RepairCard r={r} mock={mock} onDecided={onDecided} />
              </li>
            ))}
          </ul>
        )}
      </Section>
      {decided.length > 0 && (
        <Section no="02" title="Decided" aside={<Mono className="text-[10.5px]">{decided.length}</Mono>}>
          <ul className="space-y-4">
            {decided.map((r) => (
              <li key={r.id}>
                <RepairCard r={r} mock={mock} onDecided={onDecided} />
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
