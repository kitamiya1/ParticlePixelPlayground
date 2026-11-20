// プリセットの保存・読み込み（localStorage と JSON ファイル）。

import { BUILTIN_PRESETS, DEFAULT_SETTINGS, sanitizeSettings, type RenderSettings } from '../settings';

const KEY_USER = 'ppp.presets.v1';
const KEY_CURRENT = 'ppp.current.v1';

function readStore(key: string): unknown {
  try {
    const s = localStorage.getItem(key);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

function writeStore(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* 保存できない環境では無視 */
  }
}

export function userPresets(): Record<string, RenderSettings> {
  const raw = readStore(KEY_USER);
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, RenderSettings> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = sanitizeSettings(v);
  return out;
}

export function saveUserPreset(name: string, s: RenderSettings) {
  const all = userPresets();
  all[name] = { ...s };
  writeStore(KEY_USER, all);
}

export function deleteUserPreset(name: string) {
  const all = userPresets();
  delete all[name];
  writeStore(KEY_USER, all);
}

export function builtinPreset(name: string): RenderSettings {
  return sanitizeSettings({ ...DEFAULT_SETTINGS, ...BUILTIN_PRESETS[name] });
}

export function loadCurrent(): RenderSettings {
  return sanitizeSettings(readStore(KEY_CURRENT) ?? DEFAULT_SETTINGS);
}

export function saveCurrent(s: RenderSettings) {
  writeStore(KEY_CURRENT, s);
}

export function downloadJSON(name: string, s: RenderSettings) {
  const blob = new Blob([JSON.stringify({ name, settings: s }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `preset-${name || 'custom'}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function readJSONFile(file: File): Promise<{ name: string; settings: RenderSettings }> {
  const data = JSON.parse(await file.text());
  return { name: typeof data.name === 'string' ? data.name : file.name.replace(/\.json$/, ''), settings: sanitizeSettings(data.settings ?? data) };
}
