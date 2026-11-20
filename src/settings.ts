// 描画パラメーター（UI から編集され、描画システムが毎フレーム参照する）。

export type ViewMode = 'particles' | 'mesh' | 'split' | 'compare';
export type Projection = 'ortho' | 'perspective';
/** 描画方式 A: 既存のポイント描画 / B: Pixel Art Gaussian Splats（Spark） */
export type RenderMethod = 'points' | 'splats';
/** スプラットの形状ソース: 既存の粒データを変換 / 樹木・岩・キャラクターを SDF から生成 */
export type SplatSource = 'convert' | 'sdf';

export interface RenderSettings {
  // 解像度・粒
  pixelScale: number;
  pointSize: number;
  density: number;
  densityComp: boolean;
  pointSnap: boolean;
  // ガウス濃淡
  gaussShade: number;
  gaussSharp: number;
  alphaCut: number;
  alphaDither: boolean;
  // 色・ディザ
  palette: string;
  colorLevels: number;
  dither: number;
  ditherMatrix: number;
  // 輪郭
  outline: number;
  outlineThresh: number;
  outlineDarken: number;
  // 光と環境
  lightSteps: number;
  ambient: number;
  shadowStrength: number;
  wind: number;
  fog: number;
  // カメラ
  projection: Projection;
  fov: number;
  cameraSnap: boolean;
  // 表示
  viewMode: ViewMode;
  renderMethod: RenderMethod;
  // Gaussian Splats（方式 B）
  splatSource: SplatSource;
  splatScale: number;
  splatFlat: number;
  splatAniso: number;
  splatFalloff: number;
  splatStdDev: number;
  splatCrisp: boolean;
  splatCoverage: number;
  splatSupersample: number;
  splatOpacity: number;
}

export const DEFAULT_SETTINGS: RenderSettings = {
  pixelScale: 3,
  pointSize: 1,
  density: 1,
  densityComp: true,
  pointSnap: true,
  gaussShade: 0.45,
  gaussSharp: 2.2,
  alphaCut: 0.22,
  alphaDither: true,
  palette: 'meadow32',
  colorLevels: 6,
  dither: 0.35,
  ditherMatrix: 4,
  outline: 0.85,
  outlineThresh: 0.6,
  outlineDarken: 0.45,
  lightSteps: 4,
  ambient: 0.7,
  shadowStrength: 0.8,
  wind: 1,
  fog: 0.6,
  projection: 'ortho',
  fov: 35,
  cameraSnap: true,
  viewMode: 'particles',
  renderMethod: 'points',
  splatSource: 'convert',
  splatScale: 1,
  splatFlat: 0.2,
  splatAniso: 1,
  splatFalloff: 0.15,
  splatStdDev: 2.4,
  splatCrisp: true,
  splatCoverage: 0.5,
  splatSupersample: 2,
  splatOpacity: 1,
};

export function cloneSettings(s: RenderSettings): RenderSettings {
  return { ...s };
}

/** 不正・欠損値を既定値で補う（古いプリセットの読み込み対策） */
export function sanitizeSettings(raw: unknown): RenderSettings {
  const out = cloneSettings(DEFAULT_SETTINGS);
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(out) as (keyof RenderSettings)[]) {
    const v = r[key];
    if (v === undefined) continue;
    if (typeof v === typeof out[key]) (out as unknown as Record<string, unknown>)[key] = v;
  }
  // 列挙値は既知のものだけ受け付ける
  if (!['particles', 'mesh', 'split', 'compare'].includes(out.viewMode)) out.viewMode = DEFAULT_SETTINGS.viewMode;
  if (!['points', 'splats'].includes(out.renderMethod)) out.renderMethod = DEFAULT_SETTINGS.renderMethod;
  if (!['convert', 'sdf'].includes(out.splatSource)) out.splatSource = DEFAULT_SETTINGS.splatSource;
  return out;
}

export const BUILTIN_PRESETS: Record<string, Partial<RenderSettings>> = {
  '標準': {},
  'くっきりドット': { pixelScale: 4, gaussShade: 0.25, gaussSharp: 1.4, alphaCut: 0.12, lightSteps: 3, outline: 1, outlineDarken: 0.35, dither: 0.3 },
  'やわらか粒子': { pixelScale: 2, gaussShade: 0.9, gaussSharp: 3.4, alphaCut: 0.3, palette: 'none', dither: 0.15, outline: 0.35, lightSteps: 0, pointSize: 1.15 },
  'レトロ4色': { pixelScale: 4, palette: 'green4', dither: 0.85, ditherMatrix: 4, outline: 1, lightSteps: 3 },
  '夕暮れパレット': { palette: 'dusk16', dither: 0.6, ditherMatrix: 8, lightSteps: 4, fog: 0.8 },
  'まばらな粒': { density: 0.35, densityComp: false, pointSize: 0.8, gaussShade: 0.8, outline: 0.5, palette: 'none', dither: 0.2 },
  '高解像度': { pixelScale: 1, pointSize: 0.85, palette: 'none', dither: 0.1, outline: 0.4, lightSteps: 0 },
  // 方式 B 用（renderMethod を含むプリセットは方式も切り替える）
  'スプラット：くっきりドット': { renderMethod: 'splats', pixelScale: 4, splatFalloff: 0, splatCrisp: true, splatCoverage: 0.5, splatScale: 1, splatFlat: 0.2, outline: 1, outlineDarken: 0.4, dither: 0.3, lightSteps: 3 },
  'スプラット：やわらかガウス': { renderMethod: 'splats', pixelScale: 2, splatFalloff: 1, splatCrisp: false, splatScale: 1.25, splatFlat: 0.6, splatStdDev: 2.8, palette: 'none', dither: 0.15, outline: 0.3, lightSteps: 0 },
  'スプラット：SDF生成': { renderMethod: 'splats', splatSource: 'sdf', splatFalloff: 0.15, splatCrisp: true },
};
