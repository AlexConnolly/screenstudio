// Edit decision list: trim + cuts + speed ranges → mapping between output time
// (what the viewer sees, gaps closed, speed applied) and source time (the recording).

import type { Project } from "../types";

export interface EdlRange {
  srcStart: number;
  srcEnd: number;
  speed: number;
  outStart: number;
  outDur: number;
}

export function buildEdl(project: Project, durationSec: number): EdlRange[] {
  const trimStart = Math.max(0, project.trim.start);
  const trimEnd = Math.min(durationSec, project.trim.end ?? durationSec);

  // Kept ranges = [trimStart, trimEnd] minus cuts.
  let kept: Array<[number, number]> = [[trimStart, trimEnd]];
  for (const cut of [...project.cuts].sort((a, b) => a.start - b.start)) {
    const next: Array<[number, number]> = [];
    for (const [s, e] of kept) {
      if (cut.end <= s || cut.start >= e) {
        next.push([s, e]);
        continue;
      }
      if (cut.start > s) next.push([s, cut.start]);
      if (cut.end < e) next.push([cut.end, e]);
    }
    kept = next;
  }

  // Split kept ranges at speed-range boundaries and assign factors.
  const boundaries = new Set<number>();
  for (const sp of project.speed) {
    boundaries.add(sp.start);
    boundaries.add(sp.end);
  }
  const ranges: EdlRange[] = [];
  let outCursor = 0;
  for (const [s, e] of kept) {
    const pts = [s, ...[...boundaries].filter((b) => b > s && b < e).sort((a, b) => a - b), e];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      if (b - a < 1e-6) continue;
      const mid = (a + b) / 2;
      const sp = project.speed.find((r) => mid >= r.start && mid < r.end);
      const speed = Math.max(0.1, sp?.factor ?? 1);
      const outDur = (b - a) / speed;
      ranges.push({ srcStart: a, srcEnd: b, speed, outStart: outCursor, outDur });
      outCursor += outDur;
    }
  }
  return ranges;
}

export function outputDuration(edl: EdlRange[]): number {
  if (edl.length === 0) return 0;
  const last = edl[edl.length - 1];
  return last.outStart + last.outDur;
}

export function outToSrc(edl: EdlRange[], t: number): number {
  if (edl.length === 0) return t;
  for (const r of edl) {
    if (t < r.outStart + r.outDur) {
      return r.srcStart + Math.max(0, t - r.outStart) * r.speed;
    }
  }
  return edl[edl.length - 1].srcEnd;
}

export function srcToOut(edl: EdlRange[], t: number): number {
  if (edl.length === 0) return t;
  for (const r of edl) {
    if (t < r.srcStart) return r.outStart; // inside a cut → snap to next kept range
    if (t < r.srcEnd) return r.outStart + (t - r.srcStart) / r.speed;
  }
  const last = edl[edl.length - 1];
  return last.outStart + last.outDur;
}

export function rangeAtOut(edl: EdlRange[], t: number): EdlRange | undefined {
  return edl.find((r) => t >= r.outStart && t < r.outStart + r.outDur) ?? edl[edl.length - 1];
}
