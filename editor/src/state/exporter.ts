// Export client: answers the shell's pull-based frame requests (§7.3 determinism —
// the same renderFrame that drives the preview fills the encoder's shared buffer).

import { api, getSharedBuffer } from "../bridge";
import { renderFrame, type RenderInputs } from "../render/compositor";
import { outToSrc, rangeAtOut, srcToOut, type EdlRange } from "../render/edl";
import { getExportCam, getExportVideo, seekVideo } from "./media";
import { getDerived } from "./derived";
import { useStore } from "./store";

export interface ExportRequest {
  format: "mp4" | "gif";
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  codec: "h264" | "hevc";
}

/** Click times mapped to OUTPUT seconds (skipping clicks that fall inside cuts). */
function clickTimesOut(derived: ReturnType<typeof getDerived>, enabled: boolean): number[] {
  if (!enabled) return [];
  const out: number[] = [];
  for (const click of derived.prepped.clicks) {
    const t = srcToOut(derived.edl, click.t);
    if (Math.abs(outToSrc(derived.edl, t) - click.t) < 0.05) out.push(t);
  }
  return out;
}

interface ActiveExport {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  video: HTMLVideoElement;
  cam: HTMLVideoElement | null;
  camOffset: number;
  inputs: RenderInputs;
  edl: EdlRange[];
  fps: number;
  width: number;
  height: number;
}

let active: ActiveExport | null = null;

export async function startExport(req: ExportRequest): Promise<string> {
  const s = useStore.getState();
  if (!s.project || !s.meta || !s.events || !s.projectDir) return "";
  const derived = getDerived(s.project, s.meta, s.events);
  const durationSec = derived.outputDuration;
  if (durationSec <= 0) return "";

  const video = await getExportVideo(s.mediaBase);
  const cam = s.meta.hasWebcam && s.project.webcam.enabled
    ? await getExportCam(s.mediaBase)
    : null;
  const canvas = document.createElement("canvas");
  canvas.width = req.width;
  canvas.height = req.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return "";

  active = {
    canvas,
    ctx,
    video,
    cam,
    camOffset: (s.meta.camStartOffsetMs - s.meta.videoStartOffsetMs) / 1000,
    fps: req.fps,
    width: req.width,
    height: req.height,
    edl: derived.edl,
    inputs: {
      project: s.project,
      meta: s.meta,
      video,
      camVideo: cam,
      captionChunks: derived.captionChunks,
      stage: derived.stage,
      camera: derived.cameraPath,
      cursor: derived.cursorPath,
      prepped: derived.prepped,
    },
  };

  const settings = {
    format: req.format,
    width: req.width,
    height: req.height,
    fps: req.fps,
    durationSec,
    bitrate: req.bitrate,
    codec: req.codec,
    ranges: derived.edl.map((r) => ({ srcStart: r.srcStart, srcEnd: r.srcEnd, speed: r.speed })),
    audio: {
      micVolume: s.project.audio.micVolume,
      micMuted: s.project.audio.micMuted,
      sysVolume: s.project.audio.sysVolume,
      sysMuted: s.project.audio.sysMuted,
      normalize: s.project.audio.normalize,
      denoise: s.project.audio.denoise,
      musicFile: s.project.audio.musicFile ?? null,
      musicVolume: s.project.audio.musicVolume,
      duck: s.project.audio.duck,
      duckAmount: s.project.audio.duckAmount,
      clicks: clickTimesOut(derived, s.project.cursor.clickSound),
      clickVolume: s.project.cursor.clickSound ? s.project.cursor.clickSoundVolume : 0,
    },
  };
  const suggested = `${s.project.name || "recording"}.${req.format}`;
  const path = await api.beginExport(s.projectDir, settings, suggested);
  if (!path) active = null;
  return path;
}

