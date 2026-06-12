// The virtual camera (§4.1): zoom segments → a precomputed 60 Hz camera path.
// Critically damped springs (never overshoot, never jitter — §10.2) chase a piecewise
// target; adjacent/overlapping segments blend target→target without returning to full
// frame; follow-cursor uses a dead-zone (§4.1). Precomputing the whole path keeps
// preview, scrubbing and export pixel-identical (§7.3) and regen < 1 s for 10 min (§10.3).

import type { Project, ZoomSegment } from "../types";
import type { CursorPath } from "./cursorPath";

export const CAMERA_HZ = 60;
const DEAD_ZONE = 0.4; // cursor roams the middle 40% of the viewport before the camera pans

export interface Stage {
  x: number; // crop offset in capture px
  y: number;
  w: number;
  h: number;
}

export interface CameraPath {
  /** stride 3: centerX, centerY (stage px), zoom */
  data: Float32Array;
  duration: number;
  sample(t: number): { cx: number; cy: number; zoom: number };
}

export function stageFromProject(project: Project, width: number, height: number): Stage {
  const c = project.style.crop;
  if (!c) return { x: 0, y: 0, w: width, h: height };
  return {
    x: c.x * width,
    y: c.y * height,
    w: Math.max(16, c.w * width),
    h: Math.max(16, c.h * height),
  };
}

/** SmoothDamp — critically damped spring step. Returns [value, velocity]. */
function smoothDamp(
  current: number, target: number, vel: number, smoothTime: number, dt: number,
): [number, number] {
  const omega = 2 / Math.max(1e-4, smoothTime);
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target;
  const temp = (vel + omega * change) * dt;
  const newVel = (vel - omega * temp) * exp;
  return [target + (change + temp) * exp, newVel];
}

export function buildCameraPath(
  project: Project,
  durationSec: number,
  stage: Stage,
  cursor: CursorPath,
): CameraPath {
  const n = Math.max(2, Math.ceil(durationSec * CAMERA_HZ) + 1);
  const data = new Float32Array(n * 3);
  const dt = 1 / CAMERA_HZ;

  const segments = (project.zoom.autoEnabled
    ? project.zoom.segments
    : project.zoom.segments.filter((s) => s.kind === "manual")
  ).slice().sort((a, b) => a.start - b.start);

  let cx = stage.w / 2;
  let cy = stage.h / 2;
  let zoom = 1;
  let vcx = 0, vcy = 0, vz = 0;
  let lastSeg: ZoomSegment | null = null;
  let segIdx = 0;
  const activeStack: ZoomSegment[] = [];

  for (let i = 0; i < n; i++) {
    const t = i * dt;

    // Track active segment (latest-starting one wins on overlap).
    while (segIdx < segments.length && segments[segIdx].start <= t) {
      activeStack.push(segments[segIdx]);
      segIdx++;
    }
    while (activeStack.length && activeStack[activeStack.length - 1].end <= t) activeStack.pop();
    let active: ZoomSegment | null = null;
    for (let k = activeStack.length - 1; k >= 0; k--) {
      if (activeStack[k].end > t) { active = activeStack[k]; break; }
    }

    let targetZoom = 1;
    let tx = stage.w / 2;
    let ty = stage.h / 2;
    let smoothTime: number;

    if (active) {
      lastSeg = active;
      targetZoom = Math.max(1, active.zoom);
      tx = active.cx * stage.w;
      ty = active.cy * stage.h;

      if (active.follow) {
        // Dead-zone follow (§4.1): the camera only moves when the smoothed cursor
        // leaves the central region of the current viewport.
        const [rawX, rawY] = cursor.sample(t);
        const curX = rawX - stage.x;
        const curY = rawY - stage.y;
        const vw = stage.w / Math.max(1, zoom);
        const vh = stage.h / Math.max(1, zoom);
        const maxDx = (vw * DEAD_ZONE) / 2;
        const maxDy = (vh * DEAD_ZONE) / 2;
        let fx = cx, fy = cy; // start from where the camera is — no drift-back
        if (curX > fx + maxDx) fx = curX - maxDx;
        else if (curX < fx - maxDx) fx = curX + maxDx;
        if (curY > fy + maxDy) fy = curY - maxDy;
        else if (curY < fy - maxDy) fy = curY + maxDy;
        // Early in the segment, bias toward the segment anchor so the zoom lands
        // on the click; follow takes over once settled.
        const settle = Math.min(1, (t - active.start) / Math.max(0.2, active.easeIn));
        tx = tx + (fx - tx) * settle;
        ty = ty + (fy - ty) * settle;
      }
      // Springs: zooming in uses easeIn response, panning slightly snappier.
      smoothTime = (targetZoom >= zoom ? active.easeIn : active.easeOut) * 0.38;
    } else {
      smoothTime = (lastSeg?.easeOut ?? 1.2) * 0.38;
    }

    // Clamp the *target* so the viewport at target zoom stays inside the stage (§4.1).
    const tvw = stage.w / targetZoom;
    const tvh = stage.h / targetZoom;
    tx = Math.min(Math.max(tx, tvw / 2), stage.w - tvw / 2);
    ty = Math.min(Math.max(ty, tvh / 2), stage.h - tvh / 2);

    [zoom, vz] = smoothDamp(zoom, targetZoom, vz, smoothTime, dt);
    const panSmooth = smoothTime * 0.85;
    [cx, vcx] = smoothDamp(cx, tx, vcx, panSmooth, dt);
    [cy, vcy] = smoothDamp(cy, ty, vcy, panSmooth, dt);
    if (zoom < 1) zoom = 1;

    // Clamp the actual viewport too (never show outside the recording, §10.2).
    const vw = stage.w / zoom;
    const vh = stage.h / zoom;
    cx = Math.min(Math.max(cx, vw / 2), stage.w - vw / 2);
    cy = Math.min(Math.max(cy, vh / 2), stage.h - vh / 2);

    data[i * 3] = cx;
    data[i * 3 + 1] = cy;
    data[i * 3 + 2] = zoom;
  }

  return {
    data,
    duration: durationSec,
    sample(t: number) {
      const f = Math.min(Math.max(t, 0), durationSec) * CAMERA_HZ;
      const i = Math.min(Math.floor(f), n - 2);
      const frac = f - i;
      const lerp = (a: number, b: number) => a + (b - a) * frac;
      return {
        cx: lerp(data[i * 3], data[(i + 1) * 3]),
        cy: lerp(data[i * 3 + 1], data[(i + 1) * 3 + 1]),
        zoom: lerp(data[i * 3 + 2], data[(i + 1) * 3 + 2]),
      };
    },
  };
}
