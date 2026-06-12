# OpenStudio

A self-hosted, offline Screen Studio–style recorder + editor for Windows, implementing [SPEC.md](SPEC.md).
Record your screen, and get a polished video with automatic zooms that follow clicks and typing,
smooth cursor glide, click ripples, backdrops and clean easing — no accounts, no cloud, no telemetry.

## Architecture (spec §2 — Option A: single desktop app)

```
┌─ OpenStudio.exe (C# WPF shell) ────────────────────────────────────┐
│  WebView2 ──► editor/ (React + TypeScript + Tailwind)              │
│              THE render core: camera springs, cursor smoothing,    │
│              compositor — same code path for preview AND export    │
│  Bridge (COM host object): recording control, project IO,          │
│              zoom regeneration, export encoding                    │
├─ OpenStudio.Recorder (C#) ─────────────────────────────────────────┤
│  Windows.Graphics.Capture (cursor EXCLUDED) ─► MediaStreamSource   │
│      ─► MediaTranscoder (HW encode) ─► screen.mp4 (high bitrate)   │
│  SetWindowsHookEx WH_MOUSE_LL/WH_KEYBOARD_LL ─► events.jsonl       │
│  WASAPI (NAudio): mic.wav + system loopback sys.wav                │
│  MediaCapture: webcam ─► camera.mp4 (separate track, native res)   │
├─ OpenStudio.Core (C#) ─────────────────────────────────────────────┤
│  project.json / meta.json / events models (camelCase contract      │
│  shared with TS), auto-zoom generator (click clustering, typing    │
│  runs, dwell) — unit tested                                        │
└────────────────────────────────────────────────────────────────────┘
```

Key design points, matching the spec:

- **Record raw, render synthetic (§4.3).** The OS cursor is excluded from capture; the final
  cursor is re-drawn from the event log with One-Euro smoothing, so smoothing strength, size,
  auto-hide and click effects are all adjustable in post, non-destructively.
- **One render core (§7.3).** `editor/src/render/compositor.ts` is the single
  `(media, events, project, t) → frame` function. Preview calls it per displayed frame; export
  pulls frames from the *same* function into a WebView2 shared buffer which C# encodes via
  Media Foundation (pull-based, so encode speed never piles up memory). Preview === export.
- **Deterministic camera (§4.1).** Zoom segments feed critically damped springs evaluated on a
  precomputed 60 Hz grid — no overshoot, no jitter, target→target blending without bouncing
  through full frame, dead-zone cursor following, hard viewport clamping. Recomputing the whole
  path after an edit takes a few ms even for long recordings.
- **One master clock (§3.3).** Everything is QPC: capture frame timestamps, input events, audio
  start offsets. The editor rebases all tracks onto the video clock on load.
- **Self-contained project folders (§7.1)** (`*.osproj/` with `project.json`, `events.jsonl`,
  `screen.mp4`, `mic.wav`, `sys.wav`, `meta.json`) — portable, crash-safe (event log flushes
  every 500 ms; saves are write-then-rename), and all edits are non-destructive.
- **No FFmpeg dependency.** Encode/decode is Media Foundation end to end (hardware H.264/HEVC
  when available). This keeps the install self-contained; FFmpeg can be added later for GIF/WebM.

### Decisions on the spec's open questions (§11)

1. **Packaging:** Option A — single desktop app (WPF + WebView2). The editor code has no OS
   dependencies and stays portable to the tray + localhost layout later.
2. **Editor UI tech:** web-tech (React/TS/Tailwind) in WebView2, per the spec's recommendation.
3. **Window/region capture:** deferred — full screen + post-hoc crop covers M1–M3.
4. **Keystroke privacy default:** modifiers-only (full / ticks-only selectable per recording).
5. **Captions & noise removal:** stretch (M5), not in this build.
6. **GIF export:** later; MP4 (H.264/H.265) + PNG frame export are in.

## Build & run

Prereqs: .NET 7 SDK, Node 18+, Windows 10 2004+ (WebView2 Evergreen runtime, preinstalled on Win11).

```powershell
cd editor
npm install
npm run build        # produces editor/dist, which the shell auto-locates

cd ..
dotnet build
dotnet run --project src/OpenStudio.App
```

Tests: `dotnet test`

Editor dev loop with hot reload:

```powershell
cd editor; npm run dev                       # vite on http://localhost:5173
$env:OPENSTUDIO_DEV_URL = "http://localhost:5173"
dotnet run --project src/OpenStudio.App
```

## Using it

1. **Record** — pick monitor / webcam (with live preview bubble) / mic / system audio / fps /
   countdown on the launcher and hit record (or `Ctrl+Shift+R` from anywhere). A
   capture-excluded pill shows elapsed time with Stop / Discard. Stopping opens the editor
   with auto-zooms already generated. The webcam records to its own `camera.mp4` track —
   never burned in, so the overlay stays editable.
2. **Edit** — preview center, inspector right (zoom defaults & regenerate, style/backdrop,
   cursor, webcam, audio, keystroke overlay), timeline bottom (zoom segment track with
   drag/trim, webcam keyframe markers, split `S`, ripple-delete sections, per-section
   speed-up, trim handles). `Space` play/pause · `J/K/L` · arrows frame-step · `Ctrl+Z` undo ·
   click the preview to retarget a selected zoom · drag the webcam bubble to reposition it.
   Webcam keyframes change layout over time with smooth transitions — including full-screen
   talking-head intros/outros and hidden ranges.
2b. **Captions** — inspector → Text → *Generate captions*. First run downloads the on-device
   Whisper model (~140 MB, one time); transcription itself is fully offline. You get short
   word-timed chunks (default 3 words — TikTok pacing) drawn huge and bold with the spoken
   word highlighted and a pop-in animation. Edit any chunk's text inline, delete chunks,
   tweak size/position/colors, or export an `.srt` sidecar.
3. **Export** — presets (Web 1080p / Social / 4K / handoff), H.264 or H.265, fps capped at
   capture rate, progress + ETA + cancel, PNG frame export, "open containing folder".

## Implementation status vs. spec milestones (§9)

| Milestone | Status |
|---|---|
| **M1 capture core** | ✅ full-screen + mic + system audio, event log, project folder, QPC alignment |
| **M2 render core + auto-zoom** | ✅ compositor, synthetic cursor + smoothing, zoom generation, MP4 export |
| **M3 editor MVP** | ✅ preview, timeline (trim/split/cut/speed), zoom editing, styling, export presets |
| **M4 parity polish** | ✅ webcam recording + overlay (shapes, mirror, border/shadow, drag positioning, **layout keyframes with animated transitions incl. full-screen talking head**, cursor auto-dodge, background soft-focus), keystroke overlay, click ripples + synthesized click sounds, motion blur (cursor + camera pans), vertical/square aspect, crop, GIF export (built-in palette+dither encoder), style presets (save/apply/import/export) |
| **M5 stretch** | ✅ **TikTok-style voice captions** (on-device whisper.cpp with token-level word timestamps, ≤ N-word chunks, spoken-word highlight, pop animation, editable text, `.srt` export), **window capture**, **region capture** (drag-select overlay), **pause/resume** (Ctrl+Shift+P, pauses become hard cuts), mic **noise removal** (spectral subtraction, on-device), **background music with auto-duck under voice**, **WebM export** (VP9 via realtime MediaRecorder). Remaining: caption karaoke DTW tuning, RNNoise-grade denoise, local share server |

Known v1 simplifications: sped-up ranges mute audio (per spec §5.2 "muted is fine"), loudness
normalization is RMS-approximate rather than full BS.1770, and recordings with a display
resolution change mid-session aren't handled.
