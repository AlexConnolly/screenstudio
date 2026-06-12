// THE render core (§7.3): one pure function (media, events, project, t) → frame.
// Preview draws it to the visible canvas; export draws it to an offscreen canvas whose
// pixels go straight to the encoder. There are no preview-only or export-only effects.

import type { Meta, Project } from "../types";
import type { CameraPath, Stage } from "./camera";
import type { CursorPath } from "./cursorPath";
import { drawCaptions, type CaptionChunk } from "./captions";
import { cursorTypeAt, keyLabelAt, type PreppedEvents } from "./events";
import { drawCursorSprite } from "./cursorSprites";
import { drawWebcam } from "./webcam";

export interface RenderInputs {
  project: Project;
  meta: Meta;
  video: CanvasImageSource;
  stage: Stage;
  camera: CameraPath;
  cursor: CursorPath;
  prepped: PreppedEvents;
  camVideo?: HTMLVideoElement | null;
  captionChunks?: CaptionChunk[];
  bgImage?: CanvasImageSource | null;
}

export function aspectRatio(project: Project, meta: Meta): number {
  switch (project.style.aspect) {
    case "9:16": return 9 / 16;
    case "1:1": return 1;
    case "original": {
      const c = project.style.crop;
      const w = (c?.w ?? 1) * meta.width;
      const h = (c?.h ?? 1) * meta.height;
      return w / Math.max(1, h);
    }
    default: return 16 / 9;
  }
}

