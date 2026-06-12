import React, { useLayoutEffect, useRef, useState } from "react";
import { outToSrc, srcToOut } from "../render/edl";
import { getDerived } from "../state/derived";
import { newManualZoom, useStore } from "../state/store";
import type { ZoomSegment } from "../types";
import { Button, formatTime } from "./controls";

const TRACK_H = 34;

/** Generic horizontal drag: converts pointer movement to seconds and brackets the
 * gesture in one undo step. Plain closure (not a hook) so it can be created after
 * data guards. */
function makeDrag(pps: number) {
  return (
    e: React.PointerEvent,
    onMove: (dtSec: number) => void,
    opts?: { history?: boolean },
  ) => {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const history = opts?.history !== false;
    if (history) useStore.getState().beginEdit();
    const move = (ev: PointerEvent) => onMove((ev.clientX - startX) / pps);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (history) useStore.getState().endEdit();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
}

export function Timeline() {
  const project = useStore((s) => s.project);
  const meta = useStore((s) => s.meta);
  const events = useStore((s) => s.events);
  const time = useStore((s) => s.time);
  const setTime = useStore((s) => s.setTime);
  const update = useStore((s) => s.update);
  const selectedZoomId = useStore((s) => s.selectedZoomId);
  const selectZoom = useStore((s) => s.selectZoom);
  const selectedSection = useStore((s) => s.selectedSection);
  const selectSection = useStore((s) => s.selectSection);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [zoomLevel, setZoomLevel] = useState(1);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  if (!project || !meta || !events) return null;
  const d = getDerived(project, meta, events);
  const D = meta.durationSec;
  const pps = Math.max(2, ((width - 32) / Math.max(0.5, D)) * zoomLevel);
  const drag = makeDrag(pps);
  const contentW = D * pps + 32;
  const x = (t: number) => t * pps + 16;
  const tAt = (clientX: number) => {
    const el = scrollRef.current!;
    const rect = el.getBoundingClientRect();
    return Math.min(D, Math.max(0, (clientX - rect.left + el.scrollLeft - 16) / pps));
  };

  const trimStart = project.trim.start;
  const trimEnd = project.trim.end ?? D;
  const playheadSrc = outToSrc(d.edl, time);

  // Sections between split points (§5.2 cut workflow).
  const boundaries = [trimStart, ...project.splits.filter((p) => p > trimStart && p < trimEnd).sort((a, b) => a - b), trimEnd];
  const sections: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    sections.push({ start: boundaries[i], end: boundaries[i + 1] });
  }

  const seekTo = (srcT: number) => setTime(srcToOut(d.edl, srcT));

  const addZoom = () => {
    const seg = newManualZoom(Math.min(playheadSrc, Math.max(0, D - 1)), Math.min(3, D));
    seg.end = Math.min(seg.end, D);
    update((p) => p.zoom.segments.push(seg));
    selectZoom(seg.id);
  };

  const split = () => {
    if (playheadSrc <= trimStart + 0.05 || playheadSrc >= trimEnd - 0.05) return;
    update((p) => {
      p.splits.push(playheadSrc);
      p.splits.sort((a, b) => a - b);
    });
  };

  const ticks: number[] = [];
  const stepCandidates = [0.5, 1, 2, 5, 10, 15, 30, 60, 120];
  const tickStep = stepCandidates.find((s) => s * pps >= 70) ?? 300;
  for (let t = 0; t <= D; t += tickStep) ticks.push(t);

  const zoomBlock = (seg: ZoomSegment) => {
    const selected = seg.id === selectedZoomId;
    const isManual = seg.kind === "manual" || seg.pinned;
    return (
      <div
        key={seg.id}
        onPointerDown={(e) => {
          selectZoom(seg.id);
          const s0 = seg.start;
          const e0 = seg.end;
          drag(e, (dt) => {
            const len = e0 - s0;
            const ns = Math.min(Math.max(0, s0 + dt), D - len);
            update((p) => {
              const z = p.zoom.segments.find((q) => q.id === seg.id);
              if (z) {
                z.start = ns;
                z.end = ns + len;
              }
            }, false);
          });
        }}
        className={`group absolute top-1 flex h-[26px] cursor-grab items-center overflow-hidden rounded-md border px-2 text-[11px] font-medium active:cursor-grabbing ${
          isManual
            ? "border-amber-400/40 bg-amber-400/20 text-amber-200"
            : "border-indigo-400/40 bg-indigo-500/25 text-indigo-200"
        } ${selected ? "ring-2 ring-indigo-300" : ""}`}
        style={{ left: x(seg.start), width: Math.max(10, (seg.end - seg.start) * pps) }}
        title={`${seg.kind}${seg.pinned ? " (pinned)" : ""} — ${seg.zoom.toFixed(2)}×`}
      >
        <span className="pointer-events-none truncate">
          {seg.pinned || seg.kind === "manual" ? "📌 " : ""}{seg.zoom.toFixed(1)}×
        </span>
        {/* trim handles */}
        <div
          className="absolute left-0 top-0 h-full w-1.5 cursor-ew-resize bg-white/0 group-hover:bg-white/30"
          onPointerDown={(e) => {
            selectZoom(seg.id);
            const s0 = seg.start;
            drag(e, (dt) => {
              const ns = Math.min(Math.max(0, s0 + dt), seg.end - 0.3);
              update((p) => {
                const z = p.zoom.segments.find((q) => q.id === seg.id);
                if (z) z.start = ns;
              }, false);
            });
          }}
        />
        <div
          className="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize bg-white/0 group-hover:bg-white/30"
          onPointerDown={(e) => {
            selectZoom(seg.id);
            const e0 = seg.end;
            drag(e, (dt) => {
              const ne = Math.max(seg.start + 0.3, Math.min(D, e0 + dt));
              update((p) => {
                const z = p.zoom.segments.find((q) => q.id === seg.id);
                if (z) z.end = ne;
              }, false);
            });
          }}
        />
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col border-t border-white/5 bg-[#0d1017]">
      {/* Timeline toolbar */}
      <div className="flex items-center gap-2 border-b border-white/5 px-3 py-1.5">
        <Button onClick={split} title="Split at playhead (S)">✂ Split</Button>
        <Button onClick={addZoom} title="Add manual zoom at playhead">＋ Zoom</Button>
        <div className="mx-2 h-4 w-px bg-white/10" />
        <span className="font-mono text-[12px] text-slate-400">
          {formatTime(time)} / {formatTime(d.outputDuration)}
        </span>
        <div className="flex-1" />
        <Button onClick={() => setZoomLevel((z) => Math.max(0.5, z / 1.4))} title="Zoom timeline out">−</Button>
        <Button onClick={() => setZoomLevel(1)} title="Fit">Fit</Button>
        <Button onClick={() => setZoomLevel((z) => Math.min(40, z * 1.4))} title="Zoom timeline in">＋</Button>
      </div>

      {/* Tracks */}
      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-x-auto overflow-y-hidden"
        onPointerDown={(e) => {
          if (e.target !== e.currentTarget && (e.target as HTMLElement).dataset.seek === undefined) return;
          seekTo(tAt(e.clientX));
          drag(e, () => {}, { history: false });
          const move = (ev: PointerEvent) => seekTo(tAt(ev.clientX));
          const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        }}
      >
        <div className="relative" style={{ width: contentW, height: "100%" }}>
          {/* Ruler */}
          <div data-seek className="relative h-6 border-b border-white/5">
            {ticks.map((t) => (
              <div key={t} className="pointer-events-none absolute top-0 h-full" style={{ left: x(t) }}>
                <div className="h-2 w-px bg-white/20" />
                <div className="mt-0.5 text-[10px] text-slate-500">{formatTime(t).replace(/\.\d+$/, "")}</div>
              </div>
            ))}
          </div>

          {/* Video sections */}
          <div className="relative mt-2" style={{ height: TRACK_H }}>
            <div className="absolute left-2 top-1/2 z-10 -translate-y-1/2 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
              Video
            </div>
            {sections.map((sec, i) => {
              const isSel = selectedSection && Math.abs(selectedSection.start - sec.start) < 1e-6 &&
                Math.abs(selectedSection.end - sec.end) < 1e-6;
              const sp = project.speed.find((r) => r.start <= sec.start + 1e-6 && r.end >= sec.end - 1e-6);
              return (
                <div
                  key={i}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    selectSection(sec);
                  }}
                  className={`absolute top-1 h-[26px] cursor-pointer rounded-md border ${
                    isSel
                      ? "border-sky-300 bg-sky-500/30 ring-2 ring-sky-300"
                      : "border-sky-500/30 bg-sky-500/15 hover:bg-sky-500/25"
                  }`}
                  style={{ left: x(sec.start), width: Math.max(6, (sec.end - sec.start) * pps) }}
                >
                  {sp && sp.factor !== 1 && (
                    <span className="absolute left-1 top-1/2 -translate-y-1/2 rounded bg-sky-400/30 px-1 text-[10px] text-sky-100">
                      {sp.factor}×
                    </span>
                  )}
                </div>
              );
            })}
            {/* Cut ranges */}
            {project.cuts.map((c, i) => (
              <div
                key={`cut${i}`}
                className="pointer-events-none absolute top-1 h-[26px] rounded-md bg-black/60"
                style={{
                  left: x(c.start),
                  width: Math.max(2, (c.end - c.start) * pps),
                  backgroundImage:
                    "repeating-linear-gradient(45deg, rgba(255,255,255,0.06) 0 4px, transparent 4px 8px)",
                }}
              />
            ))}
          </div>

          {/* Zoom segments (§4.2 dedicated track) */}
          <div className="relative mt-2" style={{ height: TRACK_H }}>
            <div className="absolute left-2 top-1/2 z-10 -translate-y-1/2 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
              Zoom
            </div>
            <div data-seek className="absolute inset-0" />
            {project.zoom.segments.map(zoomBlock)}
          </div>

          {/* Webcam keyframe markers (§5.4) */}
          {meta.hasWebcam && project.webcam.enabled && (
            <div className="relative mt-2" style={{ height: 18 }}>
              <div className="absolute left-2 top-1/2 z-10 -translate-y-1/2 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                Cam
              </div>
              <div data-seek className="absolute inset-0" />
              {project.webcam.keyframes.map((kf) => (
                <div
                  key={kf.id}
                  title={`${kf.fullscreen ? "Fullscreen" : kf.hidden ? "Hidden" : "Bubble"} — drag to retime`}
                  onPointerDown={(e) => {
                    const t0 = kf.t;
                    drag(e, (dt) => {
                      const nt = Math.min(Math.max(0, t0 + dt), D);
                      update((p) => {
                        const k = p.webcam.keyframes.find((q) => q.id === kf.id);
                        if (k) k.t = nt;
                      }, false);
                    });
                  }}
                  className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 cursor-ew-resize rounded-[2px] border ${
                    kf.fullscreen
                      ? "border-fuchsia-300 bg-fuchsia-500/70"
                      : kf.hidden
                        ? "border-slate-400 bg-slate-600"
                        : "border-fuchsia-400/60 bg-fuchsia-500/35"
                  }`}
                  style={{ left: x(kf.t) }}
                />
              ))}
            </div>
          )}

          {/* Audio indicator tracks */}
          {(meta.hasMic || meta.hasSystemAudio) && (
            <div className="relative mt-2 space-y-1">
              {meta.hasMic && (
                <div
                  className={`mx-0 h-3 rounded-sm ${project.audio.micMuted ? "bg-emerald-500/10" : "bg-emerald-500/25"}`}
                  style={{ marginLeft: x(trimStart), width: (trimEnd - trimStart) * pps }}
                  title="Microphone"
                />
              )}
              {meta.hasSystemAudio && (
                <div
                  className={`h-3 rounded-sm ${project.audio.sysMuted ? "bg-teal-500/10" : "bg-teal-500/25"}`}
                  style={{ marginLeft: x(trimStart), width: (trimEnd - trimStart) * pps }}
                  title="System audio"
                />
              )}
            </div>
          )}

          {/* Trim shading + handles (§5.2) */}
          {trimStart > 0.01 && (
            <div className="pointer-events-none absolute bottom-0 top-6 bg-black/50"
              style={{ left: 0, width: x(trimStart) }} />
          )}
          {trimEnd < D - 0.01 && (
            <div className="pointer-events-none absolute bottom-0 top-6 bg-black/50"
              style={{ left: x(trimEnd), width: contentW - x(trimEnd) }} />
          )}
          <div
            className="absolute bottom-0 top-6 w-1.5 cursor-ew-resize rounded bg-slate-500/70 hover:bg-slate-300"
            style={{ left: x(trimStart) - 3 }}
            onPointerDown={(e) => {
              const t0 = trimStart;
              drag(e, (dt) => {
                const nt = Math.min(Math.max(0, t0 + dt), trimEnd - 0.5);
                update((p) => {
                  p.trim.start = nt;
                }, false);
              });
            }}
            title="Trim start"
          />
          <div
            className="absolute bottom-0 top-6 w-1.5 cursor-ew-resize rounded bg-slate-500/70 hover:bg-slate-300"
            style={{ left: x(trimEnd) - 3 }}
            onPointerDown={(e) => {
              const t0 = trimEnd;
              drag(e, (dt) => {
                const nt = Math.max(Math.min(D, t0 + dt), trimStart + 0.5);
                update((p) => {
                  p.trim.end = nt >= D - 0.01 ? null : nt;
                }, false);
              });
            }}
            title="Trim end"
          />

          {/* Playhead */}
          <div
            className="absolute bottom-0 top-0 z-20 w-px bg-red-400"
            style={{ left: x(playheadSrc) }}
          >
            <div
              className="absolute -left-[5px] top-0 h-3 w-[11px] cursor-ew-resize rounded-b-sm bg-red-400"
              onPointerDown={(e) => {
                drag(e, () => {}, { history: false });
                const move = (ev: PointerEvent) => seekTo(tAt(ev.clientX));
                const up = () => {
                  window.removeEventListener("pointermove", move);
                  window.removeEventListener("pointerup", up);
                };
                window.addEventListener("pointermove", move);
                window.addEventListener("pointerup", up);
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
