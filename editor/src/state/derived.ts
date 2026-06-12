// Memoized derived render data. A project edit replaces the project object, so we key
// on object identity; a full recompute (EDL + cursor path + camera path) is a few ms
// even for long recordings, comfortably inside the < 1 s regen budget (§10.3).

import type { InputEvent, Meta, Project } from "../types";
import { buildCameraPath, stageFromProject, type CameraPath, type Stage } from "../render/camera";
import { chunkWords, type CaptionChunk } from "../render/captions";
import { buildCursorPath, type CursorPath } from "../render/cursorPath";
import { buildEdl, outputDuration, type EdlRange } from "../render/edl";
import { prepEvents, type PreppedEvents } from "../render/events";

export interface Derived {
  edl: EdlRange[];
  outputDuration: number;
  stage: Stage;
  prepped: PreppedEvents;
  cursorPath: CursorPath;
  cameraPath: CameraPath;
  captionChunks: CaptionChunk[];
}

let memoKey: { project: Project; meta: Meta; events: InputEvent[] } | null = null;
let memoValue: Derived | null = null;
let cursorMemo: { events: InputEvent[]; smoothing: string; duration: number; value: CursorPath } | null = null;

export function getDerived(project: Project, meta: Meta, events: InputEvent[]): Derived {
  if (
    memoValue &&
    memoKey &&
    memoKey.project === project &&
    memoKey.meta === meta &&
    memoKey.events === events
  ) {
    return memoValue;
  }

  const duration = meta.durationSec;

  // Cursor path only depends on events + smoothing; cache across style/zoom edits.
  if (
    !cursorMemo ||
    cursorMemo.events !== events ||
    cursorMemo.smoothing !== project.cursor.smoothing ||
    cursorMemo.duration !== duration
  ) {
    cursorMemo = {
      events,
      smoothing: project.cursor.smoothing,
      duration,
      value: buildCursorPath(events, duration, project.cursor.smoothing, meta.width / 2, meta.height / 2),
    };
  }

  const stage = stageFromProject(project, meta.width, meta.height);
  const edl = buildEdl(project, duration);
  const derived: Derived = {
    edl,
    outputDuration: outputDuration(edl),
    stage,
    prepped: prepEvents(events, project.keystrokes),
    cursorPath: cursorMemo.value,
    cameraPath: buildCameraPath(project, duration, stage, cursorMemo.value),
    captionChunks: chunkWords(project.captions?.words ?? [], project.captions?.maxWords ?? 3),
  };
  memoKey = { project, meta, events };
  memoValue = derived;
  return derived;
}
