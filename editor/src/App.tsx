import { useEffect } from "react";
import { hosted, onShellMessage } from "./bridge";
import { Launcher } from "./ui/Launcher";
import { EditorView } from "./ui/EditorView";
import { useStore } from "./state/store";
import { handleNeedFrame, endExport } from "./state/exporter";

export default function App() {
  const view = useStore((s) => s.view);
  const lastError = useStore((s) => s.lastError);
  const recordingState = useStore((s) => s.recordingState);

  useEffect(() => {
    return onShellMessage((m) => {
      const s = useStore.getState();
      switch (m.type) {
        case "recording:state":
          s.setRecordingState(m.state);
          break;
        case "recording:finished":
          s.setRecordingState("idle");
          void s.openProject(m.path);
          break;
        case "recording:error":
          s.setRecordingState("idle");
          s.setError(m.message);
          break;
        case "export:needFrame":
          void handleNeedFrame(m.index);
          break;
        case "export:progress":
          if (s.exporting) s.setExporting({ ...s.exporting, frame: m.frame, total: m.total });
          break;
        case "export:done":
          endExport();
          s.setExporting(null);
          s.setExportDone(m.path);
          s.setError(null);
          s.setExportDialogOpen(true); // dialog shows the "done" state
          break;
        case "export:cancelled":
          endExport();
          s.setExporting(null);
          break;
        case "export:error":
          endExport();
          s.setExporting(null);
          s.setError(`Export failed: ${m.message}`);
          break;
        case "caption:progress":
          s.setCaptionTask({ phase: m.phase, percent: m.percent });
          break;
        case "caption:done":
          s.setCaptionTask(null);
          s.update((p) => {
            p.captions.words = m.words;
            p.captions.enabled = true;
          });
          break;
        case "caption:cancelled":
          s.setCaptionTask(null);
          break;
        case "caption:error":
          s.setCaptionTask(null);
          s.setError(`Captions failed: ${m.message}`);
          break;
      }
    });
  }, []);

  return (
    <div className="flex h-full flex-col">
      {!hosted && (
        <div className="bg-amber-500/15 px-4 py-1.5 text-center text-[12px] text-amber-300">
          Running outside the OpenStudio shell — recording and project access are unavailable.
          Launch <code className="font-mono">OpenStudio.exe</code> for the full app.
        </div>
      )}
      {view === "launcher" ? <Launcher /> : <EditorView />}

      {recordingState === "processing" && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-4 rounded-2xl border border-white/10 bg-[#11141c] px-10 py-8">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-indigo-400 border-t-transparent" />
            <div className="text-sm text-slate-300">Finishing recording — generating zooms…</div>
          </div>
        </div>
      )}

      {lastError && (
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2">
          <div className="flex items-center gap-3 rounded-xl border border-red-500/30 bg-[#1a1114] px-4 py-2.5 text-[13px] text-red-300 shadow-xl">
            <span>{lastError}</span>
            <button
              className="text-red-400 hover:text-red-200"
              onClick={() => useStore.getState().setError(null)}
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
