// Typed wrapper around the WebView2 host object + message channel.
// In a plain browser (vite dev without the shell) `hosted` is false and the
// launcher shows a hint; the editor itself needs the shell for media access.

import type {
  CameraDevice,
  MicDevice,
  MonitorInfo,
  OpenProjectResult,
  RecentProject,
  RegionRect,
  WindowInfo,
  ZoomSegment,
  AutoZoomTunables,
} from "./types";

type HostBridge = Record<string, (...args: unknown[]) => Promise<unknown>>;

const webview: any = (window as any).chrome?.webview;
export const hosted: boolean = !!webview?.hostObjects?.bridge;
const host: HostBridge | null = hosted ? webview.hostObjects.bridge : null;

async function callJson<T>(method: string, ...args: unknown[]): Promise<T> {
  if (!host) throw new Error("Not running inside the OpenStudio shell");
  const raw = (await host[method](...args)) as string;
  return JSON.parse(raw) as T;
}

async function callVoid(method: string, ...args: unknown[]): Promise<void> {
  if (!host) return;
  await host[method](...args);
}

async function callString(method: string, ...args: unknown[]): Promise<string> {
  if (!host) return "";
  return (await host[method](...args)) as string;
}

export const api = {
  getAppInfo: () => callJson<{ version: string; storageDir: string }>("GetAppInfo"),
  listMonitors: () => callJson<MonitorInfo[]>("ListMonitors"),
  listMicDevices: () => callJson<MicDevice[]>("ListMicDevices"),
  listCameraDevices: () => callJson<CameraDevice[]>("ListCameraDevices"),
  listWindows: () => callJson<WindowInfo[]>("ListWindows"),
  pickRegion: async (monitorDeviceName: string): Promise<RegionRect | null> => {
    const raw = await callString("PickRegion", monitorDeviceName);
    return raw ? (JSON.parse(raw) as RegionRect) : null;
  },
  togglePauseRecording: () => callVoid("TogglePauseRecording"),
  pickMusicFile: (dir: string) => callString("PickMusicFile", dir),
  listStylePresets: () => callJson<string[]>("ListStylePresets"),
  saveStylePreset: (name: string, json: string) => callVoid("SaveStylePreset", name, json),
  loadStylePreset: (name: string) => callString("LoadStylePreset", name),
  deleteStylePreset: (name: string) => callVoid("DeleteStylePreset", name),
  importStylePreset: () => callString("ImportStylePreset"),
  exportStylePreset: (name: string) => callString("ExportStylePreset", name),
  listRecentProjects: () => callJson<RecentProject[]>("ListRecentProjects"),
  browseForProject: () => callString("BrowseForProject"),
  openProject: (path: string) => callJson<OpenProjectResult>("OpenProject", path),
  saveProject: (dir: string, projectJson: string) => callVoid("SaveProject", dir, projectJson),
  regenerateZooms: (dir: string, tunables: AutoZoomTunables, keep: ZoomSegment[]) =>
    callJson<ZoomSegment[] | { error: string }>(
      "RegenerateZooms", dir, JSON.stringify(tunables), JSON.stringify(keep)),
  startRecording: (options: object) => callVoid("StartRecording", JSON.stringify(options)),
  stopRecording: () => callVoid("StopRecording"),
  cancelRecording: () => callVoid("CancelRecording"),
  beginExport: (dir: string, settings: object, suggestedName: string) =>
    callString("BeginExport", dir, JSON.stringify(settings), suggestedName),
  frameReady: () => callVoid("FrameReady"),
  cancelExport: () => callVoid("CancelExport"),
  savePng: (suggestedName: string, dataUrl: string) => callString("SavePng", suggestedName, dataUrl),
  saveText: (suggestedName: string, filter: string, content: string) =>
    callString("SaveText", suggestedName, filter, content),
  openContainingFolder: (path: string) => callVoid("OpenContainingFolder", path),
  getCaptionStatus: () => callJson<{ modelReady: boolean; modelPath: string }>("GetCaptionStatus"),
  generateCaptions: (dir: string) => callVoid("GenerateCaptions", dir),
  cancelCaptions: () => callVoid("CancelCaptions"),
};

export type ShellMessage =
  | { type: "caption:progress"; phase: "downloading" | "transcribing"; percent: number }
  | { type: "caption:done"; words: Array<{ t0: number; t1: number; text: string }> }
  | { type: "caption:cancelled" }
  | { type: "caption:error"; message: string }
  | { type: "recording:state"; state: "idle" | "countdown" | "recording" | "paused" | "processing" }
  | { type: "recording:finished"; path: string }
  | { type: "recording:error"; message: string }
  | { type: "export:needFrame"; index: number; total: number }
  | { type: "export:progress"; frame: number; total: number }
  | { type: "export:done"; path: string }
  | { type: "export:cancelled" }
  | { type: "export:error"; message: string }
  | { type: "export:buffer"; width: number; height: number };

const messageHandlers = new Set<(m: ShellMessage) => void>();
let sharedBuffer: ArrayBuffer | null = null;

if (webview) {
  webview.addEventListener("message", (e: { data: ShellMessage }) => {
    for (const h of messageHandlers) h(e.data);
  });
  webview.addEventListener("sharedbufferreceived", (e: any) => {
    sharedBuffer = e.getBuffer() as ArrayBuffer;
    const extra = e.additionalData as ShellMessage | undefined;
    if (extra) for (const h of messageHandlers) h(extra);
  });
}

export function onShellMessage(handler: (m: ShellMessage) => void): () => void {
  messageHandlers.add(handler);
  return () => messageHandlers.delete(handler);
}

export function getSharedBuffer(): ArrayBuffer | null {
  return sharedBuffer;
}
