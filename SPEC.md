# OpenStudio — Self-Hosted Screen Studio Clone — Full Specification

A self-hosted screen recorder + editor that reproduces the Screen Studio experience: record screen/webcam/mic, then automatically produce a polished video with smooth auto-zooms that follow clicks and typing, cursor smoothing, backdrops/insets, and clean modern transitions.

Status: **draft for review** — work through the checkboxes, strike anything out of scope, then we build.

---

## 1. Goals & Non-Goals

### Goals
- [ ] Feature parity with Screen Studio's core loop: **record → auto-polish → light edit → export**.
- [ ] The signature behavior must feel identical: zoom-in on click/typing, smooth pan following the cursor, gentle zoom-out on inactivity. This is the product; everything else supports it.
- [ ] Fully self-hosted / offline. No accounts, no cloud, no telemetry. All processing on-device.
- [ ] Non-destructive editing — original recording is never modified; all effects are re-rendered at export.
- [ ] Windows first (we're on Windows; Screen Studio is macOS-only, so this is also a gap in the market).

### Non-Goals (v1)
- macOS/Linux support (architecture shouldn't preclude it, but don't build it).
- iOS device recording via USB (Screen Studio has it; skip).
- Shareable cloud links (self-hosted means export to file; an optional local share server is a stretch goal).
- Multi-track general-purpose video editing (we are not building Premiere).
- Live streaming.

---

## 2. Platform Decision: Web vs. Native

### Why pure web doesn't work
The auto-zoom engine needs three global inputs while recording: **cursor position (~60–120 Hz), mouse clicks/wheel, and keystrokes — across the whole desktop, outside the browser**. The browser sandbox blocks all three:

- `getDisplayMedia` captures pixels only. Cursor coordinates are not exposed.
- The W3C **Captured Mouse Events** proposal (`CaptureController.oncapturedmousechange`) would expose cursor position over a captured surface — but as of mid-2026 it has **not shipped** in any browser, and even if it had, it exposes *position only*: no global clicks, no keystrokes. Auto-zoom triggers are exactly clicks and keystrokes, so the proposal wouldn't be enough anyway.
- Computer-vision cursor detection from captured frames is fragile, expensive, and still gives no click/key events.
- A browser-extension approach (like Cursorful) only sees events inside browser tabs — useless for recording desktop apps.

### Chosen architecture: native capture + web-tech editor (hybrid)
Split the app along the actual constraint:

1. **Recorder** — small native Windows component (C#) that owns everything the browser can't do: screen capture, audio capture, global input hooks. Output: video files + a timestamped input-events log.
2. **Editor** — web-tech UI (the "web based" experience you wanted) that operates purely on recorded files. It needs zero OS hooks, so it can be HTML/Canvas/WebGL — fast to build beautiful UI in, and the preview compositor is just a render function over (frames, events, settings).

Two acceptable packagings — pick one:

| Option | Stack | Pros | Cons |
|---|---|---|---|
| **A. Single desktop app (recommended)** | C# recorder core + editor UI in WebView2 (or the whole app in Electron/Tauri with a C#/Rust capture sidecar) | One installer, one process model, editor talks to local files directly, FFmpeg bundled | Not reachable from another machine's browser |
| B. Tray recorder + localhost web editor | C# tray app that records; serves the editor at `http://localhost:port` | Editor usable from any browser; closest to "self-hosted web app" | Two moving parts; upload/locate project friction; export server-side anyway |

**Recommendation: Option A** with **WebView2 hosting the editor UI inside a C# (WinUI 3 or WPF) shell**. We get C# where it's mandatory, web tech where it's pleasant, one artifact, and the editor code is portable to Option B later if we want it.

### Core native dependencies
- **Screen capture:** `Windows.Graphics.Capture` API (per-monitor/per-window, GPU-side, excludes cursor on request — critical, see §4.3).
- **Input hooks:** `SetWindowsHookEx` with `WH_MOUSE_LL` + `WH_KEYBOARD_LL` (global low-level hooks; record positions/clicks/keys with QPC timestamps).
- **Audio:** WASAPI — mic capture + loopback capture for system audio (per-app loopback via `AudioClient` process-loopback on Win10 2004+).
- **Webcam:** Media Foundation (`MediaCapture`).
- **Encode/decode/export:** bundled **FFmpeg** (invoked as process or via FFmpeg.AutoGen); NVENC/AMF/QSV hardware encode when available, x264 fallback.
- **Preview/export compositor:** one shared render core (see §7.4) so preview === export, pixel for pixel.

---

## 3. Recording — Feature Spec

### 3.1 Capture sources
- [ ] **Full screen** capture (per monitor, with monitor picker on multi-display setups).
- [ ] **Single window** capture (window stays captured when moved/occluded; record its bounds over time).
- [ ] **Custom region** capture (drag-select rectangle, with magnetic snapping to window edges; movable/resizable before recording starts).
- [ ] **Webcam** simultaneously (device picker, resolution picker; recorded as a *separate* video track, never burned in).
- [ ] **Microphone** (device picker, input level meter visible before recording).
- [ ] **System audio** via WASAPI loopback — [ ] all apps, or [ ] only selected app(s) (process loopback).
- [ ] Any combination of the above, including webcam-only ("talking head") mode.

### 3.2 Recording controls & UX
- [ ] Launcher panel (compact, Screen-Studio-like): source picker (screen/window/area), webcam toggle+preview bubble, mic toggle+meter, system-audio toggle, Record button.
- [ ] **Countdown** (default 3 s, configurable 0–10) before capture starts.
- [ ] Global hotkeys: start/stop (default `Ctrl+Shift+R`), pause/resume, cancel. Configurable.
- [ ] While recording: minimal indicator (tray icon + small floating timer pill that is **excluded from capture**), stop via hotkey, tray, or pill.
- [ ] **Pause/resume** mid-recording (output is a single continuous timeline; pauses become hard cuts).
- [ ] "Restart recording" and "Cancel (discard)" actions.
- [ ] Optional: **hide desktop icons** and **mute notifications** (enable Windows Focus Assist) for the duration of the recording; restore after.
- [ ] On stop: editor opens immediately with the project, auto-zooms already generated.

### 3.3 Capture quality
- [ ] Capture at native resolution and **60 fps** target (configurable 30/60).
- [ ] Record screen with **lossless or near-lossless intermediate** (e.g., H.264 CRF ≤ 16 high-bitrate, or HEVC) — we re-encode at export, so the intermediate must survive a second compression and heavy zooming (zooming magnifies compression artifacts; this matters).
- [ ] HiDPI/display-scale aware: store the monitor's scale factor and true pixel dimensions; cursor coordinates recorded in the same space as pixels.
- [ ] Webcam recorded at its native fps/resolution into its own file.
- [ ] Audio: 48 kHz, mic and system audio as **separate tracks** (independent volume/mute in editor).
- [ ] All tracks share one master clock (QPC); recorded start offsets stored so editor can align tracks within ±1 frame.

### 3.4 Input event log (the secret sauce input)
Recorded continuously alongside video into `events.jsonl`:
- [ ] Mouse position samples at ≥ 60 Hz (timestamp, x, y in capture-space pixels).
- [ ] Mouse down/up per button (timestamp, button, x, y).
- [ ] Mouse wheel (timestamp, delta, x, y).
- [ ] Key down/up (timestamp, virtual key, modifiers). **Privacy:** store the key identity only for the keystroke-overlay feature; setting to record keys as anonymized "typing tick" events only.
- [ ] Cursor *type* changes (arrow/I-beam/hand/resize…) so the synthetic cursor can match (`WH_MOUSE_LL` + polling `GetCursorInfo`).
- [ ] Captured-window bounds over time (for window mode).
- [ ] Display metadata snapshot (bounds, scale, refresh rate).

---

## 4. The Signature Behavior — Zoom & Cursor Engine

This section is the heart of the product. Everything here is computed in the editor from `events.jsonl` and is fully recomputable when settings change.

### 4.1 Auto-zoom generation
- [ ] After recording, automatically generate **zoom segments** on the timeline:
  - **Click trigger:** a mouse click creates a zoom-in centered near the click point.
  - **Click clustering:** clicks close in time *and* space merge into one sustained zoom segment rather than zoom-thrash. (Tunables: cluster window ≈ 2–4 s, spatial radius ≈ 25 % of frame.)
  - **Typing trigger:** sustained keystrokes (> ~3 keys within 1 s) create a zoom on the caret area — approximated by the last click position / focused region, since we can't see the caret. Holds while typing continues.
  - **Zoom-out trigger:** no clicks/typing for a dwell period (default ≈ 2.5 s, tunable) → smooth zoom-out to full frame.
  - **Scroll handling:** scrolling inside a zoom keeps the zoom but pans gently; scroll while un-zoomed does not trigger a zoom (configurable).
- [ ] **Zoom levels:** default ≈ 1.75×; per-segment override (e.g., 1.25×–4×). Global "intensity" setting (subtle / medium / strong) rescales all auto zooms.
- [ ] **Follow-cursor pan while zoomed:** the virtual camera tracks the cursor with a **dead-zone** (cursor moves freely in the middle ~40 % of the zoomed viewport; camera pans only when cursor approaches the edge), critically damped so the camera never overshoots or jitters.
- [ ] **Clamping:** the zoom viewport never shows outside the recording bounds; centers near edges are clamped.
- [ ] **Easing:** zoom in/out and pans use smooth spring or ease-in-out curves (default ≈ 0.8–1.2 s in, ≈ 1.0–1.4 s out; both tunable). No linear lerps anywhere. Transitions between two overlapping zoom targets blend without returning to full frame first.
- [ ] **Auto-zoom can be regenerated** at any time with new tunables without touching manual edits (manual segments are pinned).

### 4.2 Manual zoom editing
- [ ] Zoom segments appear as blocks on a dedicated timeline track.
- [ ] Add a manual zoom: drag on the timeline → pick the target by dragging a rectangle (or point + zoom level) on the preview.
- [ ] Move/resize (trim) segments by dragging; delete; duplicate.
- [ ] Per-segment properties: zoom level, target point, follow-cursor on/off, easing duration in/out.
- [ ] Delete an auto segment, or convert auto → manual (pin it).
- [ ] "Disable all auto-zoom" master toggle.

### 4.3 Cursor rendering & smoothing (record raw, render synthetic)
The screen is captured **without** the OS cursor; the cursor in the final video is **drawn by us** from the event log. This single decision enables everything below.
- [ ] Re-render cursor from logged positions using high-resolution vector/PNG cursor sprites matching Windows cursor types (arrow, I-beam, hand, resize…).
- [ ] **Smoothing:** raw positions filtered (low-pass / spline, e.g., Catmull-Rom over downsampled keypoints or One-Euro filter) so movement becomes a smooth glide. Strength: off / subtle / medium / strong (Screen Studio default ≈ medium).
- [ ] **Cursor size:** adjustable in post (0.5×–4×), animates smoothly if keyframed.
- [ ] **Auto-hide static cursor:** cursor fades out after N s without movement, fades back in on movement (toggle + delay setting).
- [ ] **Hide cursor entirely** toggle.
- [ ] **Click effects:** animated ripple/circle pulse on click (style, color, size configurable); optional **click sound** (subtle, volume control) mixed at export.
- [ ] **Cursor scale-on-click:** brief squish/scale animation on press (toggle).
- [ ] Optional **motion blur** on fast cursor movement and on camera pans/zooms (Screen Studio's "natural movement" feel).
- [ ] **Loop cursor position** (stretch): for seamless social loops, end cursor position eases back to start.

### 4.4 Keystroke overlay
- [ ] Optional overlay showing pressed keys/shortcuts (e.g., `Ctrl + Shift + P`) as a clean pill at the bottom of the frame.
- [ ] Shows only modifier-combos by default (avoid leaking typed text); "show all keys" opt-in.
- [ ] Appearance: position, size, theme (dark/light), fade in/out animation.
- [ ] Per-recording toggle + global default.

---

## 5. Editor — Feature Spec

### 5.1 Layout
- [ ] Single-window editor: large **canvas preview** center, **inspector panel** right (settings for whatever is selected), **timeline** bottom, export button top-right. Clean, modern, dark theme default.
- [ ] Preview is always live: any setting change re-renders the current frame instantly (< 50 ms target).
- [ ] Playback: space to play/pause, J/K/L, arrow-key frame stepping, scrubbing with audio scrub-mute.

### 5.2 Timeline
- [ ] Tracks: **video (screen)**, **zoom segments**, **webcam**, **audio (mic)**, **audio (system)**. Compact, Screen-Studio-style — not a pro-NLE track stack.
- [ ] **Trim** start/end by dragging clip edges.
- [ ] **Cut**: split at playhead, delete middle sections (ripple delete — timeline closes the gap).
- [ ] **Speed-up segments:** select a range, set 1×–16× (e.g., speed through boring installs); audio for sped ranges is muted or pitch-preserved (v1: muted is fine). Optional "auto speed-up idle periods" detection (stretch).
- [ ] Zoom segment track as per §4.2.
- [ ] Timeline zoom in/out (the timeline itself), snapping to clicks/segment edges/playhead.
- [ ] Undo/redo for every editor action (`Ctrl+Z`/`Ctrl+Shift+Z`), effectively unlimited depth.

### 5.3 Styling — backdrop & frame ("the pretty part")
- [ ] **Padding/inset:** screen recording is inset within the output frame with configurable padding.
- [ ] **Background:** solid color, **gradient** (curated presets + custom), **image** (built-in wallpapers + user file), optional subtle blur on image backgrounds.
- [ ] **Rounded corners** on the recording (radius slider).
- [ ] **Shadow** under the recording (size/opacity/offset, sensible default that just looks good).
- [ ] Optional thin **border/stroke** on the recording.
- [ ] **Crop** the screen recording (post-hoc, e.g., cut off a second monitor sliver or taskbar).
- [ ] **Aspect ratios:** 16:9, 9:16 (vertical), 1:1, plus "original". Switching re-lays-out background, webcam, and **re-fits all zoom targets automatically** (vertical mode leans harder on zoom since the full desktop can't fit legibly).
- [ ] **Style presets:** save current styling (background/padding/shadow/cursor/webcam settings) as a named preset; apply to any project; import/export presets as JSON (shareable).

### 5.4 Webcam overlay
- [ ] Position presets (4 corners + custom drag), size slider, shapes: rounded rect / circle, border + shadow.
- [ ] **Webcam keyframing on the timeline:** change size/position over time — including **full-screen webcam segments** (intro/outro talking head) with a smooth animated transition between layouts.
- [ ] Hide webcam for a time range.
- [ ] Smart default placement that avoids the active zoom region where possible (stretch: automatic dodge animation like Screen Studio).
- [ ] Mirror toggle; background blur behind webcam (stretch).

### 5.5 Audio
- [ ] Per-track volume + mute (mic / system).
- [ ] **Noise removal** on mic (RNNoise or DeepFilterNet, on-device).
- [ ] **Loudness normalization** to a target (≈ −16 LUFS) at export.
- [ ] Click sounds track (from §4.3) with its own volume.
- [ ] Optional background music: drop in an audio file, volume + auto-duck under voice (stretch).

### 5.6 Captions (stretch, but spec'd)
- [ ] On-device transcription via **Whisper** (whisper.cpp); language auto-detect.
- [ ] Caption track on the timeline; editable text; styled burned-in subtitles (font/size/position/background pill) and/or `.srt` sidecar export.

---

## 6. Export — Feature Spec

- [ ] **MP4** (H.264 + AAC default; H.265 option), **WebM** (stretch), **GIF** (palette-optimized two-pass FFmpeg, fps/width controls, size estimate shown).
- [ ] Resolutions up to **4K**, fps 24/30/60 (capped at capture fps).
- [ ] **Presets:** "Web (1080p balanced)", "Social vertical (9:16 1080×1920)", "4K master", "GIF (small/medium)", "Lossless (editing handoff)" — each pins codec/resolution/bitrate; user presets savable.
- [ ] Hardware encode (NVENC/AMF/QSV) with software fallback; export runs off the UI thread with progress bar, cancel, and time estimate.
- [ ] Export **a selected range** of the timeline.
- [ ] **PNG frame export** of current frame (great for thumbnails).
- [ ] **Copy to clipboard** (file drop for MP4/GIF) and "open containing folder".
- [ ] Determinism: export output matches preview exactly (shared render core).
- [ ] Speed target: ≥ 1× realtime for 1080p60 on a mid-range GPU.

---

## 7. Project Format & Architecture

### 7.1 Project on disk (self-contained folder, e.g. `MyDemo.osproj/`)
```
project.json      # all edit state: zoom segments, cuts, styling, settings (versioned schema)
events.jsonl      # raw input event log (immutable)
screen.mp4        # screen capture intermediate (immutable)
camera.mp4        # webcam (optional)
mic.wav / sys.wav # audio tracks
meta.json         # capture metadata: displays, scale, timestamps, app version
```
- [ ] Everything non-destructive: edits live only in `project.json`.
- [ ] Recent-projects list on the launcher; projects are portable (copy the folder to another machine).
- [ ] Crash safety: recorder flushes to disk continuously; a crash loses at most ~1 s and the project remains openable.

### 7.2 Pipeline overview
```
RECORD: Windows.Graphics.Capture ─→ HW encoder ─→ screen.mp4
        WH_MOUSE_LL / WH_KEYBOARD_LL ─→ events.jsonl
        WASAPI mic/loopback ─→ wav        MediaCapture ─→ camera.mp4

ANALYZE: events.jsonl ─→ click clusters / typing runs ─→ auto zoom segments ─→ project.json

RENDER (preview & export, same code):
  for each output frame t:
    camera transform = evaluate(zoom segments, easing, follow-cursor, t)
    composite: background → screen frame (cropped by camera, rounded, shadow)
               → synthetic cursor (smoothed pos, click fx) → keystroke overlay
               → webcam → captions
EXPORT: rendered frames + mixed audio ─→ FFmpeg ─→ mp4/gif
```

### 7.3 The render core is the contract
One implementation evaluates `(media, events, project.json, t) → frame`. Preview calls it per displayed frame (GPU, WebGL/D3D); export calls it per output frame. No "preview-only" or "export-only" effects, ever.

### 7.4 Tech choices to confirm
| Layer | Choice | Alternative |
|---|---|---|
| Shell | C# WinUI 3 + WebView2 editor UI | Tauri (Rust) or Electron + C# sidecar |
| Editor UI | React + Canvas/WebGL in WebView2 | Avalonia/WPF native UI (no web tech) |
| Render core | WebGL/WebGPU in editor, mirrored by FFmpeg-fed native renderer **(risk: two implementations)** → prefer **one** native D3D11/Skia renderer used headless for export and swap-chained into the UI for preview | ffmpeg filtergraph only (too inflexible) |
| Encode | FFmpeg (bundled) | Media Foundation |

> Decision needed at build time: if we accept "one native renderer" (right column risk avoided), the editor UI can stay web-tech while the *canvas itself* is a native swap chain — best of both. Flagging now because it's the main architectural fork.

---

## 8. Settings (app-level)
- [ ] Default capture: fps, quality, countdown, hotkeys.
- [ ] Default style preset for new recordings.
- [ ] Auto-zoom defaults: intensity, dwell time, default zoom level.
- [ ] Privacy: keystroke logging mode (full / modifiers-only / ticks-only).
- [ ] Storage location for projects; disk-space indicator.
- [ ] GPU encoder selection (auto/NVENC/AMF/QSV/x264).

---

## 9. Milestones

| Phase | Scope | Exit criteria |
|---|---|---|
| **M1 — Capture core** | Recorder: full-screen + mic, event log, project folder; no editor (auto-export raw) | 10-min 1080p60 recording, A/V sync ±1 frame, events aligned |
| **M2 — Render core + auto-zoom** | Compositor, synthetic cursor + smoothing, auto-zoom generation, hardcoded style, MP4 export | Recording in → polished zoomy video out, no UI |
| **M3 — Editor MVP** | Editor UI: preview, timeline (trim/cut), zoom segment editing, styling panel, export presets | Full record→edit→export loop usable daily |
| **M4 — Parity polish** | Webcam overlay + keyframing, system audio, click fx/sounds, keystroke overlay, GIF, vertical mode, presets | Side-by-side with Screen Studio output: indistinguishable feel |
| **M5 — Stretch** | Captions/Whisper, noise removal, motion blur, window-capture mode, region mode, music ducking, local share server | Cherry-pick |

---

## 10. Acceptance Criteria for "feels like Screen Studio"
1. Record a 60 s demo clicking around an app and typing; with **zero manual edits**, the exported video has zooms on every meaningful interaction, no zoom-thrash, buttery ease-in/out, and the cursor glides.
2. Camera never jitters, overshoots, or shows out-of-bounds area.
3. Changing a slider (zoom intensity, padding, cursor size) updates the preview in < 50 ms and regenerating auto-zooms takes < 1 s for a 10-min recording.
4. Export matches preview pixel-for-pixel; 1080p60 exports at ≥ realtime on a mid-range GPU.
5. Everything works with the network cable unplugged.

---

## 11. Open Questions (answer during review)
1. **Packaging:** Option A (single desktop app, recommended) or Option B (tray recorder + localhost browser editor)?
2. **Editor UI tech:** web-tech in WebView2 (recommended, fastest path to "clean modern") vs. fully native C#?
3. Is **window/region capture** needed in v1, or is full-screen + post-hoc crop enough for M1–M3?
4. Keystroke privacy default: modifiers-only (recommended) or full logging?
5. Are **captions** and **noise removal** must-haves or stretch?
6. GIF export priority — v1 or later?
