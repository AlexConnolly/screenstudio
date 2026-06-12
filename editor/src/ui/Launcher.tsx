import { useEffect, useRef, useState } from "react";
import { api, hosted } from "../bridge";
import { useStore } from "../state/store";
import type { CameraDevice, MicDevice, MonitorInfo, RecentProject, RegionRect, WindowInfo } from "../types";
import { Button, Select, Toggle } from "./controls";

export function Launcher() {
  const openProject = useStore((s) => s.openProject);
  const recordingState = useStore((s) => s.recordingState);

  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [mics, setMics] = useState<MicDevice[]>([]);
  const [cameras, setCameras] = useState<CameraDevice[]>([]);
  const [recents, setRecents] = useState<RecentProject[]>([]);
  const [monitor, setMonitor] = useState<string>("");
  const [sourceType, setSourceType] = useState<"screen" | "window" | "region">("screen");
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [windowHwnd, setWindowHwnd] = useState<string>("");
  const [region, setRegion] = useState<RegionRect | null>(null);
  const [micEnabled, setMicEnabled] = useState(true);
  const [micId, setMicId] = useState<string>("");
  const [camEnabled, setCamEnabled] = useState(false);
  const [camId, setCamId] = useState<string>("");
  const [sysAudio, setSysAudio] = useState(true);
  const [fps, setFps] = useState<"30" | "60">("60");
  const [countdown, setCountdown] = useState<"0" | "3" | "5" | "10">("3");
  const [privacy, setPrivacy] = useState<"modifiers" | "full" | "ticks">("modifiers");

  const previewRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (!hosted) return;
    void api.listMonitors().then((m) => {
      setMonitors(m);
      if (m.length) setMonitor(m[0].deviceName);
    });
    void api.listMicDevices().then((d) => {
      setMics(d);
      if (d.length) setMicId(d[0].id);
      else setMicEnabled(false);
    });
    void api.listCameraDevices().then((d) => {
      setCameras(d);
      if (d.length) {
        setCamId(d[0].id);
        setCamEnabled(true); // a webcam is present — default the talking head on
      }
    });
    void api.listRecentProjects().then(setRecents);
  }, [recordingState]);

  // Live webcam preview bubble (§3.2). The stream is released before recording starts
  // so the native recorder gets exclusive access to the device.
  const camName = cameras.find((c) => c.id === camId)?.name ?? "";
  useEffect(() => {
    let cancelled = false;
    const stop = () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (previewRef.current) previewRef.current.srcObject = null;
    };
    if (!camEnabled || recordingState !== "idle") {
      stop();
      return;
    }
    void (async () => {
      try {
        // Match the C# device by label where possible; fall back to the default camera.
        let constraints: MediaStreamConstraints = { video: true };
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const match = devices.find(
            (d) => d.kind === "videoinput" && camName && d.label && (
              d.label.includes(camName) || camName.includes(d.label)),
          );
          if (match) constraints = { video: { deviceId: { exact: match.deviceId } } };
        } catch { /* keep default */ }
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (previewRef.current) {
          previewRef.current.srcObject = stream;
          void previewRef.current.play().catch(() => {});
        }
      } catch { /* no permission / device busy — just no preview */ }
    })();
    return () => {
      cancelled = true;
      stop();
    };
  }, [camEnabled, camName, recordingState]);

  const refreshWindows = () => {
    void api.listWindows().then((w) => {
      setWindows(w);
      if (w.length && !w.some((q) => String(q.hwnd) === windowHwnd)) setWindowHwnd(String(w[0].hwnd));
    });
  };

  const pickRegion = async () => {
    const r = await api.pickRegion(monitor);
    if (r) setRegion(r);
  };

  const record = () => {
    // Release the preview stream first — the recorder needs the device.
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void api.startRecording({
      sourceType,
      monitorDeviceName: monitor,
      windowHandle: sourceType === "window" ? Number(windowHwnd) : 0,
      region: sourceType === "region" ? region : null,
      captureMic: micEnabled,
      micDeviceId: micId || null,
      captureSystemAudio: sysAudio,
      captureWebcam: camEnabled,
      cameraDeviceId: camId || null,
      fps: parseInt(fps),
      keyPrivacy: privacy,
      countdown: parseInt(countdown),
    });
  };

  const canRecord =
    sourceType === "screen" ||
    (sourceType === "window" && windowHwnd !== "") ||
    (sourceType === "region" && region !== null);

  return (
    <div className="flex h-full items-start justify-center gap-10 overflow-y-auto px-10 py-14">
      {/* Record panel (§3.2 launcher) */}
      <div className="w-[400px] shrink-0 rounded-2xl border border-white/10 bg-[#11141c] p-6 shadow-2xl">
        <div className="mb-1 text-xl font-semibold text-slate-100">OpenStudio</div>
        <div className="mb-6 text-[13px] text-slate-500">
          Record your screen — zooms, cursor smoothing and styling happen automatically.
        </div>

        <div className="space-y-4">
          <div>
            <div className="mb-1.5 text-[12px] font-medium uppercase tracking-wide text-slate-500">
              Source
            </div>
            <div className="mb-2 grid grid-cols-3 gap-1 rounded-lg bg-black/30 p-1">
              {(
                [
                  ["screen", "Screen"],
                  ["window", "Window"],
                  ["region", "Area"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => {
                    setSourceType(id);
                    if (id === "window") refreshWindows();
                  }}
                  className={`rounded-md py-1.5 text-[12px] font-medium transition-colors ${
                    sourceType === id ? "bg-indigo-500 text-white" : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {sourceType !== "window" && (
              <Select
                value={monitor}
                onChange={(m) => {
                  setMonitor(m);
                  setRegion(null);
                }}
                options={monitors.map((m) => ({
                  value: m.deviceName,
                  label: `${m.deviceName.replace("\\\\.\\", "")} — ${m.width}×${m.height}${m.isPrimary ? " (primary)" : ""}`,
                }))}
              />
            )}
            {sourceType === "window" && (
              <div className="flex items-center gap-1.5">
                <div className="min-w-0 flex-1">
                  <Select
                    value={windowHwnd}
                    onChange={setWindowHwnd}
                    options={windows.map((w) => ({
                      value: String(w.hwnd),
                      label: `${w.title} (${w.processName})`,
                    }))}
                  />
                </div>
                <Button onClick={refreshWindows} title="Refresh window list">⟳</Button>
              </div>
            )}
            {sourceType === "region" && (
              <div className="mt-2 flex items-center gap-2">
                <Button onClick={() => void pickRegion()}>
                  {region ? "Reselect area…" : "Select area…"}
                </Button>
                {region && (
                  <span className="font-mono text-[12px] text-slate-400">
                    {region.w}×{region.h}
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="space-y-2 rounded-xl border border-white/5 bg-black/20 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1 space-y-2">
                <Toggle label="Webcam" value={camEnabled} onChange={setCamEnabled} />
                {camEnabled && cameras.length > 0 && (
                  <Select
                    value={camId}
                    onChange={setCamId}
                    options={cameras.map((d) => ({ value: d.id, label: d.name }))}
                  />
                )}
              </div>
              {camEnabled && (
                <video
                  ref={previewRef}
                  muted
                  playsInline
                  className="h-16 w-16 shrink-0 rounded-full border border-white/15 bg-black object-cover [transform:scaleX(-1)]"
                />
              )}
            </div>
            <Toggle label="Microphone" value={micEnabled} onChange={setMicEnabled} />
            {micEnabled && mics.length > 0 && (
              <Select
                value={micId}
                onChange={setMicId}
                options={mics.map((d) => ({ value: d.id, label: d.name }))}
              />
            )}
            <Toggle label="System audio" value={sysAudio} onChange={setSysAudio} />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <div className="mb-1 text-[12px] text-slate-500">FPS</div>
              <Select value={fps} onChange={setFps}
                options={[{ value: "30", label: "30" }, { value: "60", label: "60" }]} />
            </div>
            <div>
              <div className="mb-1 text-[12px] text-slate-500">Countdown</div>
              <Select value={countdown} onChange={setCountdown}
                options={[
                  { value: "0", label: "Off" },
                  { value: "3", label: "3 s" },
                  { value: "5", label: "5 s" },
                  { value: "10", label: "10 s" },
                ]} />
            </div>
            <div>
              <div className="mb-1 text-[12px] text-slate-500">Keys</div>
              <Select value={privacy} onChange={setPrivacy}
                options={[
                  { value: "modifiers", label: "Shortcuts" },
                  { value: "full", label: "All keys" },
                  { value: "ticks", label: "None" },
                ]} />
            </div>
          </div>

          <button
            onClick={record}
            disabled={!hosted || recordingState !== "idle" || !canRecord}
            className="group flex w-full items-center justify-center gap-3 rounded-xl bg-red-500 py-3.5 text-[15px] font-semibold text-white transition-colors hover:bg-red-400 disabled:opacity-40"
          >
            <span className="h-3 w-3 rounded-full bg-white transition-transform group-hover:scale-110" />
            {recordingState === "recording" ? "Recording…" : "Start recording"}
          </button>
          <div className="text-center text-[12px] text-slate-600">
            Ctrl+Shift+R start/stop · Ctrl+Shift+P pause — from anywhere
          </div>
        </div>
      </div>

      {/* Recent projects (§7.1) */}
      <div className="min-w-0 max-w-[640px] flex-1">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-300">Recent projects</div>
          <Button
            onClick={async () => {
              const path = await api.browseForProject();
              if (path) void openProject(path);
            }}
          >
            Open project…
          </Button>
        </div>
        {recents.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/10 p-10 text-center text-[13px] text-slate-600">
            Recordings appear here. Projects are portable folders — copy them anywhere.
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {recents.map((r) => (
              <button
                key={r.path}
                onClick={() => void openProject(r.path)}
                className="rounded-xl border border-white/10 bg-[#11141c] p-4 text-left transition-colors hover:border-indigo-500/50 hover:bg-[#141826]"
              >
                <div className="truncate text-[14px] font-medium text-slate-200">{r.name}</div>
                <div className="mt-1 text-[12px] text-slate-500">
                  {Math.floor(r.durationSec / 60)}:{Math.floor(r.durationSec % 60).toString().padStart(2, "0")}
                  {" · "}{r.width}×{r.height}
                  {r.recordedAtUtc ? ` · ${new Date(r.recordedAtUtc).toLocaleDateString()}` : ""}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
