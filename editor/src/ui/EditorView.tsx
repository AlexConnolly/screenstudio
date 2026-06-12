import { useEffect, useRef } from "react";
import { api } from "../bridge";
import { aspectRatio, renderFrame } from "../render/compositor";
import { outToSrc } from "../render/edl";
import { getDerived } from "../state/derived";
import { getMedia } from "../state/media";
import { useStore } from "../state/store";
import { Button } from "./controls";
import { ExportDialog } from "./ExportDialog";
import { Inspector } from "./Inspector";
import { Preview } from "./Preview";
import { Timeline } from "./Timeline";

export function EditorView() {
  const project = useStore((s) => s.project);
  const meta = useStore((s) => s.meta);
  const playing = useStore((s) => s.playing);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const exportingRef = useRef(false);
  exportingRef.current = !!useStore((s) => s.exporting);

  // Keyboard shortcuts (§5.1, §5.2).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA") return;
      if (exportingRef.current) return;
      const s = useStore.getState();
      if (!s.project || !s.meta || !s.events) return;
      const d = getDerived(s.project, s.meta, s.events);
      const frame = 1 / s.meta.fps;

      if (e.code === "Space") {
        e.preventDefault();
        s.setPlaying(!s.playing && s.time < d.outputDuration - 0.01);
        if (!s.playing && s.time >= d.outputDuration - 0.01) {
          s.setTime(0);
          s.setPlaying(true);
        }
      } else if (e.key === "k" || e.key === "K") {
        s.setPlaying(false);
      } else if (e.key === "j" || e.key === "J") {
        s.setTime(Math.max(0, s.time - 5));
      } else if (e.key === "l" || e.key === "L") {
        s.setTime(Math.min(d.outputDuration, s.time + 5));
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        s.setPlaying(false);
        s.setTime(Math.max(0, s.time - (e.shiftKey ? frame * 10 : frame)));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        s.setPlaying(false);
        s.setTime(Math.min(d.outputDuration, s.time + (e.shiftKey ? frame * 10 : frame)));
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        s.redo();
      } else if (e.key === "s" || e.key === "S") {
        const playheadSrc = outToSrc(d.edl, s.time);
        const trimEnd = s.project.trim.end ?? s.meta.durationSec;
        if (playheadSrc > s.project.trim.start + 0.05 && playheadSrc < trimEnd - 0.05) {
          s.update((p) => {
            p.splits.push(playheadSrc);
            p.splits.sort((a, b) => a - b);
          });
        }
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (s.selectedZoomId) {
          const id = s.selectedZoomId;
          s.update((p) => {
            p.zoom.segments = p.zoom.segments.filter((z) => z.id !== id);
          });
          s.selectZoom(null);
        } else if (s.selectedSection) {
          const sec = s.selectedSection;
          s.update((p) => p.cuts.push({ start: sec.start, end: sec.end }));
          s.selectSection(null);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!project || !meta) return null;

  const exportPng = async () => {
    const s = useStore.getState();
    if (!s.project || !s.meta || !s.events) return;
    const d = getDerived(s.project, s.meta, s.events);
    const media = getMedia();
    if (!media || media.video.readyState < 2) return;
    const canvas = document.createElement("canvas");
    const ar = aspectRatio(s.project, s.meta);
    if (ar >= 1) {
      canvas.height = 1080;
      canvas.width = Math.round(1080 * ar / 2) * 2;
    } else {
      canvas.width = 1080;
      canvas.height = Math.round(1080 / ar / 2) * 2;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    renderFrame(ctx, canvas.width, canvas.height, outToSrc(d.edl, s.time), {
      project: s.project,
      meta: s.meta,
      video: media.video,
      camVideo: media.cam,
      captionChunks: d.captionChunks,
      stage: d.stage,
      camera: d.cameraPath,
      cursor: d.cursorPath,
      prepped: d.prepped,
    });
    await api.savePng(`${s.project.name || "frame"}.png`, canvas.toDataURL("image/png"));
  };

  return (
    <div className="flex h-full flex-col">
      {/* Top bar (§5.1) */}
      <div className="flex items-center gap-2 border-b border-white/5 bg-[#0d1017] px-3 py-2">
        <Button onClick={() => useStore.getState().closeProject()} title="Back to launcher">←</Button>
        <div className="truncate text-[13px] font-medium text-slate-300">{project.name}</div>
        <div className="flex-1" />
        <Button disabled={!canUndo} onClick={() => useStore.getState().undo()} title="Undo (Ctrl+Z)">↩</Button>
        <Button disabled={!canRedo} onClick={() => useStore.getState().redo()} title="Redo (Ctrl+Shift+Z)">↪</Button>
        <div className="mx-1 h-4 w-px bg-white/10" />
        <Button
          onClick={() => useStore.getState().setPlaying(!playing)}
          title="Play/Pause (Space)"
        >
          {playing ? "❚❚" : "▶"}
        </Button>
        <Button onClick={() => void exportPng()} title="Save current frame as PNG">PNG</Button>
        <Button
          variant="primary"
          onClick={() => {
            useStore.getState().setExportDone(null);
            useStore.getState().setExportDialogOpen(true);
          }}
        >
          Export
        </Button>
      </div>

      {/* Canvas + inspector */}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 bg-[#07090d] p-6">
          <Preview />
        </div>
        <Inspector />
      </div>

      {/* Timeline */}
      <div className="h-[210px] shrink-0">
        <Timeline />
      </div>

      <ExportDialog />
    </div>
  );
}
