import type { ReactNode } from "react";
import { ArrowUpRight, PlugZap } from "lucide-react";
import { TONE_CLASSES, TONE_DOT, humanState, stateTone } from "@/lib/format";

export function StatePill({ state, size = "sm" }: { state: string | null | undefined; size?: "sm" | "md" | "lg" }) {
  const s = state ?? "RUNNING";
  const tone = state ? stateTone(state) : "live";
  const pad = size === "lg" ? "px-3 py-1.5 text-[13px]" : size === "md" ? "px-2.5 py-1 text-[11.5px]" : "px-2 py-[3px] text-[10.5px]";
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-[3px] border font-mono font-semibold uppercase tracking-wide ${pad} ${TONE_CLASSES[tone]}`}>
      <span className={`size-1.5 shrink-0 rounded-full ${TONE_DOT[tone]} ${tone === "live" ? "pulse-dot" : ""}`} aria-hidden />
      {humanState(s)}
    </span>
  );
}

/** A docket section: numbered tab + title + rule. */
export function Section({
  no,
  title,
  aside,
  children,
  className = "",
}: {
  no: string;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rise ${className}`} aria-label={title}>
      <header className="mb-3 flex items-end gap-3 border-b-2 border-ink pb-1.5">
        <span className="bg-ink px-1.5 py-0.5 font-mono text-[10.5px] font-bold text-paper">{no}</span>
        <h2 className="font-wide text-[13px] font-extrabold uppercase tracking-[0.08em]">{title}</h2>
        <div className="ml-auto flex items-center gap-2 text-[11px] text-muted">{aside}</div>
      </header>
      {children}
    </section>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`border border-rule bg-card shadow-[2px_2px_0_0_rgb(23_20_15/0.06)] ${className}`}>{children}</div>;
}

export function Label({ children }: { children: ReactNode }) {
  return <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">{children}</div>;
}

export function Mono({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono text-[12px] ${className}`}>{children}</span>;
}

export function ExtLink({ href, children, disabled }: { href: string | null | undefined; children: ReactNode; disabled?: boolean }) {
  if (!href || disabled)
    return (
      <span className="inline-flex items-center gap-1 rounded-[3px] border border-dashed border-rule2 px-2 py-1 font-mono text-[11px] text-muted" title="not available">
        {children}
      </span>
    );
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 rounded-[3px] border border-ink/70 bg-card px-2 py-1 font-mono text-[11px] font-medium text-ink transition-colors hover:border-signal hover:bg-signal hover:text-white"
    >
      {children}
      <ArrowUpRight className="size-3" aria-hidden />
    </a>
  );
}

export function ApiDownBanner({ error, onMockHref }: { error: string; onMockHref?: string }) {
  return (
    <div role="status" className="rise mb-5 flex items-stretch overflow-hidden border border-caution/60 bg-caution-wash">
      <div className="hazard w-3 shrink-0" aria-hidden />
      <div className="flex flex-1 flex-wrap items-center gap-3 px-4 py-2.5">
        <PlugZap className="size-4 text-caution" aria-hidden />
        <div className="text-[13px]">
          <strong className="font-semibold">Bot API not reachable.</strong>{" "}
          <span className="text-ink2">Start it with </span>
          <code className="font-mono text-[12px]">pnpm --filter @311relay/bot dev</code>
          <span className="text-ink2"> — retrying every 2 s.</span>
          <span className="ml-2 font-mono text-[11px] text-muted">{error}</span>
        </div>
        {onMockHref && (
          <a href={onMockHref} className="ml-auto font-mono text-[11px] font-semibold text-signal-deep underline underline-offset-2">
            view mock data →
          </a>
        )}
      </div>
    </div>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 border border-dashed border-rule2 px-6 py-10 text-center">
      <div className="font-wide text-[13px] font-bold uppercase tracking-wider text-ink2">{title}</div>
      {hint && <div className="max-w-sm text-[12.5px] text-muted">{hint}</div>}
    </div>
  );
}

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-9 animate-pulse bg-paper2" style={{ animationDelay: `${i * 90}ms` }} />
      ))}
    </div>
  );
}

export function LiveTick({ updatedAt, error }: { updatedAt: number | null; error: string | null }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-wider">
      <span className={`size-1.5 rounded-full ${error ? "bg-stop" : "bg-go pulse-dot"}`} aria-hidden />
      {error ? "offline" : updatedAt ? "live · 2s" : "connecting"}
    </span>
  );
}
