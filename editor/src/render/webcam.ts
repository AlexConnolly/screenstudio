// Webcam overlay (§5.4): position presets/custom drag, circle or rounded-rect shapes,
// border + shadow, mirror — and timeline keyframing with smooth animated transitions
// between layouts, including full-screen talking-head segments. Pure functions of
// (config, t) so preview and export stay pixel-identical (§7.3).

import type { WebcamConfig, WebcamKeyframe } from "../types";

export interface WebcamLayout {
  x: number;
  y: number;
  w: number;
  h: number;
  radius: number;
  alpha: number;
}

const TRANSITION_SEC = 0.7;

function smootherstep(p: number): number {
  const t = Math.min(1, Math.max(0, p));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

interface LayoutState {
  size: number;
  nx: number;
  ny: number;
  fullscreen: boolean;
  hidden: boolean;
}

function stateRect(
  s: LayoutState,
  wc: WebcamConfig,
  outW: number,
  outH: number,
  videoAspect: number,
  refScale: number,
): WebcamLayout {
  if (s.fullscreen) {
    return { x: 0, y: 0, w: outW, h: outH, radius: 0, alpha: s.hidden ? 0 : 1 };
  }
  const h = Math.max(40, s.size * outH);
  const w = wc.shape === "circle" ? h : h * Math.max(1, Math.min(videoAspect, 16 / 9));
  const margin = 24 * refScale;
  const x = margin + s.nx * Math.max(0, outW - w - margin * 2);
  const y = margin + s.ny * Math.max(0, outH - h - margin * 2);
  const radius = wc.shape === "circle" ? h / 2 : Math.min(w, h) * 0.14;
  return { x, y, w, h, radius, alpha: s.hidden ? 0 : 1 };
}

function lerp(a: number, b: number, p: number): number {
  return a + (b - a) * p;
}

/** Layout at source time t: the last keyframe ≤ t takes effect, animating from the
 * previous layout over TRANSITION_SEC. No keyframes → the base layout. */
export function sampleWebcamLayout(
  wc: WebcamConfig,
  t: number,
  outW: number,
  outH: number,
  videoAspect: number,
  refScale: number,
): WebcamLayout | null {
  if (!wc.enabled) return null;
  const base: LayoutState = {
    size: wc.size,
    nx: wc.nx,
    ny: wc.ny,
    fullscreen: false,
    hidden: false,
  };
  const kfs = [...wc.keyframes].sort((a, b) => a.t - b.t);
  let cur: LayoutState = base;
  let prev: LayoutState = base;
  let curT = -Infinity;
  for (const kf of kfs) {
    if (kf.t > t) break;
    prev = cur;
    cur = kf;
    curT = kf.t;
  }
  const from = stateRect(prev, wc, outW, outH, videoAspect, refScale);
  const to = stateRect(cur, wc, outW, outH, videoAspect, refScale);
  const p = smootherstep((t - curT) / TRANSITION_SEC);
  return {
    x: lerp(from.x, to.x, p),
    y: lerp(from.y, to.y, p),
    w: lerp(from.w, to.w, p),
    h: lerp(from.h, to.h, p),
    radius: lerp(from.radius, to.radius, p),
    alpha: lerp(from.alpha, to.alpha, p),
  };
}

/** The keyframe whose layout is in effect at t (for editing), or null → base layout. */
export function activeKeyframe(wc: WebcamConfig, t: number): WebcamKeyframe | null {
  let found: WebcamKeyframe | null = null;
  for (const kf of [...wc.keyframes].sort((a, b) => a.t - b.t)) {
    if (kf.t > t) break;
    found = kf;
  }
  return found;
}

let scratch: HTMLCanvasElement | null = null;

/** The webcam frame cover-cropped to the bubble with a radial alpha falloff —
 * composited over the blurred copy it keeps the centered face sharp. */
function sharpCenterLayer(cam: HTMLVideoElement, l: WebcamLayout): HTMLCanvasElement {
  const w = Math.max(2, Math.ceil(l.w));
  const h = Math.max(2, Math.ceil(l.h));
  if (!scratch) scratch = document.createElement("canvas");
  if (scratch.width !== w || scratch.height !== h) {
    scratch.width = w;
    scratch.height = h;
  }
  const sctx = scratch.getContext("2d")!;
  sctx.globalCompositeOperation = "source-over";
  sctx.clearRect(0, 0, w, h);
  const scale = Math.max(w / cam.videoWidth, h / cam.videoHeight);
  const dw = cam.videoWidth * scale;
  const dh = cam.videoHeight * scale;
  sctx.drawImage(cam, (w - dw) / 2, (h - dh) / 2, dw, dh);
  sctx.globalCompositeOperation = "destination-in";
  const grad = sctx.createRadialGradient(
    w / 2, h * 0.42, Math.min(w, h) * 0.3,
    w / 2, h * 0.42, Math.min(w, h) * 0.72,
  );
  grad.addColorStop(0, "rgba(0,0,0,1)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  sctx.fillStyle = grad;
  sctx.fillRect(0, 0, w, h);
  sctx.globalCompositeOperation = "source-over";
  return scratch;
}

export function drawWebcam(
  ctx: CanvasRenderingContext2D,
  outW: number,
  outH: number,
  srcTime: number,
  wc: WebcamConfig,
  cam: HTMLVideoElement,
  refScale: number,
  cursorCanvas?: { x: number; y: number } | null,
): void {
  if (cam.readyState < 2 || cam.videoWidth === 0) return;
  const aspect = cam.videoWidth / cam.videoHeight;
  let l = sampleWebcamLayout(wc, srcTime, outW, outH, aspect, refScale);
  if (!l || l.alpha <= 0.01) return;

  // Auto-dodge (§5.4): the bubble slides to the mirrored position as the cursor
  // approaches. Pure function of cursor distance → smooth and deterministic.
  if (wc.autoDodge && cursorCanvas && l.w < outW * 0.9) {
    const bx = l.x + l.w / 2;
    const by = l.y + l.h / 2;
    const d = Math.hypot(cursorCanvas.x - bx, cursorCanvas.y - by);
    const r1 = Math.max(l.w, l.h) * 0.75;
    const r2 = Math.max(l.w, l.h) * 1.7;
    const f = smootherstep(1 - Math.min(1, Math.max(0, (d - r1) / (r2 - r1))));
    if (f > 0.001) {
      const altX = outW - l.x - l.w;
      l = { ...l, x: l.x + (altX - l.x) * f };
    }
  }

  ctx.save();
  ctx.globalAlpha = l.alpha;

  const path = () => {
    const r = Math.min(l.radius, l.w / 2, l.h / 2);
    ctx.beginPath();
    ctx.moveTo(l.x + r, l.y);
    ctx.arcTo(l.x + l.w, l.y, l.x + l.w, l.y + l.h, r);
    ctx.arcTo(l.x + l.w, l.y + l.h, l.x, l.y + l.h, r);
    ctx.arcTo(l.x, l.y + l.h, l.x, l.y, r);
    ctx.arcTo(l.x, l.y, l.x + l.w, l.y, r);
    ctx.closePath();
  };

  if (wc.shadow && l.w < outW) {
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = 26 * refScale;
    ctx.shadowOffsetY = 8 * refScale;
    path();
    ctx.fillStyle = "#000";
    ctx.fill();
    ctx.restore();
  }

  ctx.save();
  path();
  ctx.clip();
  // Cover-crop the camera frame into the layout rect.
  const scale = Math.max(l.w / cam.videoWidth, l.h / cam.videoHeight);
  const dw = cam.videoWidth * scale;
  const dh = cam.videoHeight * scale;
  const dx = l.x + (l.w - dw) / 2;
  const dy = l.y + (l.h - dh) / 2;
  if (wc.mirror) {
    ctx.translate(l.x + l.w / 2, 0);
    ctx.scale(-1, 1);
    ctx.translate(-(l.x + l.w / 2), 0);
  }
  ctx.imageSmoothingQuality = "high";
  if (wc.backdropBlur && l.w < outW * 0.9) {
    // "Background blur" without ML segmentation: blurred frame + sharp radial center —
    // keeps the (centered) face crisp while the room softens.
    ctx.filter = `blur(${Math.max(4, l.h * 0.045)}px)`;
    ctx.drawImage(cam, dx, dy, dw, dh);
    ctx.filter = "none";
    ctx.drawImage(sharpCenterLayer(cam, l), l.x, l.y);
  } else {
    ctx.drawImage(cam, dx, dy, dw, dh);
  }
  ctx.restore();

  if (wc.borderWidth > 0) {
    path();
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = wc.borderWidth * refScale;
    ctx.stroke();
  }
  ctx.restore();
}
