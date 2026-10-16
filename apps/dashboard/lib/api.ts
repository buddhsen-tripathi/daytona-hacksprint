"use client";

import { useEffect, useRef, useState } from "react";
import { mockFetch } from "./mock";

export type PollState<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** ms epoch of last successful fetch */
  updatedAt: number | null;
};

/** Poll `/api/bot<path>` every `intervalMs`. Keeps the last good payload when the API blips. */
export function usePoll<T>(path: string | null, opts: { mock: boolean; intervalMs?: number }): PollState<T> {
  const { mock, intervalMs = 2000 } = opts;
  const [state, setState] = useState<PollState<T>>({ data: null, error: null, loading: true, updatedAt: null });
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    if (!path) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ctrl = new AbortController();

    const tick = async () => {
      try {
        let data: T;
        if (mock) {
          data = mockFetch(path) as T;
        } else {
          const res = await fetch(`/api/bot${path}`, { cache: "no-store", signal: ctrl.signal });
          if (!res.ok) {
            let msg = `HTTP ${res.status}`;
            try {
              const j = (await res.json()) as { error?: string; message?: string };
              msg = j.message ?? j.error ?? msg;
            } catch {
              /* not json */
            }
            throw new Error(msg);
          }
          data = (await res.json()) as T;
        }
        if (alive.current) setState({ data, error: null, loading: false, updatedAt: Date.now() });
      } catch (err) {
        if (ctrl.signal.aborted) return;
        if (alive.current) setState((s) => ({ ...s, error: (err as Error).message, loading: false }));
      }
      if (alive.current && !mock) timer = setTimeout(tick, intervalMs);
    };
    void tick();
    return () => {
      alive.current = false;
      ctrl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [path, mock, intervalMs]);

  return state;
}

/** Arrays may come back bare or wrapped ({ complaints: [...] } / { items: [...] }). */
export function asList<T>(raw: unknown, key: string): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    for (const k of [key, "items", "data", "results"]) if (Array.isArray(o[k])) return o[k] as T[];
  }
  return [];
}

export function withMock(href: string, mock: boolean) {
  if (!mock) return href;
  return href + (href.includes("?") ? "&" : "?") + "mock=1";
}
