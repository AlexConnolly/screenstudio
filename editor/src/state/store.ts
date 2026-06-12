import { create } from "zustand";
import { api } from "../bridge";
import type { InputEvent, Meta, Project, ZoomSegment } from "../types";

export type RecordingState = "idle" | "countdown" | "recording" | "paused" | "processing";

export interface ExportProgress {
  frame: number;
  total: number;
  path: string;
  startedAt: number;
}

interface AppState {
  view: "launcher" | "editor";
  appVersion: string;
  projectDir: string | null;
  project: Project | null;
  meta: Meta | null;
  events: InputEvent[] | null;
  mediaBase: string;
  recordingState: RecordingState;
  lastError: string | null;
  exporting: ExportProgress | null;
  exportDialogOpen: boolean;
  exportDone: string | null;
  captionTask: { phase: "downloading" | "transcribing"; percent: number } | null;

  playing: boolean;
  /** Output time (gaps closed, speed applied), seconds. */
  time: number;
  selectedZoomId: string | null;
  selectedSection: { start: number; end: number } | null;
  inspectorTab: "zoom" | "style" | "cursor" | "webcam" | "captions" | "audio" | "keys";

  past: string[];
  future: string[];
  editing: boolean;

  setView(view: "launcher" | "editor"): void;
  openProject(path: string): Promise<void>;
  closeProject(): void;
  update(mutator: (p: Project) => void, commit?: boolean): void;
  beginEdit(): void;
  endEdit(): void;
  undo(): void;
  redo(): void;
  setTime(t: number): void;
  setPlaying(playing: boolean): void;
  selectZoom(id: string | null): void;
  selectSection(s: { start: number; end: number } | null): void;
  setInspectorTab(tab: AppState["inspectorTab"]): void;
  setRecordingState(s: RecordingState): void;
  setError(message: string | null): void;
  setExporting(e: ExportProgress | null): void;
  setExportDialogOpen(open: boolean): void;
  setExportDone(path: string | null): void;
  setCaptionTask(task: AppState["captionTask"]): void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave(get: () => AppState) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const { projectDir, project } = get();
    if (projectDir && project) {
      void api.saveProject(projectDir, JSON.stringify(project));
    }
  }, 700);
}

export const useStore = create<AppState>((set, get) => ({
  view: "launcher",
  appVersion: "",
  projectDir: null,
  project: null,
  meta: null,
  events: null,
  mediaBase: "",
  recordingState: "idle",
  lastError: null,
  exporting: null,
  exportDialogOpen: false,
  exportDone: null,
  captionTask: null,
  playing: false,
  time: 0,
  selectedZoomId: null,
  selectedSection: null,
  inspectorTab: "zoom",
  past: [],
  future: [],
  editing: false,

  setView: (view) => set({ view }),

  openProject: async (path: string) => {
    try {
      const res = await api.openProject(path);
      if (res.error) {
        set({ lastError: res.error });
        return;
      }
      // events.jsonl is served from the project folder; rebase onto the video clock.
      const text = await fetch(res.mediaBase + "events.jsonl").then((r) =>
        r.ok ? r.text() : "",
      );
      const events: InputEvent[] = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line) as InputEvent;
          ev.t -= res.meta.videoStartOffsetMs;
          if (ev.t >= 0) events.push(ev);
        } catch {
          /* torn line */
        }
      }
      set({
        view: "editor",
        projectDir: res.projectDir,
        project: res.project,
        meta: res.meta,
        events,
        mediaBase: res.mediaBase,
        time: 0,
        playing: false,
        selectedZoomId: null,
        selectedSection: null,
        past: [],
        future: [],
        lastError: null,
      });
    } catch (e) {
      set({ lastError: String(e) });
    }
  },

  closeProject: () =>
    set({
      view: "launcher",
      projectDir: null,
      project: null,
      meta: null,
      events: null,
      playing: false,
      time: 0,
      past: [],
      future: [],
    }),

  update: (mutator, commit = true) => {
    const { project, editing, past } = get();
    if (!project) return;
    const next = structuredClone(project);
    mutator(next);
    if (commit && !editing) {
      set({ past: [...past.slice(-199), JSON.stringify(project)], future: [], project: next });
    } else {
      set({ project: next });
    }
    scheduleSave(get);
  },

  // Sliders push one undo snapshot at drag start, then stream uncommitted updates.
  beginEdit: () => {
    const { project, past, editing } = get();
    if (!project || editing) return;
    set({ editing: true, past: [...past.slice(-199), JSON.stringify(project)], future: [] });
  },
  endEdit: () => set({ editing: false }),

  undo: () => {
    const { past, future, project } = get();
    if (past.length === 0 || !project) return;
    const prev = past[past.length - 1];
    set({
      project: JSON.parse(prev),
      past: past.slice(0, -1),
      future: [...future, JSON.stringify(project)],
    });
    scheduleSave(get);
  },

  redo: () => {
    const { past, future, project } = get();
    if (future.length === 0 || !project) return;
    const next = future[future.length - 1];
    set({
      project: JSON.parse(next),
      future: future.slice(0, -1),
      past: [...past, JSON.stringify(project)],
    });
    scheduleSave(get);
  },

  setTime: (t) => set({ time: Math.max(0, t) }),
  setPlaying: (playing) => set({ playing }),
  selectZoom: (id) => set({ selectedZoomId: id, selectedSection: null }),
  selectSection: (s) => set({ selectedSection: s, selectedZoomId: null }),
  setInspectorTab: (inspectorTab) => set({ inspectorTab }),
  setRecordingState: (recordingState) => set({ recordingState }),
  setError: (lastError) => set({ lastError }),
  setExporting: (exporting) => set({ exporting }),
  setExportDialogOpen: (exportDialogOpen) => set({ exportDialogOpen }),
  setExportDone: (exportDone) => set({ exportDone }),
  setCaptionTask: (captionTask) => set({ captionTask }),
}));

export function newManualZoom(at: number, duration = 3): ZoomSegment {
  return {
    id: Math.random().toString(36).slice(2, 10),
    kind: "manual",
    pinned: false,
    start: at,
    end: at + duration,
    zoom: 2,
    cx: 0.5,
    cy: 0.5,
    follow: true,
    easeIn: 1.0,
    easeOut: 1.2,
  };
}
