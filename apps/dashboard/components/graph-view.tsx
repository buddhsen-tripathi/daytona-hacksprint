"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { usePoll, withMock } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import type { GraphEdge, GraphNode, GraphResponse, WorkflowPattern } from "@/lib/types";
import { ApiDownBanner, Card, Empty, LiveTick, Mono, Section, SkeletonRows, StatePill } from "./ui";

const COLUMNS: { title: string; kinds: string[] }[] = [
  { title: "resident", kinds: ["resident"] },
  { title: "complaint", kinds: ["complaint"] },
  { title: "location · category · public SRs", kinds: ["location", "category", "complaint_category", "open_data_request", "media"] },
  { title: "filing · official request", kinds: ["filing_attempt", "official_request"] },
  { title: "workflow memory", kinds: ["workflow_pattern"] },
];

const KIND_COLOR: Record<string, string> = {
  resident: "var(--ink)",
  complaint: "var(--signal)",
  location: "var(--go)",
  category: "var(--transit)",
  complaint_category: "var(--transit)",
  open_data_request: "var(--caution)",
  media: "var(--rule-2)",
  filing_attempt: "var(--ink-2)",
  official_request: "var(--go)",
  workflow_pattern: "var(--signal-deep)",
};

const W = 1400;
const NODE_W = 196;
const NODE_H = 40;
const ROW = 54;
const TOP = 34;

function colOf(kind: string) {
  const i = COLUMNS.findIndex((c) => c.kinds.includes(kind));
  return i < 0 ? 2 : i;
}

function trunc(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

type Placed = GraphNode & { x: number; y: number; col: number };

function layout(nodes: GraphNode[], edges: GraphEdge[]) {
  const cols: GraphNode[][] = COLUMNS.map(() => []);
  for (const n of nodes) cols[colOf(n.kind)].push(n);
  const adj = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, new Set());
    if (!adj.has(e.to)) adj.set(e.to, new Set());
    adj.get(e.from)!.add(e.to);
    adj.get(e.to)!.add(e.from);
  }
  // barycentre ordering: complaints fixed, others sorted by mean neighbour row
  const rank = new Map<string, number>();
  cols[1].forEach((n, i) => rank.set(n.id, i));
  const order = (list: GraphNode[]) => {
    const score = (n: GraphNode) => {
      const r = [...(adj.get(n.id) ?? [])].map((x) => rank.get(x)).filter((v): v is number => v != null);
      return r.length ? r.reduce((a, b) => a + b, 0) / r.length : 999;
    };
    list.sort((a, b) => score(a) - score(b) || a.kind.localeCompare(b.kind));
    list.forEach((n, i) => rank.set(n.id, cols[1].length ? (i * cols[1].length) / Math.max(1, list.length) : i));
  };
  order(cols[0]);
  order(cols[2]);
  order(cols[3]);
  order(cols[4]);
  const maxRows = Math.max(1, ...cols.map((c) => c.length));
  const H = TOP + maxRows * ROW + 10;
  const gap = (W - NODE_W * COLUMNS.length) / (COLUMNS.length - 1);
  const placed = new Map<string, Placed>();
  cols.forEach((list, ci) => {
    const offset = TOP + ((maxRows - list.length) * ROW) / 2;
    list.forEach((n, ri) => placed.set(n.id, { ...n, col: ci, x: ci * (NODE_W + gap), y: offset + ri * ROW }));
  });
  return { placed, adj, H, gap };
}

function edgePath(a: Placed, b: Placed) {
  const ay = a.y + NODE_H / 2;
  const by = b.y + NODE_H / 2;
  if (a.col === b.col) {
    const x = a.x + NODE_W;
    return { d: `M${x},${ay} C${x + 60},${ay} ${x + 60},${by} ${x},${by}`, mx: x + 45, my: (ay + by) / 2 };
  }
  const [l, r, ly, ry] = a.x < b.x ? [a, b, ay, by] : [b, a, by, ay];
  const x1 = l.x + NODE_W;
  const x2 = r.x;
  const dx = (x2 - x1) / 2;
  return { d: `M${x1},${ly} C${x1 + dx},${ly} ${x2 - dx},${ry} ${x2},${ry}`, mx: (x1 + x2) / 2, my: (ly + ry) / 2 };
}

