// Singleton media elements for playback (screen video + audio tracks) and a separate
// video element for export so an export never fights the preview over seek position.

import type { Meta } from "../types";

export interface MediaSet {
  video: HTMLVideoElement;
  cam: HTMLVideoElement | null;
  mic: HTMLAudioElement | null;
  sys: HTMLAudioElement | null;
  micOffset: number; // seconds: wav position = srcTime - offset
  sysOffset: number;
  camOffset: number;
}

let current: MediaSet | null = null;
let exportVideo: HTMLVideoElement | null = null;
let exportCam: HTMLVideoElement | null = null;

export function initMedia(mediaBase: string, meta: Meta): MediaSet {
  disposeMedia();
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.src = mediaBase + "screen.mp4";
  video.preload = "auto";
  video.muted = true;

  let mic: HTMLAudioElement | null = null;
  let sys: HTMLAudioElement | null = null;
  let cam: HTMLVideoElement | null = null;
  if (meta.hasMic) {
    mic = new Audio(mediaBase + "mic.wav");
    mic.preload = "auto";
  }
  if (meta.hasSystemAudio) {
    sys = new Audio(mediaBase + "sys.wav");
    sys.preload = "auto";
  }
  if (meta.hasWebcam) {
    cam = document.createElement("video");
    cam.crossOrigin = "anonymous";
    cam.src = mediaBase + "camera.mp4";
    cam.preload = "auto";
    cam.muted = true;
  }
  current = {
    video,
    cam,
    mic,
    sys,
    micOffset: (meta.micStartOffsetMs - meta.videoStartOffsetMs) / 1000,
    sysOffset: (meta.sysStartOffsetMs - meta.videoStartOffsetMs) / 1000,
    camOffset: (meta.camStartOffsetMs - meta.videoStartOffsetMs) / 1000,
  };
  return current;
}

export function getMedia(): MediaSet | null {
  return current;
}

export function disposeMedia(): void {
  if (current) {
    current.video.src = "";
    if (current.cam) current.cam.src = "";
    current.mic?.pause();
    current.sys?.pause();
    current = null;
  }
  if (exportVideo) {
    exportVideo.src = "";
    exportVideo = null;
  }
  if (exportCam) {
    exportCam.src = "";
    exportCam = null;
  }
}

async function loadExportElement(src: string): Promise<HTMLVideoElement> {
  const v = document.createElement("video");
  v.crossOrigin = "anonymous";
  v.src = src;
  v.preload = "auto";
  v.muted = true;
  await new Promise<void>((resolve, reject) => {
    v.onloadeddata = () => resolve();
    v.onerror = () => reject(new Error(`Failed to load ${src} for export`));
  });
  return v;
}

export async function getExportVideo(mediaBase: string): Promise<HTMLVideoElement> {
  if (exportVideo && exportVideo.dataset.base === mediaBase) return exportVideo;
  exportVideo = await loadExportElement(mediaBase + "screen.mp4");
  exportVideo.dataset.base = mediaBase;
  return exportVideo;
}

export async function getExportCam(mediaBase: string): Promise<HTMLVideoElement | null> {
  if (exportCam && exportCam.dataset.base === mediaBase) return exportCam;
  try {
    exportCam = await loadExportElement(mediaBase + "camera.mp4");
    exportCam.dataset.base = mediaBase;
    return exportCam;
  } catch {
    return null;
  }
}

export function seekVideo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    const target = Math.max(0, Math.min(t, (video.duration || t) - 0.001));
    if (Math.abs(video.currentTime - target) < 0.001 && video.readyState >= 2) {
      resolve();
      return;
    }
    const done = () => {
      video.removeEventListener("seeked", done);
      resolve();
    };
    video.addEventListener("seeked", done);
    video.currentTime = target;
  });
}
