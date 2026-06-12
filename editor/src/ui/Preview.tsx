import { useEffect, useRef } from "react";
import { aspectRatio, computeInset, renderFrame } from "../render/compositor";
import { outToSrc, rangeAtOut } from "../render/edl";
import { activeKeyframe, sampleWebcamLayout } from "../render/webcam";
import { getDerived } from "../state/derived";
import { getMedia, initMedia } from "../state/media";
import { useStore } from "../state/store";

function syncTrack(
  el: HTMLAudioElement,
  offset: number,
  srcTime: number,
  playing: boolean,
  speed: number,
  muted: boolean,
  volume: number,
) {
  const want = srcTime - offset;
  const playable = want >= 0 && want < (el.duration || Infinity);
  el.volume = Math.min(1, Math.max(0, volume));
  el.muted = muted || speed !== 1 || !playable;
  if (playing && playable) {
    if (Math.abs(el.currentTime - want) > 0.18) el.currentTime = want;
    el.playbackRate = Math.min(4, Math.max(0.25, speed));
    if (el.paused) void el.play().catch(() => {});
  } else if (!el.paused) {
    el.pause();
  }
}

// Click-sound preview (§4.3): tiny synthesized tick, same character as the export mix.
let tickCtx: AudioContext | null = null;
function playTick(volume: number) {
  tickCtx ??= new AudioContext();
  const osc = tickCtx.createOscillator();
  const gain = tickCtx.createGain();
  osc.frequency.value = 1800;
  gain.gain.setValueAtTime(0.35 * volume, tickCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, tickCtx.currentTime + 0.03);
  osc.connect(gain).connect(tickCtx.destination);
  osc.start();
  osc.stop(tickCtx.currentTime + 0.04);
}