function Graph({ data, mock }: { data: GraphResponse; mock: boolean }) {
  const [hover, setHover] = useState<string | null>(null);
  const { placed, adj, H } = useMemo(() => layout(data.nodes, data.edges), [data]);
  const lit = hover ? new Set([hover, ...(adj.get(hover) ?? [])]) : null;
  const edges = data.edges.filter((e) => placed.has(e.from) && placed.has(e.to));

  // Edge labels: on hover show every incident edge; otherwise only adjacent-column edges, greedily de-overlapped.
  const labels: { e: GraphEdge; mx: number; my: number; w: number; key: string }[] = [];
  edges.forEach((e, i) => {
    const a = placed.get(e.from)!;
    const b = placed.get(e.to)!;
    if (lit ? !(e.from === hover || e.to === hover) : Math.abs(a.col - b.col) !== 1) return;
    const { mx, my } = edgePath(a, b);
    const w = e.rel.length * 5.6 + 8;
    if (!lit && labels.some((l) => Math.abs(l.my - my) < 15 && Math.abs(l.mx - mx) < (l.w + w) / 2)) return;
    labels.push({ e, mx, my, w, key: `l${i}` });
  });

  return (
    <Card className="overflow-x-auto p-4">
      <svg viewBox={`-4 0 ${W + 8} ${H}`} className="w-full min-w-[1100px]" role="img" aria-label="Complaint graph">
        {COLUMNS.map((c, i) => {
          const gap = (W - NODE_W * COLUMNS.length) / (COLUMNS.length - 1);
          const x = i * (NODE_W + gap);
          return (
            <g key={c.title}>
              <text x={x} y={12} className="fill-[var(--muted)] font-mono text-[10px] font-semibold uppercase" style={{ letterSpacing: "0.14em" }}>
                {String(i + 1).padStart(2, "0")} · {c.title}
              </text>
              <line x1={x} x2={x + NODE_W} y1={20} y2={20} stroke="var(--ink)" strokeWidth={2} />
            </g>
          );
        })}
        <g fill="none">
          {edges.map((e, i) => {
            const a = placed.get(e.from)!;
            const b = placed.get(e.to)!;
            const { d } = edgePath(a, b);
            const on = lit ? lit.has(e.from) && lit.has(e.to) && (e.from === hover || e.to === hover) : true;
            return (
              <path
                key={i}
                d={d}
                stroke={on && lit ? "var(--signal)" : "var(--ink)"}
                strokeOpacity={lit ? (on ? 0.95 : 0.08) : 0.35}
                strokeWidth={on && lit ? 2 : 1.2}
                strokeDasharray={e.rel.includes("duplicate") || e.rel === "applied_in" ? "4 3" : undefined}
              />
            );
          })}
        </g>
        <g>
          {labels.map(({ e, mx, my, w, key }) => (
            <g key={key} transform={`translate(${mx - w / 2},${my - 7})`}>
              <rect width={w} height={13} rx={2} fill={lit ? "var(--ink)" : "var(--paper)"} stroke={lit ? "none" : "var(--rule)"} />
              <text x={w / 2} y={9.5} textAnchor="middle" className="font-mono text-[9px]" fill={lit ? "var(--paper)" : "var(--ink-2)"}>
                {e.rel}
              </text>
            </g>
          ))}
        </g>
        <g>
          {[...placed.values()].map((n) => {
            const dim = lit && !lit.has(n.id);
            const color = KIND_COLOR[n.kind] ?? "var(--rule-2)";
            const isComplaint = n.kind === "complaint";
            const body = (
              <g
                transform={`translate(${n.x},${n.y})`}
                opacity={dim ? 0.25 : 1}
                onMouseEnter={() => setHover(n.id)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(n.id)}
                onBlur={() => setHover(null)}
                tabIndex={isComplaint ? undefined : 0}
                className="cursor-default outline-none"
                style={{ transition: "opacity 120ms" }}
              >
                <title>{`${n.kind}: ${n.label} (${n.id})`}</title>
                <rect width={NODE_W} height={NODE_H} fill="var(--card)" stroke={hover === n.id ? "var(--signal)" : "var(--ink)"} strokeWidth={hover === n.id ? 2 : 1} strokeDasharray={n.kind === "workflow_pattern" ? "3 2" : undefined} />
                <rect width={5} height={NODE_H} fill={color} />
                <text x={13} y={14} className="font-mono text-[8.5px] font-semibold uppercase" fill="var(--muted)" style={{ letterSpacing: "0.1em" }}>
                  {trunc(`${n.kind.replace(/_/g, " ")} · ${n.id}`, 28)}
                </text>
                <text x={13} y={30} className="font-sans text-[11.5px] font-semibold" fill="var(--ink)">
                  {trunc(n.label, 29)}
                </text>
              </g>
            );
            return isComplaint ? (
              <a key={n.id} href={withMock(`/complaints/${encodeURIComponent(n.id)}`, mock)} aria-label={`complaint ${n.id}`}>
                {body}
              </a>
            ) : (
              <g key={n.id}>{body}</g>
            );
          })}
        </g>
      </svg>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-rule pt-2 font-mono text-[10px] text-ink2">
        {Object.entries({ resident: 1, complaint: 1, location: 1, category: 1, open_data_request: 1, filing_attempt: 1, official_request: 1, workflow_pattern: 1 }).map(([k]) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className="h-3 w-1.5" style={{ background: KIND_COLOR[k] }} aria-hidden />
            {k.replace(/_/g, " ")}
          </span>
        ))}
        <span className="ml-auto text-muted">hover or focus a node to trace its neighbours · dashed = possible duplicate / memory reuse</span>
      </div>
    </Card>
  );
}

