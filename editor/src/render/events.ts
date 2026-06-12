// Prepares the raw event log for rendering: clicks, cursor-type timeline,
// keystroke-overlay labels (§4.4).

import type { InputEvent, KeystrokeConfig } from "../types";

export interface Click {
  t: number; // seconds, source time
  x: number;
  y: number;
  b: number;
}

export interface KeyLabel {
  t: number;
  label: string;
}

export interface PreppedEvents {
  clicks: Click[];
  cursorTypes: Array<{ t: number; c: string }>;
  keyLabels: KeyLabel[];
}

const VK_NAMES: Record<number, string> = {
  8: "Backspace", 9: "Tab", 13: "Enter", 27: "Esc", 32: "Space",
  33: "PgUp", 34: "PgDn", 35: "End", 36: "Home",
  37: "←", 38: "↑", 39: "→", 40: "↓",
  45: "Ins", 46: "Del", 91: "Win", 92: "Win",
  186: ";", 187: "=", 188: ",", 189: "-", 190: ".", 191: "/",
  192: "`", 219: "[", 220: "\\", 221: "]", 222: "'",
};

function vkName(vk: number): string | null {
  if (vk >= 65 && vk <= 90) return String.fromCharCode(vk);
  if (vk >= 48 && vk <= 57) return String.fromCharCode(vk);
  if (vk >= 96 && vk <= 105) return `Num${vk - 96}`;
  if (vk >= 112 && vk <= 135) return `F${vk - 111}`;
  return VK_NAMES[vk] ?? null;
}

function isModifierVk(vk: number): boolean {
  return (vk >= 16 && vk <= 18) || (vk >= 160 && vk <= 165) || vk === 91 || vk === 92;
}

export function prepEvents(events: InputEvent[], keys: KeystrokeConfig): PreppedEvents {
  const clicks: Click[] = [];
  const cursorTypes: Array<{ t: number; c: string }> = [];
  const keyLabels: KeyLabel[] = [];

  for (const ev of events) {
    const t = ev.t / 1000;
    switch (ev.k) {
      case "down":
        clicks.push({ t, x: ev.x ?? 0, y: ev.y ?? 0, b: ev.b ?? 0 });
        break;
      case "cursor":
        cursorTypes.push({ t, c: ev.c ?? "arrow" });
        break;
      case "key": {
        if (ev.a !== 1) break;
        const vk = ev.vk ?? -1;
        if (vk < 0 || isModifierVk(vk)) break;
        const name = vkName(vk);
        if (!name) break;
        const mods = (ev.mods ?? "")
          .split("+")
          .filter(Boolean)
          .map((m) => ({ ctrl: "Ctrl", shift: "Shift", alt: "Alt", win: "Win" })[m] ?? m);
        const hasRealMods = mods.some((m) => m === "Ctrl" || m === "Alt" || m === "Win");
        if (keys.mode === "modifiers" && !hasRealMods) break; // privacy default (§4.4)
        keyLabels.push({ t, label: [...mods, name].join(" + ") });
        break;
      }
    }
  }
  return { clicks, cursorTypes, keyLabels };
}

export function cursorTypeAt(prepped: PreppedEvents, t: number): string {
  let type = "arrow";
  for (const c of prepped.cursorTypes) {
    if (c.t > t) break;
    type = c.c;
  }
  return type;
}

/** Most recent keystroke label still visible at time t (1.6 s hold). */
export function keyLabelAt(prepped: PreppedEvents, t: number): { label: string; age: number } | null {
  let found: KeyLabel | null = null;
  for (const k of prepped.keyLabels) {
    if (k.t > t) break;
    if (t - k.t < 1.6) found = k;
  }
  return found ? { label: found.label, age: t - found.t } : null;
}
