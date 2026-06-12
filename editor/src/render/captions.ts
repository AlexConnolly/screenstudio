// TikTok-style captions (§5.6, low-attention-span edition): transcribed words are
// grouped into tiny chunks (≤ maxWords, split on speech gaps), drawn huge and bold with
// a pop-in and the currently spoken word highlighted. Pure function of (config, t) —
// preview === export, like every other layer.

import type { CaptionConfig, CaptionWord } from "../types";

export interface CaptionChunk {
  start: number;
  end: number;
  words: CaptionWord[];
}

const GAP_SPLIT_SEC = 0.8; // a breath = a new chunk
const MIN_SHOW_SEC = 0.35;

export function chunkWords(words: CaptionWord[], maxWords: number): CaptionChunk[] {
  const chunks: CaptionChunk[] = [];
  let current: CaptionWord[] = [];
  const flush = () => {
    if (current.length === 0) return;
    chunks.push({
      start: current[0].t0,
      end: Math.max(current[current.length - 1].t1, current[0].t0 + MIN_SHOW_SEC),
      words: current,
    });
    current = [];
  };
  for (const w of words) {
    if (!w.text.trim()) continue;
    if (current.length > 0) {
      const gap = w.t0 - current[current.length - 1].t1;
      const endsSentence = /[.!?]$/.test(current[current.length - 1].text);
      if (current.length >= Math.max(1, maxWords) || gap > GAP_SPLIT_SEC || endsSentence) flush();
    }
    current.push(w);
  }
  flush();
  // Chunks must not overlap: a new chunk replaces the previous one immediately.
  for (let i = 0; i < chunks.length - 1; i++) {
    chunks[i].end = Math.min(chunks[i].end, chunks[i + 1].start);
    chunks[i].end = Math.max(chunks[i].end, chunks[i].start + 0.05);
  }
  return chunks;
}

function chunkAt(chunks: CaptionChunk[], t: number): CaptionChunk | null {
  for (const c of chunks) {
    if (t >= c.start && t < c.end + 0.12) return t < c.end ? c : c; // tiny linger
    if (c.start > t) break;
  }
  return null;
}

export function drawCaptions(
  ctx: CanvasRenderingContext2D,
  outW: number,
  outH: number,
  srcTime: number,
  cfg: CaptionConfig,
  chunks: CaptionChunk[],
  refScale: number,
): void {
  const chunk = chunkAt(chunks, srcTime);
  if (!chunk) return;

  const texts = chunk.words.map((w) => (cfg.uppercase ? w.text.toUpperCase() : w.text));
  let fontSize = 68 * cfg.fontScale * refScale;
  const maxWidth = outW * 0.86;
  const font = (size: number) =>
    `900 ${size}px "Segoe UI", "Inter", system-ui, sans-serif`;

  ctx.save();
  ctx.font = font(fontSize);
  const space = () => ctx.measureText(" ").width;
  let total = texts.reduce((acc, t) => acc + ctx.measureText(t).width, 0) + space() * (texts.length - 1);
  if (total > maxWidth) {
    fontSize *= maxWidth / total;
    ctx.font = font(fontSize);
    total = texts.reduce((acc, t) => acc + ctx.measureText(t).width, 0) + space() * (texts.length - 1);
  }

  // Pop-in: quick overshoot scale when the chunk appears.
  let scale = 1;
  if (cfg.pop) {
    const age = srcTime - chunk.start;
    const p = Math.min(1, age / 0.14);
    scale = 1.18 - 0.18 * (1 - (1 - p) * (1 - p)); // ease-out from 1.18 → 1
  }

  const cy =
    cfg.position === "top" ? outH * 0.16 :
    cfg.position === "bottom" ? outH * 0.84 :
    outH * 0.62; // "center" sits slightly low so it doesn't cover faces/action

  ctx.translate(outW / 2, cy);
  ctx.scale(scale, scale);
  ctx.textBaseline = "middle";

  let x = -total / 2;
  for (let i = 0; i < texts.length; i++) {
    const w = chunk.words[i];
    const width = ctx.measureText(texts[i]).width;
    const spoken = srcTime >= w.t0 && srcTime < w.t1;

    if (cfg.outline) {
      ctx.lineJoin = "round";
      ctx.strokeStyle = "rgba(0,0,0,0.9)";
      ctx.lineWidth = fontSize * 0.18;
      ctx.strokeText(texts[i], x, 0);
    }
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = 6 * refScale;
    ctx.shadowOffsetY = 2 * refScale;
    ctx.fillStyle = spoken ? cfg.highlightColor : cfg.color;
    ctx.fillText(texts[i], x, 0);
    ctx.shadowColor = "transparent";
    x += width + space();
  }
  ctx.restore();
}

export function toSrt(chunks: CaptionChunk[], uppercase: boolean): string {
  const ts = (t: number) => {
    const ms = Math.max(0, Math.round(t * 1000));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const f = ms % 1000;
    const pad = (n: number, l = 2) => n.toString().padStart(l, "0");
    return `${pad(h)}:${pad(m)}:${pad(s)},${pad(f, 3)}`;
  };
  return chunks
    .map((c, i) => {
      const text = c.words.map((w) => (uppercase ? w.text.toUpperCase() : w.text)).join(" ");
      return `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${text}\n`;
    })
    .join("\n");
}