function Patterns({ patterns }: { patterns: WorkflowPattern[] }) {
  if (patterns.length === 0) return <Empty title="No workflow memory yet" hint="Patterns are recorded after each filing attempt — e.g. a CAPTCHA seen on a form, or the selector that held the SR number." />;
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-ink/80 bg-paper2/60 font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
            <th scope="col" className="px-3 py-2 font-semibold">Kind</th>
            <th scope="col" className="px-3 py-2 font-semibold">Scope</th>
            <th scope="col" className="px-3 py-2 font-semibold">What we learned</th>
            <th scope="col" className="px-3 py-2 font-semibold">Hint</th>
            <th scope="col" className="px-3 py-2 font-semibold">Observed in</th>
            <th scope="col" className="px-3 py-2 font-semibold">Outcome</th>
          </tr>
        </thead>
        <tbody>
          {patterns.map((p) => (
            <tr key={p.id} className="border-b border-rule align-top last:border-b-0">
              <td className="px-3 py-2.5">
                <Mono className="font-bold">{p.kind}</Mono>
                <div className="font-mono text-[10px] text-muted">{fmtDateTime(p.createdAt)}</div>
              </td>
              <td className="px-3 py-2.5 font-mono text-[11px] text-ink2">
                {p.target} · {p.category}
              </td>
              <td className="max-w-md px-3 py-2.5 text-[12.5px] leading-snug">{p.description}</td>
              <td className="px-3 py-2.5">
                <code className="block max-w-[220px] truncate bg-paper2 px-1.5 py-0.5 font-mono text-[10.5px]" title={JSON.stringify(p.hint)}>
                  {JSON.stringify(p.hint)}
                </code>
              </td>
              <td className="px-3 py-2.5 font-mono text-[11px]">{p.observedInAttemptId ?? "—"}</td>
              <td className="px-3 py-2.5">{p.outcome ? <StatePill state={p.outcome} /> : <span className="text-muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-rule px-3 py-2 text-[11.5px] text-ink2">Workflow memory guides the worker but never overrides the host allowlist, current form requirements, or the CAPTCHA/login hand-off.</p>
    </Card>
  );
}

export function GraphView({ mock }: { mock: boolean }) {
  const q = usePoll<GraphResponse>("/api/graph", { mock });
  const data = q.data;
  const patterns: WorkflowPattern[] =
    data?.patterns ??
    data?.workflowPatterns ??
    (data?.nodes ?? [])
      .filter((n) => n.kind === "workflow_pattern")
      .map((n) => ({ id: n.id, kind: n.label, description: "—", target: "demo", category: "street-pothole", hint: {}, observedInAttemptId: null, outcome: null, createdAt: "" }));

  return (
    <div>
      {q.error && !mock && <ApiDownBanner error={q.error} onMockHref="/graph?mock=1" />}
      <div className="rise mb-6 flex items-end gap-6">
        <div>
          <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-signal-deep">SurrealDB · RELATE edges</div>
          <h1 className="font-wide mt-1 text-[40px] leading-[0.95] font-black tracking-tight">Complaint graph</h1>
          <p className="mt-2 max-w-xl text-[13px] text-ink2">
            Residents, complaints, places, categories, public NYC311 requests, filing attempts and what the filing worker remembers — one connected record.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-4">
          {data && (
            <Mono className="text-[11px] text-ink2">
              {data.nodes.length} nodes · {data.edges.length} edges
            </Mono>
          )}
          <LiveTick updatedAt={q.updatedAt} error={q.error} />
          <Link href={withMock("/", mock)} className="font-mono text-[11px] underline underline-offset-2">
            console
          </Link>
        </div>
      </div>
      <div className="space-y-10">
        <Section no="01" title="Graph">
          {!data ? q.error ? <Empty title="Graph unavailable" hint="The bot API is offline." /> : <SkeletonRows rows={6} /> : data.nodes.length === 0 ? <Empty title="Empty graph" hint="No complaints recorded yet." /> : <Graph data={data} mock={mock} />}
        </Section>
        <Section no="02" title="Workflow memory" aside={<Mono className="text-[10.5px]">§11.3</Mono>}>
          {!data && !q.error ? <SkeletonRows rows={3} /> : <Patterns patterns={patterns} />}
        </Section>
      </div>
    </div>
  );
}
