// Cursor smoothing (§4.3): raw hook positions → 120 Hz grid → One-Euro filter.
// Precomputed so preview and export sample the exact same path (determinism, §7.3).

import type { InputEvent } from "../types";

export const CURSOR_HZ = 120;

export interface CursorPath {
  xs: Float32Array;
  ys: Float32Array;
  /** For each grid index, the time (s) of the last raw cursor movement. */
  lastMove: Float32Array;
  duration: number;
  sample(t: number): [number, number];
  idleTime(t: number): number;
}

const STRENGTH: Record<string, { minCutoff: number; beta: number } | null> = {
  off: null,
  subtle: { minCutoff: 2.5, beta: 0.05 },
  medium: { minCutoff: 1.2, beta: 0.012 },
  strong: { minCutoff: 0.45, beta: 0.004 },
};

function oneEuro(values: Float32Array, dt: number, minCutoff: number, beta: number): Float32Array {
  const out = new Float32Array(values.length);
  const dCutoff = 1.0;
  const alphaFor = (cutoff: number) => {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  };
  let prev = values[0] ?? 0;
  let dPrev = 0;
  out[0] = prev;
  for (let i = 1; i < values.length; i++) {
    const dRaw = (values[i] - prev) / dt;
    const aD = alphaFor(dCutoff);
    dPrev = aD * dRaw + (1 - aD) * dPrev;
    const cutoff = minCutoff + beta * Math.abs(dPrev);
    const a = alphaFor(cutoff);
    prev = a * values[i] + (1 - a) * prev;
    out[i] = prev;
  }
  return out;
}

export function buildCursorPath(
  events: InputEvent[],
  durationSec: number,
  smoothing: string,
  fallbackX: number,
  fallbackY: number,
): CursorPath {
  const n = Math.max(2, Math.ceil(durationSec * CURSOR_HZ) + 1);
  const xs = new Float32Array(n);
  const ys = new Float32Array(n);
  const lastMove = new Float32Array(n);

  // Raw position samples (moves + clicks all carry positions).
  const pts: Array<{ t: number; x: number; y: number }> = [];
  for (const ev of events) {
    if ((ev.k === "move" || ev.k === "down" || ev.k === "up" || ev.k === "wheel") &&
        ev.x !== undefined && ev.y !== undefined) {
      pts.push({ t: ev.t / 1000, x: ev.x, y: ev.y });
    }
  }

  if (pts.length === 0) {
    xs.fill(fallbackX);
    ys.fill(fallbackY);
    lastMove.fill(-1e9);
  } else {
    // Linear resample onto the grid.
    let j = 0;
    let lastMoveT = pts[0].t;
    let prevPt = pts[0];
    for (let i = 0; i < n; i++) {
      const t = i / CURSOR_HZ;
      while (j < pts.length - 1 && pts[j + 1].t <= t) {
        const moved =
          Math.abs(pts[j + 1].x - prevPt.x) + Math.abs(pts[j + 1].y - prevPt.y) > 1.5;
        if (moved) lastMoveT = pts[j + 1].t;
        prevPt = pts[j + 1];
        j++;
      }
      const a = pts[j];
      const b = pts[Math.min(j + 1, pts.length - 1)];
      const span = b.t - a.t;
      const f = span > 1e-6 ? Math.min(1, Math.max(0, (t - a.t) / span)) : 0;
      xs[i] = a.x + (b.x - a.x) * f;
      ys[i] = a.y + (b.y - a.y) * f;
      lastMove[i] = lastMoveT;
    }
  }

  const cfg = STRENGTH[smoothing] ?? STRENGTH.medium;
  const fxs = cfg ? oneEuro(xs, 1 / CURSOR_HZ, cfg.minCutoff, cfg.beta) : xs;
  const fys = cfg ? oneEuro(ys, 1 / CURSOR_HZ, cfg.minCutoff, cfg.beta) : ys;

  const path: CursorPath = {
    xs: fxs,
    ys: fys,
    lastMove,
    duration: durationSec,
    sample(t: number): [number, number] {
      const f = Math.min(Math.max(t, 0), durationSec) * CURSOR_HZ;
      const i = Math.min(Math.floor(f), n - 2);
      const frac = f - i;
      return [
        fxs[i] + (fxs[i + 1] - fxs[i]) * frac,
        fys[i] + (fys[i + 1] - fys[i]) * frac,
      ];
    },
    idleTime(t: number): number {
      const i = Math.min(Math.max(0, Math.floor(t * CURSOR_HZ)), n - 1);
      return t - lastMove[i];
    },
  };
  return path;
}
