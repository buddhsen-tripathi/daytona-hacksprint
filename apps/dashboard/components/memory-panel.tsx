"use client";

import { Card, Empty, Label, Mono, Section } from "./ui";

/** What the agent recalled for a complaint (#5/#12). Mock-only until the bot exposes it. */
type Recall = { id: string; text: string; similarity: number; recency: number; importance: number };
type MemoryInfo = {
  recalls: Recall[];
  duplicate: { complaintId: string; score: number; reason: string } | null;
  askedBecauseLearned: { field: string; question: string }[];
};

const MOCK_MEMORY: MemoryInfo = {
  recalls: [
    { id: "mem_31", text: "Rider reported the M15 skipping stops at 1st Ave & 57th last week.", similarity: 0.86, recency: 0.72, importance: 0.6 },
    { id: "mem_18", text: "This chat prefers short questions; usually rides southbound in the morning.", similarity: 0.54, recency: 0.4, importance: 0.8 },
  ],
  duplicate: { complaintId: "mock-handoff", score: 0.91, reason: "same route, stop and hour within 48 h" },
  askedBecauseLearned: [{ field: "direction", question: "Which direction was the bus heading?" }],
};

const pct = (n: number) => `${Math.round(n * 100)}`;

function Bar({ label, v }: { label: string; v: number }) {
  return (
    <div className="flex items-center gap-1.5 font-mono text-[10px]">
      <span className="w-7 text-muted">{label}</span>
      <span className="h-1.5 flex-1 bg-paper2">
        <span className="block h-full bg-ink" style={{ width: `${pct(v)}%` }} />
      </span>
      <span className="w-6 text-right tabular">{pct(v)}</span>
    </div>
  );
}

export function MemoryPanel({ mock }: { mock: boolean }) {
  const m = mock ? MOCK_MEMORY : null;
  return (
    <Section no="D" title="Memory" aside={<Mono className="text-[10.5px]">recall · duplicates · learned fields</Mono>}>
      {!m ? (
        <Empty title="No memory trace" hint="Recall details are not exposed by the bot API yet. Add ?mock=1 to preview." />
      ) : (
        <div className="space-y-3">
          {m.recalls.map((r) => (
            <Card key={r.id} className="p-3">
              <div className="flex items-center gap-2">
                <Mono className="font-bold">{r.id}</Mono>
              </div>
              <p className="mt-1 text-[12.5px]">{r.text}</p>
              <div className="mt-2 space-y-1">
                <Bar label="sim" v={r.similarity} />
                <Bar label="rec" v={r.recency} />
                <Bar label="imp" v={r.importance} />
              </div>
            </Card>
          ))}
          <Card className="p-3">
            <Label>Duplicate match</Label>
            {m.duplicate ? (
              <p className="mt-1 text-[12.5px]">
                <Mono className="font-bold">{m.duplicate.complaintId}</Mono> · {pct(m.duplicate.score)}% · {m.duplicate.reason}
              </p>
            ) : (
              <p className="mt-1 text-[12.5px] text-muted">none</p>
            )}
          </Card>
          <Card className="p-3">
            <Label>Asked because of learned fields</Label>
            {m.askedBecauseLearned.length === 0 ? (
              <p className="mt-1 text-[12.5px] text-muted">none</p>
            ) : (
              <ul className="mt-1 space-y-1 text-[12.5px]">
                {m.askedBecauseLearned.map((a) => (
                  <li key={a.field}>
                    <Mono className="font-bold">{a.field}</Mono> — {a.question}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </Section>
  );
}
