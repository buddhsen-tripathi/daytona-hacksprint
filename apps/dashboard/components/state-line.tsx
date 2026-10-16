import { TONE_SWATCH, humanState, stateTone } from "@/lib/format";
import type { ComplaintState } from "@/lib/types";

/** §8.3 state machine drawn as a transit line: trunk stops + branch spurs. */
const TRUNK: { s: ComplaintState; branches?: ComplaintState[] }[] = [
  { s: "RECEIVED" },
  { s: "TRIAGING", branches: ["OUT_OF_SCOPE", "EMERGENCY_REFERRAL"] },
  { s: "NEEDS_INFORMATION" },
  { s: "DUPLICATE_REVIEW" },
  { s: "READY_FOR_APPROVAL" },
  { s: "APPROVED" },
  { s: "FILING", branches: ["HUMAN_ACTION_REQUIRED", "SUBMISSION_UNKNOWN", "FAILED"] },
  { s: "SUBMITTED" },
  { s: "TRACKING" },
];

function Count({ n }: { n: number }) {
  return (
    <span className={`ml-auto min-w-6 text-right font-mono text-[11.5px] tabular ${n ? "font-bold text-ink" : "text-rule2"}`}>{n}</span>
  );
}

export function StateLine({ counts, highlight }: { counts: Partial<Record<string, number>>; highlight?: string }) {
  return (
    <div className="relative">
      <ol className="relative">
        {TRUNK.map(({ s, branches }, i) => {
          const tone = stateTone(s);
          const n = counts[s] ?? 0;
          const last = i === TRUNK.length - 1;
          return (
            <li key={s} className="relative">
              <div className={`relative flex items-center gap-3 py-[5px] pl-7 ${highlight === s ? "bg-signal-wash" : ""}`}>
                {!last && <span className="absolute top-1/2 left-[9px] h-full w-[3px] bg-ink" aria-hidden />}
                {i > 0 && <span className="absolute top-0 left-[9px] h-1/2 w-[3px] bg-ink" aria-hidden />}
                <span
                  className={`absolute left-[3px] grid size-[15px] place-items-center rounded-full border-[3px] border-ink ${n ? TONE_SWATCH[tone] : "bg-card"}`}
                  aria-hidden
                />
                <span className={`font-mono text-[11px] tracking-wide ${n ? "font-semibold text-ink" : "text-muted"}`}>{humanState(s)}</span>
                <Count n={n} />
              </div>
              {branches?.map((b) => {
                const bn = counts[b] ?? 0;
                const bt = stateTone(b);
                return (
                  <div key={b} className={`relative flex items-center gap-3 py-[3px] pl-14 ${highlight === b ? "bg-signal-wash" : ""}`}>
                    <span className="absolute top-1/2 left-[9px] h-full w-[3px] bg-ink" aria-hidden />
                    <span className="absolute top-0 left-[9px] h-1/2 w-[3px] bg-ink" aria-hidden />
                    <span className="absolute top-1/2 left-[12px] h-[2px] w-[26px] -translate-y-1/2 bg-ink/50" aria-hidden />
                    <span className={`absolute left-[36px] size-[10px] rounded-[2px] border-2 border-ink/70 ${bn ? TONE_SWATCH[bt] : "bg-card"}`} aria-hidden />
                    <span className={`font-mono text-[10.5px] ${bn ? "font-semibold text-ink" : "text-muted"}`}>{humanState(b)}</span>
                    <Count n={bn} />
                  </div>
                );
              })}
            </li>
          );
        })}
      </ol>
      <div className="mt-1 flex items-center gap-3 border-t border-dashed border-rule2 pt-1.5 pl-7">
        <span className="font-mono text-[10.5px] text-muted">CANCELLED</span>
        <Count n={counts.CANCELLED ?? 0} />
      </div>
    </div>
  );
}
