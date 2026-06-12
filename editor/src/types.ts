// Mirrors the C# models in OpenStudio.Core (camelCase JSON contract).

export interface InputEvent {
  t: number; // ms, video clock (rebased on load)
  k: "move" | "down" | "up" | "wheel" | "key" | "cursor" | string;
  x?: number;
  y?: number;
  b?: number;
  d?: number;
  a?: number;
  vk?: number;
  mods?: string;
  c?: string;
}

export interface ZoomSegment {
  id: string;
  kind: "auto" | "manual";
  pinned: boolean;
  start: number; // seconds, source time
  end: number;
  zoom: number;
  cx: number; // normalized target center in stage space
  cy: number;
  follow: boolean;
  easeIn: number;
  easeOut: number;
}

export interface AutoZoomTunables {
  clusterWindow: number;
  clusterRadiusFrac: number;
  dwell: number;
  defaultZoom: number;
  intensity: number;
  typingMinKeys: number;
  typingWindow: number;
  easeIn: number;
  easeOut: number;
  leadIn: number;
  mergeGap: number;
}

export interface TimeRange {
  start: number;
  end: number;
}

export interface SpeedRange extends TimeRange {
  factor: number;
}

export interface Project {
  version: number;
  name: string;
  zoom: {
    autoEnabled: boolean;
    tunables: AutoZoomTunables;
    segments: ZoomSegment[];
  };
  cuts: TimeRange[];
  splits: number[];
  speed: SpeedRange[];
  trim: { start: number; end: number | null };
  style: StyleConfig;
  cursor: CursorConfig;
  keystrokes: KeystrokeConfig;
  audio: AudioConfig;
  webcam: WebcamConfig;
  captions: CaptionConfig;
}

export interface CaptionConfig {
  enabled: boolean;
  maxWords: number;
  position: "center" | "bottom" | "top";
  uppercase: boolean;
  fontScale: number;
  color: string;
  highlightColor: string;
  outline: boolean;
  pop: boolean;
  words: CaptionWord[];
}

export interface CaptionWord {
  t0: number; // video-clock seconds
  t1: number;
  text: string;
}

export interface WebcamConfig {
  enabled: boolean;
  shape: "circle" | "rounded";
  mirror: boolean;
  /** Bubble height as a fraction of output height. */
  size: number;
  /** Normalized position (0,0 top-left → 1,1 bottom-right). */
  nx: number;
  ny: number;
  borderWidth: number;
  shadow: boolean;
  autoDodge: boolean;
  backdropBlur: boolean;
  keyframes: WebcamKeyframe[];
}

export interface WebcamKeyframe {
  id: string;
  t: number; // source time, seconds
  size: number;
  nx: number;
  ny: number;
  fullscreen: boolean;
  hidden: boolean;
}

export interface StyleConfig {
  padding: number;
  background: {
    type: "solid" | "gradient" | "image";
    color: string;
    from: string;
    to: string;
    angle: number;
    imagePath?: string | null;
    blur: number;
  };
  cornerRadius: number;
  shadow: { size: number; opacity: number; offsetX: number; offsetY: number };
  border: { width: number; color: string; opacity: number };
  aspect: "16:9" | "9:16" | "1:1" | "original";
  crop?: { x: number; y: number; w: number; h: number } | null;
}

export interface CursorConfig {
  smoothing: "off" | "subtle" | "medium" | "strong";
  size: number;
  autoHide: boolean;
  autoHideDelay: number;
  hidden: boolean;
  clickEffects: boolean;
  clickColor: string;
  scaleOnClick: boolean;
  motionBlur: boolean;
  clickSound: boolean;
  clickSoundVolume: number;
}

export interface KeystrokeConfig {
  enabled: boolean;
  mode: "modifiers" | "all";
  position: "bottom" | "top";
  theme: "dark" | "light";
}

export interface AudioConfig {
  micVolume: number;
  micMuted: boolean;
  sysVolume: number;
  sysMuted: boolean;
  normalize: boolean;
  denoise: boolean;
  musicFile?: string | null;
  musicVolume: number;
  duck: boolean;
  duckAmount: number;
}

export interface Meta {
  version: number;
  appVersion: string;
  recordedAtUtc: string;
  durationSec: number;
  width: number;
  height: number;
  scale: number;
  fps: number;
  monitor: {
    deviceName: string;
    x: number;
    y: number;
    width: number;
    height: number;
    refreshRate: number;
    isPrimary: boolean;
  };
  videoStartOffsetMs: number;
  micStartOffsetMs: number;
  sysStartOffsetMs: number;
  camStartOffsetMs: number;
  hasMic: boolean;
  hasSystemAudio: boolean;
  hasWebcam: boolean;
  keyPrivacyMode: string;
}

export interface MonitorInfo {
  deviceName: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isPrimary: boolean;
  scale: number;
  refreshRate: number;
}

export interface MicDevice {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface CameraDevice {
  id: string;
  name: string;
}

export interface WindowInfo {
  hwnd: number;
  title: string;
  processName: string;
  width: number;
  height: number;
}

export interface RegionRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RecentProject {
  path: string;
  name: string;
  durationSec: number;
  recordedAtUtc: string;
  width: number;
  height: number;
}

export interface OpenProjectResult {
  error?: string;
  projectDir: string;
  mediaBase: string;
  project: Project;
  meta: Meta;
}