/** Live canvas preview — every displayed frame comes from the shared render core (§5.1). */
export function Preview() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const musicElRef = useRef<HTMLAudioElement | null>(null);
  const musicSrcRef = useRef("");
  const mediaBase = useStore((s) => s.mediaBase);
  const meta = useStore((s) => s.meta);

  useEffect(() => {
    if (mediaBase && meta) initMedia(mediaBase, meta);
  }, [mediaBase, meta]);

  useEffect(() => {
    let raf = 0;
    let lastNow = performance.now();
    let prevSrcTime = -1;
    let lastDraw = { srcTime: -1, project: null as unknown, zoomSel: null as string | null, w: 0, h: 0 };
    let wasSeeking = false;

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = (now - lastNow) / 1000;
      lastNow = now;

      const s = useStore.getState();
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!s.project || !s.meta || !s.events || !canvas || !container) return;
      if (s.exporting) return; // the export loop owns the main thread and the render core
      const d = getDerived(s.project, s.meta, s.events);

      let time = s.time;
      if (s.playing) {
        time = time + dt;
        if (time >= d.outputDuration) {
          time = d.outputDuration;
          s.setPlaying(false);
        }
        s.setTime(time);
      }
      const srcTime = outToSrc(d.edl, Math.min(time, d.outputDuration));
      const speed = rangeAtOut(d.edl, time)?.speed ?? 1;

      // Click-sound preview: fire ticks as playback crosses click times (skip on seeks).
      if (s.playing && s.project.cursor.clickSound &&
          prevSrcTime >= 0 && srcTime > prevSrcTime && srcTime - prevSrcTime < 0.5) {
        for (const click of d.prepped.clicks) {
          if (click.t > prevSrcTime && click.t <= srcTime) {
            playTick(s.project.cursor.clickSoundVolume);
          }
        }
      }
      prevSrcTime = srcTime;

      const media = getMedia();
      if (!media) return;
      const video = media.video;
      if (video.readyState < 2) return;

      // Keep the <video> element tracking the source clock.
      const drift = Math.abs(video.currentTime - srcTime);
      if (s.playing) {
        if (drift > 0.15) video.currentTime = srcTime;
        video.playbackRate = Math.min(8, speed);
        if (video.paused) void video.play().catch(() => {});
      } else {
        if (!video.paused) video.pause();
        if (drift > 0.045 && !video.seeking) video.currentTime = srcTime;
      }
      if (media.mic) {
        syncTrack(media.mic, media.micOffset, srcTime, s.playing, speed,
          s.project.audio.micMuted, s.project.audio.micVolume);
      }
      if (media.sys) {
        syncTrack(media.sys, media.sysOffset, srcTime, s.playing, speed,
          s.project.audio.sysMuted, s.project.audio.sysVolume);
      }
      if (media.cam && s.project.webcam.enabled) {
        const camT = srcTime - media.camOffset;
        const camDrift = Math.abs(media.cam.currentTime - camT);
        if (s.playing) {
          if (camDrift > 0.15) media.cam.currentTime = camT;
          media.cam.playbackRate = Math.min(8, speed);
          if (media.cam.paused) void media.cam.play().catch(() => {});
        } else {
          if (!media.cam.paused) media.cam.pause();
          if (camDrift > 0.045 && !media.cam.seeking) media.cam.currentTime = camT;
        }
      } else if (media.cam && !media.cam.paused) {
        media.cam.pause();
      }

      // Background music runs on the OUTPUT timeline (§5.5). Ducking happens at export;
      // preview plays it at a constant level.
      const musicFile = s.project.audio.musicFile;
      if (musicFile) {
        const src = s.mediaBase + musicFile;
        if (musicSrcRef.current !== src) {
          musicElRef.current?.pause();
          musicElRef.current = new Audio(src);
          musicSrcRef.current = src;
        }
        const music = musicElRef.current!;
        music.volume = Math.min(1, Math.max(0, s.project.audio.musicVolume));
        if (s.playing && time < (music.duration || Infinity)) {
          if (Math.abs(music.currentTime - time) > 0.25) music.currentTime = time;
          if (music.paused) void music.play().catch(() => {});
        } else if (!music.paused) {
          music.pause();
        }
      } else if (musicElRef.current && !musicElRef.current.paused) {
        musicElRef.current.pause();
      }

      // Fit the canvas to the container at the output aspect ratio.
      const ar = aspectRatio(s.project, s.meta);
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      let w = cw;
      let h = w / ar;
      if (h > ch) {
        h = ch;
        w = h * ar;
      }
      const dpr = window.devicePixelRatio || 1;
      const pw = Math.max(2, Math.round(w * dpr));
      const ph = Math.max(2, Math.round(h * dpr));
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;

      // Skip identical paused frames (shadow blur is expensive); redraw around seeks
      // so freshly decoded frames land on the canvas.
      const seekingNow = video.seeking || (media.cam?.seeking ?? false);
      const dirty =
        s.playing || seekingNow || wasSeeking ||
        lastDraw.srcTime !== srcTime || lastDraw.project !== s.project ||
        lastDraw.zoomSel !== s.selectedZoomId || lastDraw.w !== pw || lastDraw.h !== ph;
      wasSeeking = seekingNow;
      if (!dirty) return;
      lastDraw = { srcTime, project: s.project, zoomSel: s.selectedZoomId, w: pw, h: ph };

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      renderFrame(ctx, pw, ph, srcTime, {
        project: s.project,
        meta: s.meta,
        video,
        camVideo: media.cam,
        captionChunks: d.captionChunks,
        stage: d.stage,
        camera: d.cameraPath,
        cursor: d.cursorPath,
        prepped: d.prepped,
      });

      // Selected zoom target indicator.
      const sel = s.selectedZoomId
        ? s.project.zoom.segments.find((z) => z.id === s.selectedZoomId)
        : null;
      if (sel) {
        const inset = computeInset(pw, ph, s.project.style.padding, d.stage);
        const tx = inset.ix + sel.cx * inset.iw;
        const ty = inset.iy + sel.cy * inset.ih;
        ctx.strokeStyle = "rgba(129,140,248,0.9)";
        ctx.lineWidth = 1.5 * dpr;
        ctx.beginPath();
        ctx.arc(tx, ty, 10 * dpr, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(tx - 16 * dpr, ty);
        ctx.lineTo(tx + 16 * dpr, ty);
        ctx.moveTo(tx, ty - 16 * dpr);
        ctx.lineTo(tx, ty + 16 * dpr);
        ctx.stroke();
      }
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Drag the webcam bubble to reposition it (§5.4 custom drag). Updates the keyframe in
  // effect at the playhead, or the base layout if none.
  const draggedWebcam = useRef(false);
  const onPointerDown = (e: React.PointerEvent) => {
    draggedWebcam.current = false;
    const s = useStore.getState();
    const canvas = canvasRef.current;
    const media = getMedia();
    if (!s.project || !s.meta || !s.events || !canvas) return;
    const wc = s.project.webcam;
    if (!wc.enabled || !media?.cam || media.cam.videoWidth === 0) return;

    const d = getDerived(s.project, s.meta, s.events);
    const rect = canvas.getBoundingClientRect();
    const dpr = canvas.width / rect.width;
    const px = (e.clientX - rect.left) * dpr;
    const py = (e.clientY - rect.top) * dpr;
    const srcTime = outToSrc(d.edl, s.time);
    const refScale = Math.min(canvas.width, canvas.height) / 1080;
    const aspect = media.cam.videoWidth / media.cam.videoHeight;
    const layout = sampleWebcamLayout(wc, srcTime, canvas.width, canvas.height, aspect, refScale);
    if (!layout || layout.alpha < 0.05 || layout.w >= canvas.width) return;
    if (px < layout.x || px > layout.x + layout.w || py < layout.y || py > layout.y + layout.h) return;

    draggedWebcam.current = true;
    const kf = activeKeyframe(wc, srcTime);
    const margin = 24 * refScale;
    const spanX = Math.max(1, canvas.width - layout.w - margin * 2);
    const spanY = Math.max(1, canvas.height - layout.h - margin * 2);
    const startNx = kf ? kf.nx : wc.nx;
    const startNy = kf ? kf.ny : wc.ny;
    const startX = e.clientX;
    const startY = e.clientY;
    useStore.getState().beginEdit();
    const move = (ev: PointerEvent) => {
      const dnx = ((ev.clientX - startX) * dpr) / spanX;
      const dny = ((ev.clientY - startY) * dpr) / spanY;
      useStore.getState().update((p) => {
        const target = kf
          ? p.webcam.keyframes.find((k) => k.id === kf.id)
          : null;
        const obj = target ?? p.webcam;
        obj.nx = Math.min(1, Math.max(0, startNx + dnx));
        obj.ny = Math.min(1, Math.max(0, startNy + dny));
      }, false);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      useStore.getState().endEdit();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Click sets the selected zoom segment's target (§4.2 "pick the target on the preview").
  const onClick = (e: React.MouseEvent) => {
    if (draggedWebcam.current) return; // webcam drag, not a target pick
    const s = useStore.getState();
    const canvas = canvasRef.current;
    if (!s.project || !s.meta || !s.events || !canvas || !s.selectedZoomId) return;
    const seg = s.project.zoom.segments.find((z) => z.id === s.selectedZoomId);
    if (!seg) return;
    const d = getDerived(s.project, s.meta, s.events);
    const rect = canvas.getBoundingClientRect();
    const dpr = canvas.width / rect.width;
    const px = (e.clientX - rect.left) * dpr;
    const py = (e.clientY - rect.top) * dpr;
    const inset = computeInset(canvas.width, canvas.height, s.project.style.padding, d.stage);
    const cx = Math.min(1, Math.max(0, (px - inset.ix) / inset.iw));
    const cy = Math.min(1, Math.max(0, (py - inset.iy) / inset.ih));
    s.update((p) => {
      const target = p.zoom.segments.find((z) => z.id === seg.id);
      if (target) {
        target.cx = cx;
        target.cy = cy;
        if (target.kind === "auto") target.pinned = true; // user override → pin (§4.2)
      }
    });
  };

  return (
    <div ref={containerRef} className="relative flex h-full w-full items-center justify-center">
      <canvas
        ref={canvasRef}
        onClick={onClick}
        onPointerDown={onPointerDown}
        className={useStore((s) => (s.selectedZoomId ? "cursor-crosshair" : "cursor-default"))}
      />
    </div>
  );
}
