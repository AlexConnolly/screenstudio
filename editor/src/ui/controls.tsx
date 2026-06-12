import React from "react";
import { useStore } from "../state/store";

export function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-white/5 px-4 py-3">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
        {props.title}
      </div>
      <div className="space-y-2.5">{props.children}</div>
    </div>
  );
}

export function Row(props: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[13px] text-slate-400">{props.label}</span>
      {props.children}
    </div>
  );
}

export function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const beginEdit = useStore((s) => s.beginEdit);
  const endEdit = useStore((s) => s.endEdit);
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[13px] text-slate-400">{props.label}</span>
        <span className="font-mono text-[12px] text-slate-500">
          {props.format ? props.format(props.value) : props.value.toFixed(2)}
        </span>
      </div>
      <input
        type="range"
        className="w-full"
        min={props.min}
        max={props.max}
        step={props.step ?? 0.01}
        value={props.value}
        onPointerDown={beginEdit}
        onPointerUp={endEdit}
        onChange={(e) => props.onChange(parseFloat(e.target.value))}
      />
    </div>
  );
}

export function Toggle(props: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Row label={props.label}>
      <button
        onClick={() => props.onChange(!props.value)}
        className={`relative h-5 w-9 rounded-full transition-colors ${
          props.value ? "bg-indigo-500" : "bg-slate-700"
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
            props.value ? "left-[18px]" : "left-0.5"
          }`}
        />
      </button>
    </Row>
  );
}

export function Select<T extends string>(props: {
  label?: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  const select = (
    <select
      value={props.value}
      onChange={(e) => props.onChange(e.target.value as T)}
      className="rounded-md border border-white/10 bg-[#161a23] px-2 py-1 text-[13px] text-slate-200 outline-none focus:border-indigo-500"
    >
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
  return props.label ? <Row label={props.label}>{select}</Row> : select;
}

export function ColorInput(props: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <Row label={props.label}>
      <input
        type="color"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </Row>
  );
}

export function Button(props: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost" | "danger";
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  const variant = props.variant ?? "ghost";
  const styles = {
    primary: "bg-indigo-500 hover:bg-indigo-400 text-white",
    ghost: "bg-white/5 hover:bg-white/10 text-slate-200 border border-white/10",
    danger: "bg-red-500/15 hover:bg-red-500/25 text-red-300 border border-red-500/20",
  }[variant];
  return (
    <button
      title={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
      className={`rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${styles} ${props.className ?? ""}`}
    >
      {props.children}
    </button>
  );
}

export function formatTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const cs = Math.floor((t % 1) * 100);
  return `${m}:${s.toString().padStart(2, "0")}.${cs.toString().padStart(2, "0")}`;
}
