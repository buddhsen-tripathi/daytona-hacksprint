"use client";

import { useState } from "react";
import { MapPin } from "lucide-react";

const Z = 17;
const TILE = 256;

function project(lat: number, lon: number) {
  const n = 2 ** Z;
  const x = ((lon + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return { x, y };
}

/** Static OSM tile mosaic centred on the pin; falls back to an SVG street grid if tiles fail. */
export function MapPinView({ lat, lon, label }: { lat: number | null; lon: number | null; label: string }) {
  const [failed, setFailed] = useState(false);
  const H = 190;
  if (lat == null || lon == null || failed) {
    return (
      <div className="relative h-[190px] overflow-hidden border border-rule bg-paper2" role="img" aria-label={`Map placeholder for ${label}`}>
        <svg className="absolute inset-0 size-full text-rule2" aria-hidden>
          <defs>
            <pattern id="streets" width="46" height="30" patternUnits="userSpaceOnUse" patternTransform="rotate(29)">
              <path d="M0 0H46M0 0V30" stroke="currentColor" strokeWidth="5" fill="none" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#streets)" />
        </svg>
        <div className="absolute inset-0 grid place-items-center">
          <MapPin className="size-8 fill-signal text-ink" aria-hidden />
        </div>
        {lat == null && <div className="absolute bottom-2 left-2 bg-card px-1.5 py-0.5 font-mono text-[10px] text-muted">no coordinates yet</div>}
      </div>
    );
  }
  const { x, y } = project(lat, lon);
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  const tiles: { dx: number; dy: number }[] = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -2; dx <= 2; dx++) tiles.push({ dx, dy });
  // pixel offset of the point within the (tx,ty) tile
  const px = (x - tx) * TILE;
  const py = (y - ty) * TILE;
  return (
    <div className="relative overflow-hidden border border-rule bg-paper2" style={{ height: H }} role="img" aria-label={`Map of ${label}`}>
      <div className="absolute top-1/2 left-1/2" style={{ transform: `translate(${-px}px, ${-py}px)` }}>
        {tiles.map(({ dx, dy }) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={`${dx},${dy}`}
            src={`https://tile.openstreetmap.org/${Z}/${tx + dx}/${ty + dy}.png`}
            alt=""
            width={TILE}
            height={TILE}
            className="absolute max-w-none grayscale-[0.55] sepia-[0.25]"
            style={{ left: dx * TILE, top: dy * TILE }}
            onError={() => setFailed(true)}
          />
        ))}
      </div>
      <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-full">
        <MapPin className="size-9 fill-signal text-ink drop-shadow" strokeWidth={2.2} aria-hidden />
      </div>
      <span className="pointer-events-none absolute top-1/2 left-1/2 size-16 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-signal/70" aria-hidden />
      <div className="absolute right-0 bottom-0 bg-card/85 px-1 font-mono text-[9px] text-ink2">© OpenStreetMap contributors</div>
      <div className="absolute top-2 left-2 bg-ink px-1.5 py-0.5 font-mono text-[10px] text-paper tabular">
        {lat.toFixed(5)}, {lon.toFixed(5)}
      </div>
    </div>
  );
}