/** Where the recording sits inside the output frame — shared by render and hit-testing. */
export function computeInset(
  outW: number,
  outH: number,
  padding: number,
  stage: Stage,
): { ix: number; iy: number; iw: number; ih: number } {
  const pad = padding * Math.min(outW, outH);
  const availW = outW - pad * 2;
  const availH = outH - pad * 2;
  const stageAspect = stage.w / stage.h;
  let iw = availW;
  let ih = iw / stageAspect;
  if (ih > availH) {
    ih = availH;
    iw = ih * stageAspect;
  }
  return { ix: (outW - iw) / 2, iy: (outH - ih) / 2, iw, ih };
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function hexWithOpacity(hex: string, opacity: number): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6);
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${opacity})`;
}

/**
 * Renders the frame at source time `srcTime` into `ctx` (canvas of outW×outH).
 * Deterministic: everything derives from precomputed paths + srcTime.
 */
export function renderFrame(
  ctx: CanvasRenderingContext2D,
  outW: number,
  outH: number,
  srcTime: number,
  inp: RenderInputs,
): void {
  const { project, stage, camera, cursor, prepped } = inp;
  const style = project.style;
  // Style values are authored against a 1080p reference and scale with resolution.
  const refScale = Math.min(outW, outH) / 1080;

  // 1. Background
  drawBackground(ctx, outW, outH, inp);

  // 2. Inset rect: fit the (cropped) recording into the padded frame (§5.3).
  const { ix, iy, iw, ih } = computeInset(outW, outH, style.padding, stage);
  const radius = style.cornerRadius * refScale;

  // 3. Camera viewport in stage space.
  const cam = camera.sample(srcTime);
  const vw = stage.w / cam.zoom;
  const vh = stage.h / cam.zoom;
  const vx = cam.cx - vw / 2;
  const vy = cam.cy - vh / 2;
  const stageToCanvas = (px: number, py: number): [number, number] => [
    ix + ((px - vx) / vw) * iw,
    iy + ((py - vy) / vh) * ih,
  ];
  const stageScale = iw / vw; // stage px → canvas px at current zoom

  // 4. Shadow under the recording (§5.3).
  if (style.shadow.size > 0 && style.shadow.opacity > 0) {
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${style.shadow.opacity})`;
    ctx.shadowBlur = style.shadow.size * refScale;
    ctx.shadowOffsetX = style.shadow.offsetX * refScale;
    ctx.shadowOffsetY = style.shadow.offsetY * refScale;
    roundRectPath(ctx, ix, iy, iw, ih, radius);
    ctx.fillStyle = "#000";
    ctx.fill();
    ctx.restore();
  }

  // 5. The recording, zoomed by the camera, clipped to rounded corners.
  ctx.save();
  roundRectPath(ctx, ix, iy, iw, ih, radius);
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  const drawVideoAt = (c: { cx: number; cy: number; zoom: number }, alpha: number) => {
    const w = stage.w / c.zoom;
    const h = stage.h / c.zoom;
    ctx.globalAlpha = alpha;
    ctx.drawImage(inp.video, stage.x + c.cx - w / 2, stage.y + c.cy - h / 2, w, h, ix, iy, iw, ih);
    ctx.globalAlpha = 1;
  };

  // Motion blur on camera pans/zooms (§4.3 "natural movement"): layer the frame at the
  // camera's two previous sub-frame positions when it is moving fast.
  let blurred = false;
  if (project.cursor.motionBlur) {
    const prev = camera.sample(Math.max(0, srcTime - 1 / 60));
    const mid = camera.sample(Math.max(0, srcTime - 1 / 120));
    const movePx =
      (Math.abs(prev.cx - cam.cx) / vw) * iw +
      (Math.abs(prev.cy - cam.cy) / vh) * ih +
      (Math.abs(prev.zoom - cam.zoom) / cam.zoom) * iw * 0.5;
    if (movePx > 3) {
      drawVideoAt(prev, 1);
      drawVideoAt(mid, 0.5);
      drawVideoAt(cam, 0.6);
      blurred = true;
    }
  }
  if (!blurred) drawVideoAt(cam, 1);

  // 6. Click effects (§4.3) — inside the clip so ripples stay on the recording.
  if (project.cursor.clickEffects && !project.cursor.hidden) {
    for (const click of prepped.clicks) {
      const age = srcTime - click.t;
      if (age < 0 || age > 0.55) continue;
      const p = age / 0.55;
      const ease = 1 - (1 - p) * (1 - p);
      const [cxp, cyp] = stageToCanvas(click.x - stage.x, click.y - stage.y);
      const r = (10 + 46 * ease) * stageScale * project.cursor.size * 0.55;
      ctx.beginPath();
      ctx.arc(cxp, cyp, Math.max(0.5, r), 0, Math.PI * 2);
      ctx.strokeStyle = hexWithOpacity(project.cursor.clickColor, (1 - p) * 0.65);
      ctx.lineWidth = Math.max(1, 2.4 * stageScale * 0.5);
      ctx.stroke();
    }
  }

  // 7. Synthetic cursor (§4.3).
  if (!project.cursor.hidden) {
    let opacity = 1;
    if (project.cursor.autoHide) {
      const idle = cursor.idleTime(srcTime) - project.cursor.autoHideDelay;
      if (idle > 0) opacity = Math.max(0, 1 - idle / 0.35);
    }
    if (opacity > 0.01) {
      const [px, py] = cursor.sample(srcTime);
      const [cxp, cyp] = stageToCanvas(px - stage.x, py - stage.y);
      let squish = 1;
      if (project.cursor.scaleOnClick) {
        for (const click of prepped.clicks) {
          const age = srcTime - click.t;
          if (age >= 0 && age < 0.18) {
            const p = age / 0.18;
            squish = 1 - 0.16 * Math.sin(p * Math.PI);
          }
        }
      }
      const spriteScale =
        project.cursor.size * squish * stageScale * (inp.meta.scale || 1) * 0.9;
      const type = cursorTypeAt(prepped, srcTime);

      // Cursor motion blur: ghost trail when the (smoothed) cursor moves fast (§4.3).
      if (project.cursor.motionBlur) {
        const [hx, hy] = cursor.sample(Math.max(0, srcTime - 1 / 60));
        const [hcx, hcy] = stageToCanvas(hx - stage.x, hy - stage.y);
        const speed = Math.hypot(hcx - cxp, hcy - cyp);
        if (speed > 7) {
          const ghosts = [0.75, 0.5, 0.25];
          for (let g = 0; g < ghosts.length; g++) {
            const f = ghosts[g];
            ctx.globalAlpha = opacity * 0.14 * (g + 1);
            drawCursorSprite(ctx, type, cxp + (hcx - cxp) * f, cyp + (hcy - cyp) * f, spriteScale);
          }
        }
      }

      ctx.globalAlpha = opacity;
      drawCursorSprite(ctx, type, cxp, cyp, spriteScale);
      ctx.globalAlpha = 1;
    }
  }
  ctx.restore(); // un-clip

  // 8. Border stroke (§5.3).
  if (style.border.width > 0) {
    roundRectPath(ctx, ix, iy, iw, ih, radius);
    ctx.strokeStyle = hexWithOpacity(style.border.color, style.border.opacity);
    ctx.lineWidth = style.border.width * refScale;
    ctx.stroke();
  }

  // 9. Keystroke overlay (§4.4).
  if (project.keystrokes.enabled) {
    const key = keyLabelAt(prepped, srcTime);
    if (key) {
      const fadeIn = Math.min(1, key.age / 0.12);
      const fadeOut = Math.min(1, Math.max(0, (1.6 - key.age) / 0.25));
      const alpha = Math.min(fadeIn, fadeOut);
      if (alpha > 0.01) {
        const fontSize = 30 * refScale;
        ctx.font = `600 ${fontSize}px "Segoe UI", system-ui, sans-serif`;
        const metrics = ctx.measureText(key.label);
        const padX = 26 * refScale;
        const padY = 16 * refScale;
        const w = metrics.width + padX * 2;
        const h = fontSize + padY * 2;
        const x = (outW - w) / 2;
        const y = project.keystrokes.position === "top"
          ? 48 * refScale
          : outH - h - 48 * refScale;
        const dark = project.keystrokes.theme === "dark";
        ctx.globalAlpha = alpha;
        roundRectPath(ctx, x, y, w, h, h / 2);
        ctx.fillStyle = dark ? "rgba(12,14,20,0.82)" : "rgba(250,250,252,0.92)";
        ctx.fill();
        ctx.strokeStyle = dark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.1)";
        ctx.lineWidth = 1.2 * refScale;
        ctx.stroke();
        ctx.fillStyle = dark ? "#f1f5f9" : "#111827";
        ctx.textBaseline = "middle";
        ctx.textAlign = "center";
        ctx.fillText(key.label, outW / 2, y + h / 2 + fontSize * 0.05);
        ctx.textAlign = "start";
        ctx.globalAlpha = 1;
      }
    }
  }

  // 10. Webcam overlay (§7.2 composite order: … → webcam → captions).
  if (project.webcam?.enabled && inp.camVideo) {
    let cursorCanvas: { x: number; y: number } | null = null;
    if (project.webcam.autoDodge) {
      const [px, py] = cursor.sample(srcTime);
      const [ccx, ccy] = stageToCanvas(px - stage.x, py - stage.y);
      cursorCanvas = { x: ccx, y: ccy };
    }
    drawWebcam(ctx, outW, outH, srcTime, project.webcam, inp.camVideo, refScale, cursorCanvas);
  }

  // 11. Captions on top of everything.
  if (project.captions?.enabled && inp.captionChunks?.length) {
    drawCaptions(ctx, outW, outH, srcTime, project.captions, inp.captionChunks, refScale);
  }
}

