"use client";

import Link from "next/link";
import { withMock } from "@/lib/api";
import { fmtAgo } from "@/lib/format";
import { Card, Empty, Label, Mono, Section } from "./ui";

/** Post-mortem repair proposal (#13). Placeholder shape until the bot exposes /api/repairs. */
type RepairProposal = {
  id: string;
  categoryId: string;
  attemptId: string;
  complaintId: string;
  failure: string;
  diagnosis: string;
  change: string;
  screenshots: { caption: string }[];
  createdAt: string;
};

const MOCK_REPAIRS: RepairProposal[] = [
  {
    id: "rep_7a1",
    categoryId: "mta-bus-complaint",
    attemptId: "att_ho91",
    complaintId: "mock-needs",
    failure: "NEW_REQUIRED_FIELD",
    diagnosis: "The MTA form now requires a bus direction before the description step.",
    change: "Add `direction` to requiredFields and ask the rider for it before approval.",
    screenshots: [{ caption: "form step 2: direction (required)" }, { caption: "validation error after submit" }],
    createdAt: "2026-10-16T08:10:00Z",
  },
  {
    id: "rep_7a2",
    categoryId: "noise-from-neighbor",
    attemptId: "att_n0i5",
    complaintId: "mock-handoff",
    failure: "CAPTCHA",
    diagnosis: "portal.311.nyc.gov presented a CAPTCHA on the review step.",
    change: "Set hasCaptcha=true and keep automation at handoff.",
    screenshots: [{ caption: "CAPTCHA on review step" }],
    createdAt: "2026-10-16T07:42:00Z",
  },
];

export function RepairsView({ mock }: { mock: boolean }) {
  const repairs = mock ? MOCK_REPAIRS : [];
  return (
    <div>
      <div className="rise mb-6">
        <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-signal-deep">Failed runs → proposed fixes</div>
        <h1 className="font-wide mt-1 text-[40px] leading-[0.95] font-black tracking-tight">Repairs queue</h1>
        <p className="mt-2 max-w-xl text-[13px] text-ink2">
          Post-mortem proposals from failed filing attempts. Nothing changes until a human approves; this view is read-only until the repairs API lands.
        </p>
      </div>
      <Section no="01" title="Pending proposals" aside={<Mono className="text-[10.5px]">{repairs.length} pending</Mono>}>
        {repairs.length === 0 ? (
          <Empty title="No pending repairs" hint={mock ? undefined : "The repairs API (#13) is not available yet. Add ?mock=1 to preview."} />
        ) : (
          <ul className="space-y-4">
            {repairs.map((r) => (
              <li key={r.id}>
                <Card className="p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[12px] font-bold">{r.id}</span>
                    <span className="rounded-[3px] border border-caution/50 px-1.5 py-px font-mono text-[10.5px] font-semibold uppercase text-caution">{r.failure}</span>
                    <Link href={withMock(`/catalog/${encodeURIComponent(r.categoryId)}`, mock)} className="font-mono text-[11px] hover:underline">
                      {r.categoryId}
                    </Link>
                    <Link href={withMock(`/complaints/${encodeURIComponent(r.complaintId)}`, mock)} className="font-mono text-[11px] text-muted hover:underline">
                      {r.attemptId} → {r.complaintId}
                    </Link>
                    <span className="ml-auto font-mono text-[10.5px] text-muted">{fmtAgo(r.createdAt)}</span>
                  </div>
                  <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div>
                      <Label>Diagnosis</Label>
                      <p className="mt-1 text-[13px]">{r.diagnosis}</p>
                      <div className="mt-3">
                        <Label>Proposed change</Label>
                        <p className="mt-1 text-[13px]">{r.change}</p>
                      </div>
                    </div>
                    <div>
                      <Label>Screenshots</Label>
                      <div className="mt-1 grid grid-cols-2 gap-2">
                        {r.screenshots.map((s) => (
                          <figure key={s.caption} className="flex aspect-video items-end border border-dashed border-rule2 bg-paper2 p-1.5">
                            <figcaption className="font-mono text-[10px] text-muted">{s.caption}</figcaption>
                          </figure>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 flex gap-2 border-t border-rule pt-3">
                    <button type="button" disabled title="repairs API not available yet" className="cursor-not-allowed border border-ink/40 px-3 py-1 font-wide text-[11px] font-bold uppercase tracking-[0.1em] text-muted">
                      Approve
                    </button>
                    <button type="button" disabled title="repairs API not available yet" className="cursor-not-allowed border border-rule2 px-3 py-1 font-wide text-[11px] font-bold uppercase tracking-[0.1em] text-muted">
                      Reject
                    </button>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