/**
 * Positions a video at `target` for sequential reads without per-frame precise seeks —
 * those force a re-decode from the previous keyframe every time (~0.3 s/frame on a
 * 50 Mbps intermediate). Instead the element plays forward and we wait for playback to
 * cross the target; real seeks only happen at cuts/backward jumps. Source accuracy is
 * within one source frame, same as the preview's drift window.
 */
async function advanceTo(video: HTMLVideoElement, target: number): Promise<void> {
  const epsilon = 1 / 120;
  if (target < video.currentTime - 0.08 || target > video.currentTime + 2.5) {
    video.pause();
    await seekVideo(video, target);
    return;
  }
  if (video.currentTime >= target - epsilon) {
    // Never let playback outrun the encoder by more than ~2 source frames, or we'd
    // serve future frames for earlier targets.
    if (video.currentTime > target + 0.04 && !video.paused) video.pause();
    return;
  }
  const gap = target - video.currentTime;
  video.playbackRate = Math.min(8, Math.max(1, gap * 30)); // catch up fast through sped-up ranges
  if (video.paused) await video.play().catch(() => {});
  await new Promise<void>((resolve) => {
    const check = () => {
      if (!active || video.currentTime >= target - epsilon || video.ended) {
        resolve();
        return;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
}

export async function handleNeedFrame(index: number): Promise<void> {
  if (!active) return;
  const a = active;
  const outTime = (index + 0.5) / a.fps; // mid-frame sampling avoids cut-boundary flicker
  const srcTime = outToSrc(a.edl, outTime);
  await advanceTo(a.video, srcTime);
  if (a.cam) await advanceTo(a.cam, srcTime - a.camOffset);
  if (!active) return; // cancelled while seeking
  renderFrame(a.ctx, a.width, a.height, srcTime, a.inputs);

  const buffer = getSharedBuffer();
  if (buffer) {
    const img = a.ctx.getImageData(0, 0, a.width, a.height);
    new Uint8Array(buffer).set(img.data);
  }
  await api.frameReady();
}

export function endExport(): void {
  active = null;
}

// ---- WebM export (§6) ----
// Media Foundation has no VP9 encoder, but Chromium does: render the timeline in real
// time into a captured canvas + WebAudio mix and let MediaRecorder encode VP9/Opus.
// Same renderFrame as everything else; the trade-off is export time = video duration.

let webmCancel: (() => void) | null = null;

export function cancelWebmExport(): void {
  webmCancel?.();
}

export async function startWebmExport(req: {
  width: number;
  height: number;
  fps: number;
  bitrate: number;
}): Promise<boolean> {
  const s = useStore.getState();
  if (!s.project || !s.meta || !s.events) return false;
  const derived = getDerived(s.project, s.meta, s.events);
  const duration = derived.outputDuration;
  if (duration <= 0) return false;
  const project = s.project;
  const meta = s.meta;

  const video = await getExportVideo(s.mediaBase);
  const cam = meta.hasWebcam && project.webcam.enabled ? await getExportCam(s.mediaBase) : null;

  const canvas = document.createElement("canvas");
  canvas.width = req.width;
  canvas.height = req.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;

  // Audio graph: element sources → gains → stream destination (silent locally).
  const actx = new AudioContext();
  const dest = actx.createMediaStreamDestination();
  const makeTrack = async (file: string, volume: number) => {
    const el = new Audio(s.mediaBase + file);
    el.crossOrigin = "anonymous";
    el.preload = "auto";
    await new Promise<void>((res) => {
      el.oncanplay = () => res();
      el.onerror = () => res();
    });
    const src = actx.createMediaElementSource(el);
    const gain = actx.createGain();
    gain.gain.value = volume;
    src.connect(gain).connect(dest);
    return { el, gain };
  };
  const mic = meta.hasMic && !project.audio.micMuted
    ? await makeTrack("mic.wav", project.audio.micVolume) : null;
  const sys = meta.hasSystemAudio && !project.audio.sysMuted
    ? await makeTrack("sys.wav", project.audio.sysVolume) : null;
  const music = project.audio.musicFile && project.audio.musicVolume > 0
    ? await makeTrack(project.audio.musicFile, project.audio.musicVolume * (project.audio.duck ? 0.6 : 1)) : null;

  // Click ticks via a tiny synth.
  const clicks = clickTimesOut(derived, project.cursor.clickSound);
  const playTick = () => {
    const osc = actx.createOscillator();
    const gain = actx.createGain();
    osc.frequency.value = 1800;
    gain.gain.setValueAtTime(0.35 * project.cursor.clickSoundVolume, actx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.03);
    osc.connect(gain).connect(dest);
    osc.start();
    osc.stop(actx.currentTime + 0.04);
  };

  const stream = canvas.captureStream(req.fps);
  for (const track of dest.stream.getAudioTracks()) stream.addTrack(track);
  const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
    ? "video/webm;codecs=vp9,opus"
    : "video/webm";
  const recorder = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: req.bitrate,
  });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const micOffset = (meta.micStartOffsetMs - meta.videoStartOffsetMs) / 1000;
  const sysOffset = (meta.sysStartOffsetMs - meta.videoStartOffsetMs) / 1000;
  const camOffset = (meta.camStartOffsetMs - meta.videoStartOffsetMs) / 1000;
  const inputs: RenderInputs = {
    project,
    meta,
    video,
    camVideo: cam,
    captionChunks: derived.captionChunks,
    stage: derived.stage,
    camera: derived.cameraPath,
    cursor: derived.cursorPath,
    prepped: derived.prepped,
  };

  let cancelled = false;
  webmCancel = () => {
    cancelled = true;
  };
  useStore.getState().setExporting({
    frame: 0,
    total: Math.round(duration * req.fps),
    path: "WebM (saves via download when finished)",
    startedAt: Date.now(),
  });

  recorder.start(500);
  const startWall = performance.now();
  let clickIdx = 0;

  const syncEl = (el: HTMLAudioElement, want: number, speed: number) => {
    const playable = want >= 0 && want < (el.duration || Infinity) && speed === 1;
    if (playable) {
      if (Math.abs(el.currentTime - want) > 0.2) el.currentTime = want;
      if (el.paused) void el.play().catch(() => {});
    } else if (!el.paused) {
      el.pause();
    }
  };

  await new Promise<void>((resolve) => {
    const loop = () => {
      const t = (performance.now() - startWall) / 1000;
      if (cancelled || t >= duration) {
        resolve();
        return;
      }
      const srcT = outToSrc(derived.edl, t);
      const speed = rangeAtOut(derived.edl, t)?.speed ?? 1;
      if (Math.abs(video.currentTime - srcT) > 0.15) video.currentTime = srcT;
      video.playbackRate = Math.min(8, speed);
      if (video.paused) void video.play().catch(() => {});
      if (cam) {
        const camT = srcT - camOffset;
        if (Math.abs(cam.currentTime - camT) > 0.2) cam.currentTime = camT;
        if (cam.paused) void cam.play().catch(() => {});
      }
      if (mic) syncEl(mic.el, srcT - micOffset, speed);
      if (sys) syncEl(sys.el, srcT - sysOffset, speed);
      if (music) syncEl(music.el, t, 1); // music runs on the output timeline
      while (clickIdx < clicks.length && clicks[clickIdx] <= t) {
        playTick();
        clickIdx++;
      }
      renderFrame(ctx, req.width, req.height, srcT, inputs);
      const st = useStore.getState();
      if (st.exporting) st.setExporting({ ...st.exporting, frame: Math.round(t * req.fps) });
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });

  recorder.stop();
  await new Promise<void>((res) => {
    recorder.onstop = () => res();
  });
  video.pause();
  cam?.pause();
  mic?.el.pause();
  sys?.el.pause();
  music?.el.pause();
  void actx.close();
  webmCancel = null;
  useStore.getState().setExporting(null);

  if (cancelled) return false;
  const blob = new Blob(chunks, { type: "video/webm" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${project.name || "recording"}.webm`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
  return true;
}