function drawBackground(
  ctx: CanvasRenderingContext2D,
  outW: number,
  outH: number,
  inp: RenderInputs,
): void {
  const bg = inp.project.style.background;
  if (bg.type === "image" && inp.bgImage) {
    const img = inp.bgImage as { width?: number; height?: number };
    const sw = (img.width as number) || outW;
    const sh = (img.height as number) || outH;
    const scale = Math.max(outW / sw, outH / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    ctx.save();
    if (bg.blur > 0) ctx.filter = `blur(${bg.blur}px)`;
    ctx.drawImage(inp.bgImage, (outW - dw) / 2, (outH - dh) / 2, dw, dh);
    ctx.restore();
    return;
  }
  if (bg.type === "gradient") {
    const rad = ((bg.angle - 90) * Math.PI) / 180;
    const cx = outW / 2;
    const cy = outH / 2;
    const len = (Math.abs(Math.cos(rad)) * outW + Math.abs(Math.sin(rad)) * outH) / 2;
    const g = ctx.createLinearGradient(
      cx - Math.cos(rad) * len, cy - Math.sin(rad) * len,
      cx + Math.cos(rad) * len, cy + Math.sin(rad) * len,
    );
    g.addColorStop(0, bg.from);
    g.addColorStop(1, bg.to);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, outW, outH);
    return;
  }
  ctx.fillStyle = bg.color;
  ctx.fillRect(0, 0, outW, outH);
}
