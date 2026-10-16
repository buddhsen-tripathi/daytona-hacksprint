"use client";

import { AnimatePresence, motion } from "motion/react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { evidenceSrc } from "@/lib/format";
import type { Evidence } from "@/lib/types";

export function EvidenceGallery({ items }: { items: Evidence[] }) {
  const shots = items.filter((e) => e.type === "screenshot" || e.mime.startsWith("image/"));
  const [open, setOpen] = useState<number | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const lastTrigger = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    setOpen(null);
    lastTrigger.current?.focus();
  }, []);
  const step = useCallback((d: number) => setOpen((i) => (i == null ? i : (i + d + shots.length) % shots.length)), [shots.length]);

  useEffect(() => {
    if (open == null) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "ArrowRight") step(1);
      if (e.key === "ArrowLeft") step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close, step]);

  if (shots.length === 0) return <div className="font-mono text-[11px] text-muted">no screenshots captured</div>;
  const cur = open == null ? null : shots[open];

  return (
    <>
      <ul className="grid grid-cols-3 gap-2">
        {shots.map((e, i) => (
          <li key={e.id}>
            <button
              type="button"
              onClick={(ev) => {
                lastTrigger.current = ev.currentTarget;
                setOpen(i);
              }}
              className="group block w-full border border-rule bg-paper2 text-left transition-colors hover:border-ink"
              aria-label={`Open screenshot ${i + 1}: ${e.step ?? ""} — ${e.summary}`}
            >
              <div className="relative aspect-[64/45] overflow-hidden">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={evidenceSrc(e.storageReference)} alt={`${e.step ?? "evidence"}: ${e.summary}`} className="size-full object-cover object-top transition-transform group-hover:scale-[1.03]" loading="lazy" />
                <span className="absolute top-1 left-1 bg-ink px-1 font-mono text-[9.5px] font-bold text-paper">
                  {String(i + 1).padStart(2, "0")} {e.step}
                </span>
              </div>
              <div className="truncate px-1.5 py-1 font-mono text-[9.5px] text-ink2">{e.summary}</div>
            </button>
          </li>
        ))}
      </ul>

      {typeof document !== "undefined" &&
        createPortal(
      <AnimatePresence>
        {cur && (
          <motion.div
            key="lb"
            role="dialog"
            aria-modal="true"
            aria-label={`Evidence ${open! + 1} of ${shots.length}`}
            className="fixed inset-0 z-50 flex items-center justify-center bg-ink/85 p-8"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={close}
          >
            <motion.figure
              key={cur.id}
              initial={{ scale: 0.97, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.18 }}
              className="relative max-h-full max-w-5xl border-2 border-paper bg-card"
              onClick={(e) => e.stopPropagation()}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={evidenceSrc(cur.storageReference)} alt={`${cur.step ?? "evidence"}: ${cur.summary}`} className="max-h-[78vh] w-auto" />
              <figcaption className="flex items-center gap-3 border-t border-rule px-3 py-2 font-mono text-[11.5px]">
                <span className="bg-ink px-1.5 font-bold text-paper">
                  {String(open! + 1).padStart(2, "0")}/{String(shots.length).padStart(2, "0")}
                </span>
                <span className="font-semibold uppercase">{cur.step}</span>
                <span className="text-ink2">{cur.summary}</span>
                <span className="ml-auto text-muted">{cur.id}</span>
              </figcaption>
              <button ref={closeRef} type="button" onClick={close} className="absolute -top-4 -right-4 grid size-9 place-items-center rounded-full bg-signal text-white" aria-label="Close">
                <X className="size-4" />
              </button>
              {shots.length > 1 && (
                <>
                  <button type="button" onClick={() => step(-1)} className="absolute top-1/2 -left-14 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-paper text-ink" aria-label="Previous screenshot">
                    <ChevronLeft className="size-5" />
                  </button>
                  <button type="button" onClick={() => step(1)} className="absolute top-1/2 -right-14 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-paper text-ink" aria-label="Next screenshot">
                    <ChevronRight className="size-5" />
                  </button>
                </>
              )}
            </motion.figure>
          </motion.div>
        )}
      </AnimatePresence>,
          document.body,
        )}
    </>
  );
}
