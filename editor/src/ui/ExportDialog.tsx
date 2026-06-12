import { useMemo, useState } from "react";
import { api } from "../bridge";
import { aspectRatio } from "../render/compositor";
import { getDerived } from "../state/derived";
import { cancelWebmExport, startExport, startWebmExport } from "../state/exporter";
import { useStore } from "../state/store";
import { Button, Row, Select } from "./controls";

interface Preset {
  id: string;
  label: string;
  size: number; // min dimension
  fps: number;
  bitrate: number;
  codec: "h264" | "hevc";
}

const PRESETS: Preset[] = [
  { id: "web", label: "Web (1080p balanced)", size: 1080, fps: 60, bitrate: 12_000_000, codec: "h264" },
  { id: "social", label: "Social (1080p, 30 fps)", size: 1080, fps: 30, bitrate: 10_000_000, codec: "h264" },
  { id: "4k", label: "4K master", size: 2160, fps: 60, bitrate: 45_000_000, codec: "h264" },
  { id: "handoff", label: "Editing handoff (high bitrate)", size: 1080, fps: 60, bitrate: 60_000_000, codec: "h264" },
];

function even(n: number): number {
  return Math.round(n / 2) * 2;
}

export function ExportDialog() {
  const open = useStore((s) => s.exportDialogOpen);
  const setOpen = useStore((s) => s.setExportDialogOpen);
  const exporting = useStore((s) => s.exporting);
  const setExporting = useStore((s) => s.setExporting);
  const project = useStore((s) => s.project);
  const meta = useStore((s) => s.meta);
  const events = useStore((s) => s.events);

  const [presetId, setPresetId] = useState("web");
  const [format, setFormat] = useState<"mp4" | "gif" | "webm">("mp4");
  const [size, setSize] = useState("1080");
  const [gifSize, setGifSize] = useState("480");
  const [gifFps, setGifFps] = useState("15");
  const [fps, setFps] = useState("60");
  const [codec, setCodec] = useState<"h264" | "hevc">("h264");
  const [webmDone, setWebmDone] = useState(false);
  const donePath = useStore((s) => s.exportDone);
  const setDonePath = useStore((s) => s.setExportDone);

  const dims = useMemo(() => {
    if (!project || !meta) return { w: 1920, h: 1080 };
    const ar = aspectRatio(project, meta);
    const s = parseInt(format === "gif" ? gifSize : size);
    return ar >= 1
      ? { w: even(s * ar), h: even(s) }
      : { w: even(s), h: even(s / ar) };
  }, [project, meta, size, gifSize, format]);

  if (!open || !project || !meta || !events) return null;
  const d = getDerived(project, meta, events);
  const capFps = Math.min(parseInt(fps), meta.fps); // capped at capture fps (§6)

  const applyPreset = (id: string) => {
    setPresetId(id);
    const p = PRESETS.find((q) => q.id === id);
    if (p) {
      setSize(String(p.size));
      setFps(String(p.fps));
      setCodec(p.codec);
    }
  };

  const begin = async () => {
    setDonePath(null);
    setWebmDone(false);
    const preset = PRESETS.find((q) => q.id === presetId)!;
    if (format === "webm") {
      const ok = await startWebmExport({
        width: dims.w,
        height: dims.h,
        fps: capFps,
        bitrate: preset.bitrate,
      });
      if (ok) setWebmDone(true);
      return;
    }
    const exportFps = format === "gif" ? parseInt(gifFps) : capFps;
    const path = await startExport({
      format,
      width: dims.w,
      height: dims.h,
      fps: exportFps,
      bitrate: preset.bitrate,
      codec,
    });
    if (path) {
      setExporting({ frame: 0, total: Math.round(d.outputDuration * exportFps), path, startedAt: Date.now() });
    }
  };

  const cancel = () => {
    if (format === "webm") cancelWebmExport();
    else void api.cancelExport();
  };

  const eta = (() => {
    if (!exporting || exporting.frame < 5) return null;
    const elapsed = (Date.now() - exporting.startedAt) / 1000;
    const remaining = (elapsed / exporting.frame) * (exporting.total - exporting.frame);
    return remaining > 60 ? `${Math.ceil(remaining / 60)} min` : `${Math.ceil(remaining)} s`;
  })();

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/60 backdrop-blur-sm">
      <div className="w-[420px] rounded-2xl border border-white/10 bg-[#11141c] p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <div className="text-lg font-semibold text-slate-100">Export</div>
          {!exporting && (
            <button className="text-slate-500 hover:text-slate-200" onClick={() => setOpen(false)}>✕</button>
          )}
        </div>

        {exporting ? (
          <div className="space-y-4">
            <div className="text-[13px] text-slate-400">
              Rendering {exporting.frame} / {exporting.total} frames{eta ? ` — about ${eta} left` : ""}
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-indigo-500 transition-all"
                style={{ width: `${(exporting.frame / Math.max(1, exporting.total)) * 100}%` }}
              />
            </div>
            <div className="truncate text-[12px] text-slate-600">{exporting.path}</div>
            <Button variant="danger" onClick={cancel}>Cancel export</Button>
          </div>
        ) : (
          <div className="space-y-3">
            <Select label="Format" value={format}
              options={[
                { value: "mp4", label: "MP4 (H.264/H.265)" },
                { value: "gif", label: "GIF (loop)" },
                { value: "webm", label: "WebM (VP9)" },
              ]}
              onChange={setFormat} />
            {format !== "gif" && (
              <>
                <Select label="Preset" value={presetId}
                  options={PRESETS.map((p) => ({ value: p.id, label: p.label }))}
                  onChange={applyPreset} />
                <Select label="Resolution" value={size}
                  options={[
                    { value: "720", label: "720p" },
                    { value: "1080", label: "1080p" },
                    { value: "1440", label: "1440p" },
                    { value: "2160", label: "4K" },
                  ]}
                  onChange={setSize} />
                <Select label="Frame rate" value={fps}
                  options={["24", "30", "60"].map((f) => ({ value: f, label: `${Math.min(parseInt(f), meta.fps)} fps` }))}
                  onChange={setFps} />
              </>
            )}
            {format === "mp4" && (
              <Select label="Codec" value={codec}
                options={[
                  { value: "h264", label: "H.264 (compatible)" },
                  { value: "hevc", label: "H.265 (smaller)" },
                ]}
                onChange={setCodec} />
            )}
            {format === "gif" && (
              <>
                <Select label="Size" value={gifSize}
                  options={[
                    { value: "360", label: "Small (360p)" },
                    { value: "480", label: "Medium (480p)" },
                    { value: "720", label: "Large (720p)" },
                  ]}
                  onChange={setGifSize} />
                <Select label="Frame rate" value={gifFps}
                  options={[
                    { value: "10", label: "10 fps" },
                    { value: "15", label: "15 fps" },
                    { value: "20", label: "20 fps" },
                  ]}
                  onChange={setGifFps} />
              </>
            )}
            {format === "webm" && (
              <div className="rounded-lg border border-white/10 bg-black/20 p-2.5 text-[11px] leading-relaxed text-slate-500">
                WebM renders in real time (export takes as long as the video) and saves
                through the download bar when finished.
              </div>
            )}
            <Row label="Output">
              <span className="font-mono text-[12px] text-slate-400">
                {dims.w}×{dims.h} · {Math.round(d.outputDuration)}s
              </span>
            </Row>

            {donePath && (
              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3 text-[12px] text-emerald-300">
                Exported to {donePath}
                <button
                  className="ml-2 underline hover:text-emerald-100"
                  onClick={() => void api.openContainingFolder(donePath)}
                >
                  Open folder
                </button>
              </div>
            )}
            {webmDone && (
              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3 text-[12px] text-emerald-300">
                WebM saved via the download bar.
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button onClick={() => setOpen(false)}>Close</Button>
              <Button variant="primary" onClick={() => void begin()}>
                Export {format.toUpperCase()}…
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
