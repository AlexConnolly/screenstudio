import { useState } from "react";
import { api } from "../bridge";
import { toSrt } from "../render/captions";
import { outToSrc, srcToOut } from "../render/edl";
import { activeKeyframe } from "../render/webcam";
import { getDerived } from "../state/derived";
import { useStore } from "../state/store";
import type { ZoomSegment } from "../types";
import { Button, ColorInput, Row, Section, Select, Slider, Toggle } from "./controls";

const GRADIENT_PRESETS: Array<{ from: string; to: string; angle: number }> = [
  { from: "#4f46e5", to: "#0ea5e9", angle: 135 },
  { from: "#f43f5e", to: "#f97316", angle: 135 },
  { from: "#8b5cf6", to: "#ec4899", angle: 120 },
  { from: "#059669", to: "#84cc16", angle: 135 },
  { from: "#0f172a", to: "#334155", angle: 180 },
  { from: "#fbbf24", to: "#f43f5e", angle: 150 },
];

export function Inspector() {
  const project = useStore((s) => s.project);
  const meta = useStore((s) => s.meta);
  const tab = useStore((s) => s.inspectorTab);
  const setTab = useStore((s) => s.setInspectorTab);
  const selectedZoomId = useStore((s) => s.selectedZoomId);
  const selectedSection = useStore((s) => s.selectedSection);

  if (!project) return null;
  const tabs: Array<[typeof tab, string]> = [
    ["zoom", "Zoom"],
    ["style", "Style"],
    ["cursor", "Cursor"],
    ...(meta?.hasWebcam ? ([["webcam", "Cam"]] as Array<[typeof tab, string]>) : []),
    ...(meta?.hasMic ? ([["captions", "Text"]] as Array<[typeof tab, string]>) : []),
    ["audio", "Audio"],
    ["keys", "Keys"],
  ];
  const selectedZoom = selectedZoomId
    ? project.zoom.segments.find((z) => z.id === selectedZoomId)
    : null;

  return (
    <div className="flex h-full w-[300px] shrink-0 flex-col overflow-y-auto border-l border-white/5 bg-[#0d1017]">
      {selectedZoom ? (
        <ZoomSegmentPanel seg={selectedZoom} />
      ) : selectedSection ? (
        <SectionPanel />
      ) : (
        <>
          <div className="flex border-b border-white/5">
            {tabs.map(([id, label]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`flex-1 py-2.5 text-[12px] font-medium transition-colors ${
                  tab === id ? "border-b-2 border-indigo-400 text-slate-100" : "text-slate-500 hover:text-slate-300"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === "zoom" && <ZoomDefaultsPanel />}
          {tab === "style" && <StylePanel />}
          {tab === "cursor" && <CursorPanel />}
          {tab === "webcam" && <WebcamPanel />}
          {tab === "captions" && <CaptionsPanel />}
          {tab === "audio" && <AudioPanel />}
          {tab === "keys" && <KeysPanel />}
        </>
      )}
    </div>
  );
}

function ZoomSegmentPanel({ seg }: { seg: ZoomSegment }) {
  const update = useStore((s) => s.update);
  const selectZoom = useStore((s) => s.selectZoom);
  const mutate = (fn: (z: ZoomSegment) => void, commit = true) =>
    update((p) => {
      const z = p.zoom.segments.find((q) => q.id === seg.id);
      if (z) fn(z);
    }, commit);
  return (
    <>
      <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
        <div className="text-[13px] font-semibold text-slate-200">
          Zoom segment <span className="text-slate-500">({seg.kind}{seg.pinned ? ", pinned" : ""})</span>
        </div>
        <button className="text-slate-500 hover:text-slate-200" onClick={() => selectZoom(null)}>✕</button>
      </div>
      <Section title="Camera">
        <Slider label="Zoom level" value={seg.zoom} min={1.1} max={4} step={0.05}
          format={(v) => `${v.toFixed(2)}×`}
          onChange={(v) => mutate((z) => (z.zoom = v))} />
        <Toggle label="Follow cursor" value={seg.follow} onChange={(v) => mutate((z) => (z.follow = v))} />
        <div className="text-[11px] leading-relaxed text-slate-600">
          Click on the preview to set this segment's target point.
        </div>
      </Section>
      <Section title="Easing">
        <Slider label="Ease in" value={seg.easeIn} min={0.3} max={2.5} step={0.05}
          format={(v) => `${v.toFixed(2)} s`}
          onChange={(v) => mutate((z) => (z.easeIn = v))} />
        <Slider label="Ease out" value={seg.easeOut} min={0.3} max={2.5} step={0.05}
          format={(v) => `${v.toFixed(2)} s`}
          onChange={(v) => mutate((z) => (z.easeOut = v))} />
      </Section>
      <Section title="Actions">
        <div className="flex flex-wrap gap-2">
          {seg.kind === "auto" && (
            <Button onClick={() => mutate((z) => (z.pinned = !z.pinned))}>
              {seg.pinned ? "Unpin" : "Pin"}
            </Button>
          )}
          <Button
            onClick={() => {
              const copy: ZoomSegment = { ...seg, id: Math.random().toString(36).slice(2, 10), kind: "manual" };
              const len = seg.end - seg.start;
              copy.start = seg.end;
              copy.end = seg.end + len;
              update((p) => p.zoom.segments.push(copy));
            }}
          >
            Duplicate
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              update((p) => {
                p.zoom.segments = p.zoom.segments.filter((z) => z.id !== seg.id);
              });
              selectZoom(null);
            }}
          >
            Delete
          </Button>
        </div>
      </Section>
    </>
  );
}

function SectionPanel() {
  const update = useStore((s) => s.update);
  const project = useStore((s) => s.project);
  const selectSection = useStore((s) => s.selectSection);
  const sec = useStore((s) => s.selectedSection);
  if (!project || !sec) return null;
  const sp = project.speed.find((r) => r.start <= sec.start + 1e-6 && r.end >= sec.end - 1e-6);
  const factor = sp?.factor ?? 1;
  return (
    <>
      <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
        <div className="text-[13px] font-semibold text-slate-200">Clip section</div>
        <button className="text-slate-500 hover:text-slate-200" onClick={() => selectSection(null)}>✕</button>
      </div>
      <Section title="Speed">
        <Select
          label="Playback"
          value={String(factor)}
          options={[1, 1.5, 2, 4, 8, 16].map((f) => ({ value: String(f), label: `${f}×${f > 1 ? " (muted)" : ""}` }))}
          onChange={(v) =>
            update((p) => {
              p.speed = p.speed.filter((r) => !(r.start <= sec.start + 1e-6 && r.end >= sec.end - 1e-6));
              const f = parseFloat(v);
              if (f !== 1) p.speed.push({ start: sec.start, end: sec.end, factor: f });
            })
          }
        />
      </Section>
      <Section title="Actions">
        <Button
          variant="danger"
          onClick={() => {
            update((p) => p.cuts.push({ start: sec.start, end: sec.end }));
            selectSection(null);
          }}
        >
          Delete section (ripple)
        </Button>
      </Section>
    </>
  );
}

function ZoomDefaultsPanel() {
  const update = useStore((s) => s.update);
  const project = useStore((s) => s.project);
  const [busy, setBusy] = useState(false);
  if (!project) return null;
  const t = project.zoom.tunables;
  return (
    <>
      <Section title="Auto-zoom">
        <Toggle label="Auto-zoom enabled" value={project.zoom.autoEnabled}
          onChange={(v) => update((p) => (p.zoom.autoEnabled = v))} />
        <Select
          label="Intensity"
          value={t.intensity >= 1.3 ? "strong" : t.intensity <= 0.75 ? "subtle" : "medium"}
          options={[
            { value: "subtle", label: "Subtle" },
            { value: "medium", label: "Medium" },
            { value: "strong", label: "Strong" },
          ]}
          onChange={(v) =>
            update((p) => (p.zoom.tunables.intensity = v === "subtle" ? 0.7 : v === "strong" ? 1.4 : 1.0))
          }
        />
        <Slider label="Default zoom" value={t.defaultZoom} min={1.25} max={4} step={0.05}
          format={(v) => `${v.toFixed(2)}×`}
          onChange={(v) => update((p) => (p.zoom.tunables.defaultZoom = v))} />
        <Slider label="Zoom-out dwell" value={t.dwell} min={0.5} max={6} step={0.1}
          format={(v) => `${v.toFixed(1)} s`}
          onChange={(v) => update((p) => (p.zoom.tunables.dwell = v))} />
        <Slider label="Cluster window" value={t.clusterWindow} min={1} max={6} step={0.1}
          format={(v) => `${v.toFixed(1)} s`}
          onChange={(v) => update((p) => (p.zoom.tunables.clusterWindow = v))} />
      </Section>
      <Section title="Regenerate">
        <div className="text-[11px] leading-relaxed text-slate-600">
          Re-runs zoom detection with the settings above. Manual and pinned segments are kept.
        </div>
        <Button
          variant="primary"
          disabled={busy}
          onClick={async () => {
            const s = useStore.getState();
            if (!s.projectDir || !s.project) return;
            setBusy(true);
            try {
              const keep = s.project.zoom.segments.filter((z) => z.kind === "manual" || z.pinned);
              const res = await api.regenerateZooms(s.projectDir, s.project.zoom.tunables, keep);
              if (Array.isArray(res)) {
                s.update((p) => (p.zoom.segments = res));
              }
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Generating…" : "Regenerate auto-zooms"}
        </Button>
      </Section>
    </>
  );
}

function PresetsSection() {
  const update = useStore((s) => s.update);
  const [presets, setPresets] = useState<string[] | null>(null);
  const [selected, setSelected] = useState("");
  const [saveName, setSaveName] = useState("");

  const refresh = async () => {
    const list = await api.listStylePresets();
    setPresets(list);
    if (list.length && !list.includes(selected)) setSelected(list[0]);
  };
  if (presets === null) {
    void refresh();
  }

  const apply = async () => {
    if (!selected) return;
    const json = await api.loadStylePreset(selected);
    if (!json) return;
    const preset = JSON.parse(json);
    update((p) => {
      if (preset.style) p.style = preset.style;
      if (preset.cursor) p.cursor = preset.cursor;
      if (preset.keystrokes) p.keystrokes = preset.keystrokes;
      if (preset.captionStyle) p.captions = { ...preset.captionStyle, words: p.captions.words };
      if (preset.webcam) p.webcam = { ...preset.webcam, enabled: p.webcam.enabled, keyframes: p.webcam.keyframes };
    });
  };

  const saveCurrent = async () => {
    const s = useStore.getState();
    if (!s.project || !saveName.trim()) return;
    const { words: _w, ...captionStyle } = s.project.captions;
    const { keyframes: _k, enabled: _e, ...webcam } = s.project.webcam;
    await api.saveStylePreset(saveName.trim(), JSON.stringify({
      style: s.project.style,
      cursor: s.project.cursor,
      keystrokes: s.project.keystrokes,
      captionStyle,
      webcam,
    }));
    setSaveName("");
    await refresh();
  };

  return (
    <Section title="Style presets">
      {presets && presets.length > 0 && (
        <>
          <Select value={selected} onChange={setSelected}
            options={presets.map((p) => ({ value: p, label: p }))} />
          <div className="flex flex-wrap gap-1.5">
            <Button variant="primary" onClick={() => void apply()}>Apply</Button>
            <Button onClick={async () => { await api.exportStylePreset(selected); }}>Share…</Button>
            <Button variant="danger" onClick={async () => {
              await api.deleteStylePreset(selected);
              await refresh();
            }}>Delete</Button>
          </div>
        </>
      )}
      <div className="flex items-center gap-1.5">
        <input
          className="min-w-0 flex-1 rounded border border-white/10 bg-[#161a23] px-2 py-1 text-[13px] text-slate-200 outline-none focus:border-indigo-500"
          placeholder="Preset name…"
          value={saveName}
          onChange={(e) => setSaveName(e.target.value)}
        />
        <Button onClick={() => void saveCurrent()} disabled={!saveName.trim()}>Save</Button>
      </div>
      <Button onClick={async () => {
        const name = await api.importStylePreset();
        if (name) {
          await refresh();
          setSelected(name);
        }
      }}>
        Import preset…
      </Button>
    </Section>
  );
}

function StylePanel() {
  const update = useStore((s) => s.update);
  const project = useStore((s) => s.project);
  if (!project) return null;
  const st = project.style;
  return (
    <>
      <PresetsSection />
      <Section title="Frame">
        <Select label="Aspect" value={st.aspect}
          options={[
            { value: "16:9", label: "16:9 — Landscape" },
            { value: "9:16", label: "9:16 — Vertical" },
            { value: "1:1", label: "1:1 — Square" },
            { value: "original", label: "Original" },
          ]}
          onChange={(v) => update((p) => (p.style.aspect = v))} />
        <Slider label="Padding" value={st.padding} min={0} max={0.2} step={0.005}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => update((p) => (p.style.padding = v))} />
        <Slider label="Corner radius" value={st.cornerRadius} min={0} max={48} step={1}
          format={(v) => `${v.toFixed(0)}px`}
          onChange={(v) => update((p) => (p.style.cornerRadius = v))} />
      </Section>
      <Section title="Background">
        <Select label="Type" value={st.background.type}
          options={[
            { value: "gradient", label: "Gradient" },
            { value: "solid", label: "Solid" },
          ]}
          onChange={(v) => update((p) => (p.style.background.type = v))} />
        {st.background.type === "solid" && (
          <ColorInput label="Color" value={st.background.color}
            onChange={(v) => update((p) => (p.style.background.color = v))} />
        )}
        {st.background.type === "gradient" && (
          <>
            <div className="grid grid-cols-6 gap-1.5">
              {GRADIENT_PRESETS.map((g, i) => (
                <button
                  key={i}
                  className="h-7 rounded-md border border-white/10"
                  style={{ background: `linear-gradient(${g.angle}deg, ${g.from}, ${g.to})` }}
                  onClick={() =>
                    update((p) => {
                      p.style.background.from = g.from;
                      p.style.background.to = g.to;
                      p.style.background.angle = g.angle;
                    })
                  }
                />
              ))}
            </div>
            <ColorInput label="From" value={st.background.from}
              onChange={(v) => update((p) => (p.style.background.from = v))} />
            <ColorInput label="To" value={st.background.to}
              onChange={(v) => update((p) => (p.style.background.to = v))} />
            <Slider label="Angle" value={st.background.angle} min={0} max={360} step={5}
              format={(v) => `${v.toFixed(0)}°`}
              onChange={(v) => update((p) => (p.style.background.angle = v))} />
          </>
        )}
      </Section>
      <Section title="Shadow & border">
        <Slider label="Shadow size" value={st.shadow.size} min={0} max={120} step={2}
          format={(v) => `${v.toFixed(0)}px`}
          onChange={(v) => update((p) => (p.style.shadow.size = v))} />
        <Slider label="Shadow opacity" value={st.shadow.opacity} min={0} max={1} step={0.02}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => update((p) => (p.style.shadow.opacity = v))} />
        <Slider label="Border width" value={st.border.width} min={0} max={6} step={0.5}
          format={(v) => `${v.toFixed(1)}px`}
          onChange={(v) => update((p) => (p.style.border.width = v))} />
        {st.border.width > 0 && (
          <ColorInput label="Border color" value={st.border.color}
            onChange={(v) => update((p) => (p.style.border.color = v))} />
        )}
      </Section>
      <Section title="Crop">
        <CropControls />
      </Section>
    </>
  );
}

function CropControls() {
  const update = useStore((s) => s.update);
  const project = useStore((s) => s.project);
  if (!project) return null;
  const crop = project.style.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const setCrop = (k: "x" | "y" | "w" | "h", v: number) =>
    update((p) => {
      const c = p.style.crop ?? { x: 0, y: 0, w: 1, h: 1 };
      c[k] = v;
      c.w = Math.min(c.w, 1 - c.x);
      c.h = Math.min(c.h, 1 - c.y);
      p.style.crop = c;
    });
  return (
    <>
      <Slider label="Left" value={crop.x} min={0} max={0.9} step={0.005}
        format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setCrop("x", v)} />
      <Slider label="Top" value={crop.y} min={0} max={0.9} step={0.005}
        format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setCrop("y", v)} />
      <Slider label="Width" value={crop.w} min={0.1} max={1} step={0.005}
        format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setCrop("w", v)} />
      <Slider label="Height" value={crop.h} min={0.1} max={1} step={0.005}
        format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setCrop("h", v)} />
      {project.style.crop && (
        <Button onClick={() => update((p) => (p.style.crop = null))}>Reset crop</Button>
      )}
    </>
  );
}

function CursorPanel() {
  const update = useStore((s) => s.update);
  const project = useStore((s) => s.project);
  if (!project) return null;
  const c = project.cursor;
  return (
    <>
      <Section title="Cursor">
        <Toggle label="Hide cursor" value={c.hidden} onChange={(v) => update((p) => (p.cursor.hidden = v))} />
        <Select label="Smoothing" value={c.smoothing}
          options={[
            { value: "off", label: "Off" },
            { value: "subtle", label: "Subtle" },
            { value: "medium", label: "Medium" },
            { value: "strong", label: "Strong" },
          ]}
          onChange={(v) => update((p) => (p.cursor.smoothing = v))} />
        <Slider label="Size" value={c.size} min={0.5} max={4} step={0.05}
          format={(v) => `${v.toFixed(2)}×`}
          onChange={(v) => update((p) => (p.cursor.size = v))} />
        <Toggle label="Auto-hide when idle" value={c.autoHide}
          onChange={(v) => update((p) => (p.cursor.autoHide = v))} />
        {c.autoHide && (
          <Slider label="Hide after" value={c.autoHideDelay} min={0.5} max={6} step={0.1}
            format={(v) => `${v.toFixed(1)} s`}
            onChange={(v) => update((p) => (p.cursor.autoHideDelay = v))} />
        )}
      </Section>
      <Section title="Click effects">
        <Toggle label="Click ripples" value={c.clickEffects}
          onChange={(v) => update((p) => (p.cursor.clickEffects = v))} />
        {c.clickEffects && (
          <ColorInput label="Ripple color" value={c.clickColor}
            onChange={(v) => update((p) => (p.cursor.clickColor = v))} />
        )}
        <Toggle label="Squish on click" value={c.scaleOnClick}
          onChange={(v) => update((p) => (p.cursor.scaleOnClick = v))} />
        <Toggle label="Click sound (subtle tick)" value={c.clickSound}
          onChange={(v) => update((p) => (p.cursor.clickSound = v))} />
        {c.clickSound && (
          <Slider label="Tick volume" value={c.clickSoundVolume} min={0} max={1} step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => update((p) => (p.cursor.clickSoundVolume = v))} />
        )}
      </Section>
      <Section title="Motion">
        <Toggle label="Motion blur (cursor + camera)" value={c.motionBlur}
          onChange={(v) => update((p) => (p.cursor.motionBlur = v))} />
      </Section>
    </>
  );
}

function WebcamPanel() {
  const update = useStore((s) => s.update);
  const project = useStore((s) => s.project);
  const meta = useStore((s) => s.meta);
  const events = useStore((s) => s.events);
  const time = useStore((s) => s.time);
  if (!project || !meta || !events) return null;
  const wc = project.webcam;
  const playheadSrc = outToSrc(getDerived(project, meta, events).edl, time);
  const fmt = (t: number) => {
    const m = Math.floor(t / 60);
    const s = (t % 60).toFixed(1);
    return `${m}:${s.padStart(4, "0")}`;
  };
  return (
    <>
      <Section title="Webcam (§5.4)">
        <Toggle label="Show webcam" value={wc.enabled}
          onChange={(v) => update((p) => (p.webcam.enabled = v))} />
        <Select label="Shape" value={wc.shape}
          options={[
            { value: "circle", label: "Circle" },
            { value: "rounded", label: "Rounded rect" },
          ]}
          onChange={(v) => update((p) => (p.webcam.shape = v))} />
        <Slider label="Size" value={wc.size} min={0.1} max={0.6} step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => update((p) => (p.webcam.size = v))} />
        <Toggle label="Mirror" value={wc.mirror}
          onChange={(v) => update((p) => (p.webcam.mirror = v))} />
        <Toggle label="Shadow" value={wc.shadow}
          onChange={(v) => update((p) => (p.webcam.shadow = v))} />
        <Slider label="Border" value={wc.borderWidth} min={0} max={8} step={0.5}
          format={(v) => `${v.toFixed(1)}px`}
          onChange={(v) => update((p) => (p.webcam.borderWidth = v))} />
        <Toggle label="Dodge the cursor" value={wc.autoDodge}
          onChange={(v) => update((p) => (p.webcam.autoDodge = v))} />
        <Toggle label="Background soft-focus" value={wc.backdropBlur}
          onChange={(v) => update((p) => (p.webcam.backdropBlur = v))} />
      </Section>
      <Section title="Position">
        <div className="grid grid-cols-4 gap-1.5">
          {(
            [
              ["↖", 0, 0],
              ["↗", 1, 0],
              ["↙", 0, 1],
              ["↘", 1, 1],
            ] as const
          ).map(([label, nx, ny]) => (
            <Button key={label} onClick={() => update((p) => {
              p.webcam.nx = nx === 0 ? 0.02 : 0.97;
              p.webcam.ny = ny === 0 ? 0.03 : 0.96;
            })}>
              {label}
            </Button>
          ))}
        </div>
        <div className="text-[11px] leading-relaxed text-slate-600">
          Or drag the webcam bubble directly on the preview.
        </div>
      </Section>
      <Section title="Layout keyframes">
        <div className="text-[11px] leading-relaxed text-slate-600">
          A keyframe changes the layout from its time onward with a smooth animated
          transition — use Fullscreen for talking-head intros/outros, Hidden to remove
          the webcam for a range.
        </div>
        <Button
          variant="primary"
          onClick={() => {
            const kf = activeKeyframe(wc, playheadSrc);
            update((p) =>
              p.webcam.keyframes.push({
                id: Math.random().toString(36).slice(2, 10),
                t: playheadSrc,
                size: kf?.size ?? p.webcam.size,
                nx: kf?.nx ?? p.webcam.nx,
                ny: kf?.ny ?? p.webcam.ny,
                fullscreen: false,
                hidden: false,
              }),
            );
          }}
        >
          ＋ Keyframe at playhead
        </Button>
        {[...wc.keyframes].sort((a, b) => a.t - b.t).map((kf) => (
          <div key={kf.id} className="space-y-1.5 rounded-lg border border-white/5 bg-black/20 p-2">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[12px] text-slate-400">{fmt(kf.t)}</span>
              <div className="flex gap-1">
                <button
                  title="Fullscreen talking head"
                  className={`rounded px-1.5 py-0.5 text-[11px] ${kf.fullscreen ? "bg-indigo-500 text-white" : "bg-white/5 text-slate-400 hover:bg-white/10"}`}
                  onClick={() => update((p) => {
                    const k = p.webcam.keyframes.find((q) => q.id === kf.id);
                    if (k) { k.fullscreen = !k.fullscreen; if (k.fullscreen) k.hidden = false; }
                  })}
                >
                  Full
                </button>
                <button
                  title="Hide webcam from here"
                  className={`rounded px-1.5 py-0.5 text-[11px] ${kf.hidden ? "bg-slate-300 text-slate-900" : "bg-white/5 text-slate-400 hover:bg-white/10"}`}
                  onClick={() => update((p) => {
                    const k = p.webcam.keyframes.find((q) => q.id === kf.id);
                    if (k) { k.hidden = !k.hidden; if (k.hidden) k.fullscreen = false; }
                  })}
                >
                  Hide
                </button>
                <button
                  title="Delete keyframe"
                  className="rounded px-1.5 py-0.5 text-[11px] text-red-400 hover:bg-red-500/15"
                  onClick={() => update((p) => {
                    p.webcam.keyframes = p.webcam.keyframes.filter((q) => q.id !== kf.id);
                  })}
                >
                  ✕
                </button>
              </div>
            </div>
            {!kf.fullscreen && !kf.hidden && (
              <Slider label="Size" value={kf.size} min={0.1} max={0.6} step={0.01}
                format={(v) => `${Math.round(v * 100)}%`}
                onChange={(v) => update((p) => {
                  const k = p.webcam.keyframes.find((q) => q.id === kf.id);
                  if (k) k.size = v;
                })} />
            )}
          </div>
        ))}
      </Section>
    </>
  );
}

function CaptionsPanel() {
  const update = useStore((s) => s.update);
  const project = useStore((s) => s.project);
  const meta = useStore((s) => s.meta);
  const events = useStore((s) => s.events);
  const task = useStore((s) => s.captionTask);
  const [modelReady, setModelReady] = useState<boolean | null>(null);
  if (!project || !meta || !events) return null;
  const cfg = project.captions;
  const chunks = getDerived(project, meta, events).captionChunks;
  const hasWords = cfg.words.length > 0;

  if (modelReady === null) {
    void api.getCaptionStatus().then((s) => setModelReady(s.modelReady)).catch(() => setModelReady(false));
  }

  const replaceChunkText = (chunk: { start: number; end: number; words: Array<{ t0: number; t1: number; text: string }> }, text: string) => {
    const parts = text.split(/\s+/).filter(Boolean);
    const lo = chunk.words[0].t0;
    const hi = chunk.words[chunk.words.length - 1].t1;
    update((p) => {
      const kept = p.captions.words.filter((w) => w.t1 <= lo + 1e-6 || w.t0 >= hi - 1e-6);
      if (parts.length > 0) {
        const span = Math.max(0.05, hi - lo);
        const totalChars = parts.reduce((a, t) => a + t.length + 1, 0);
        let cursor = lo;
        for (const part of parts) {
          const dur = span * ((part.length + 1) / totalChars);
          kept.push({ t0: cursor, t1: cursor + dur, text: part });
          cursor += dur;
        }
      }
      kept.sort((a, b) => a.t0 - b.t0);
      p.captions.words = kept;
    });
  };

  return (
    <>
      <Section title="Voice captions">
        {task ? (
          <div className="space-y-2">
            <div className="text-[12px] text-slate-400">
              {task.phase === "downloading"
                ? `Downloading voice model… ${Math.round(task.percent * 100)}%`
                : `Transcribing… ${Math.round(task.percent * 100)}%`}
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
              <div className="h-full bg-indigo-500 transition-all"
                style={{ width: `${task.percent * 100}%` }} />
            </div>
            <Button variant="danger" onClick={() => void api.cancelCaptions()}>Cancel</Button>
          </div>
        ) : (
          <>
            <Button
              variant="primary"
              onClick={() => {
                const dir = useStore.getState().projectDir;
                if (dir) void api.generateCaptions(dir);
              }}
            >
              {hasWords ? "Re-transcribe voice" : "Generate captions"}
            </Button>
            {modelReady === false && (
              <div className="text-[11px] leading-relaxed text-slate-600">
                First run downloads the on-device voice model (~140 MB, one time).
                Transcription itself runs fully offline.
              </div>
            )}
          </>
        )}
      </Section>
      {hasWords && (
        <>
          <Section title="Style">
            <Toggle label="Show captions" value={cfg.enabled}
              onChange={(v) => update((p) => (p.captions.enabled = v))} />
            <Slider label="Words at once" value={cfg.maxWords} min={1} max={5} step={1}
              format={(v) => `${v.toFixed(0)}`}
              onChange={(v) => update((p) => (p.captions.maxWords = Math.round(v)))} />
            <Select label="Position" value={cfg.position}
              options={[
                { value: "center", label: "Center (TikTok)" },
                { value: "bottom", label: "Bottom" },
                { value: "top", label: "Top" },
              ]}
              onChange={(v) => update((p) => (p.captions.position = v))} />
            <Slider label="Size" value={cfg.fontScale} min={0.5} max={2} step={0.05}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(v) => update((p) => (p.captions.fontScale = v))} />
            <Toggle label="UPPERCASE" value={cfg.uppercase}
              onChange={(v) => update((p) => (p.captions.uppercase = v))} />
            <Toggle label="Pop animation" value={cfg.pop}
              onChange={(v) => update((p) => (p.captions.pop = v))} />
            <Toggle label="Outline" value={cfg.outline}
              onChange={(v) => update((p) => (p.captions.outline = v))} />
            <ColorInput label="Text color" value={cfg.color}
              onChange={(v) => update((p) => (p.captions.color = v))} />
            <ColorInput label="Spoken word" value={cfg.highlightColor}
              onChange={(v) => update((p) => (p.captions.highlightColor = v))} />
          </Section>
          <Section title={`Chunks (${chunks.length})`}>
            <Button
              onClick={() => {
                void api.saveText(
                  `${project.name || "captions"}.srt`,
                  "SubRip subtitles|*.srt",
                  toSrt(chunks, cfg.uppercase),
                );
              }}
            >
              Export .srt
            </Button>
            <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
              {chunks.map((c) => (
                <div key={`${c.start}-${c.words[0]?.text}`} className="flex items-center gap-1.5">
                  <button
                    className="shrink-0 font-mono text-[11px] text-slate-500 hover:text-indigo-300"
                    title="Jump here"
                    onClick={() => {
                      const s = useStore.getState();
                      if (!s.project || !s.meta || !s.events) return;
                      s.setTime(srcToOut(getDerived(s.project, s.meta, s.events).edl, c.start));
                    }}
                  >
                    {Math.floor(c.start / 60)}:{(c.start % 60).toFixed(1).padStart(4, "0")}
                  </button>
                  <input
                    className="min-w-0 flex-1 rounded border border-white/5 bg-black/20 px-1.5 py-0.5 text-[12px] text-slate-300 outline-none focus:border-indigo-500"
                    defaultValue={c.words.map((w) => w.text).join(" ")}
                    onBlur={(e) => {
                      const next = e.target.value.trim();
                      const orig = c.words.map((w) => w.text).join(" ");
                      if (next !== orig) replaceChunkText(c, next);
                    }}
                  />
                  <button
                    className="shrink-0 px-1 text-[12px] text-red-400/70 hover:text-red-300"
                    title="Delete chunk"
                    onClick={() => replaceChunkText(c, "")}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </Section>
        </>
      )}
    </>
  );
}

function AudioPanel() {
  const update = useStore((s) => s.update);
  const project = useStore((s) => s.project);
  if (!project) return null;
  const a = project.audio;
  return (
    <>
      <Section title="Microphone">
        <Toggle label="Muted" value={a.micMuted} onChange={(v) => update((p) => (p.audio.micMuted = v))} />
        <Slider label="Volume" value={a.micVolume} min={0} max={2} step={0.02}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => update((p) => (p.audio.micVolume = v))} />
        <Toggle label="Noise removal (at export)" value={a.denoise}
          onChange={(v) => update((p) => (p.audio.denoise = v))} />
      </Section>
      <Section title="Background music">
        <div className="flex items-center gap-2">
          <Button
            onClick={async () => {
              const dir = useStore.getState().projectDir;
              if (!dir) return;
              const file = await api.pickMusicFile(dir);
              if (file) update((p) => (p.audio.musicFile = file));
            }}
          >
            {a.musicFile ? "Replace music…" : "Add music…"}
          </Button>
          {a.musicFile && (
            <Button variant="danger" onClick={() => update((p) => (p.audio.musicFile = null))}>
              Remove
            </Button>
          )}
        </div>
        {a.musicFile && (
          <>
            <div className="truncate text-[11px] text-slate-600">{a.musicFile}</div>
            <Slider label="Music volume" value={a.musicVolume} min={0} max={1} step={0.02}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(v) => update((p) => (p.audio.musicVolume = v))} />
            <Toggle label="Auto-duck under voice" value={a.duck}
              onChange={(v) => update((p) => (p.audio.duck = v))} />
            {a.duck && (
              <Slider label="Duck to" value={a.duckAmount} min={0} max={0.8} step={0.05}
                format={(v) => `${Math.round(v * 100)}%`}
                onChange={(v) => update((p) => (p.audio.duckAmount = v))} />
            )}
            <div className="text-[11px] leading-relaxed text-slate-600">
              Ducking is applied at export; the preview plays music at a constant level.
            </div>
          </>
        )}
      </Section>
      <Section title="System audio">
        <Toggle label="Muted" value={a.sysMuted} onChange={(v) => update((p) => (p.audio.sysMuted = v))} />
        <Slider label="Volume" value={a.sysVolume} min={0} max={2} step={0.02}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => update((p) => (p.audio.sysVolume = v))} />
      </Section>
      <Section title="Export">
        <Toggle label="Loudness normalize (≈ −16 LUFS)" value={a.normalize}
          onChange={(v) => update((p) => (p.audio.normalize = v))} />
      </Section>
    </>
  );
}

function KeysPanel() {
  const update = useStore((s) => s.update);
  const project = useStore((s) => s.project);
  const meta = useStore((s) => s.meta);
  if (!project) return null;
  const k = project.keystrokes;
  return (
    <Section title="Keystroke overlay">
      <Toggle label="Show keystrokes" value={k.enabled}
        onChange={(v) => update((p) => (p.keystrokes.enabled = v))} />
      <Select label="Which keys" value={k.mode}
        options={[
          { value: "modifiers", label: "Shortcuts only" },
          { value: "all", label: "All keys" },
        ]}
        onChange={(v) => update((p) => (p.keystrokes.mode = v))} />
      <Select label="Position" value={k.position}
        options={[
          { value: "bottom", label: "Bottom" },
          { value: "top", label: "Top" },
        ]}
        onChange={(v) => update((p) => (p.keystrokes.position = v))} />
      <Select label="Theme" value={k.theme}
        options={[
          { value: "dark", label: "Dark" },
          { value: "light", label: "Light" },
        ]}
        onChange={(v) => update((p) => (p.keystrokes.theme = v))} />
      <Row label="Recorded as">
        <span className="text-[12px] text-slate-500">{meta?.keyPrivacyMode}</span>
      </Row>
    </Section>
  );
}
