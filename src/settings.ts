// 描画パラメーター（UI から編集され、描画システムが毎フレーム参照する）。

export type ViewMode = 'particles' | 'mesh' | 'split' | 'compare';
export type Projection = 'ortho' | 'perspective';
/**
 * 描画方式 A: 既存のポイント描画 / B: Pixel Art Gaussian Splats（Spark） / C: サーフェル（不透明な円盤 + 深度） /
 * D: ボクセル（立方体の集合 + 深度） / E: ピクセル化メッシュ（通常のポリゴンメッシュを低解像度に描いて後処理） /
 * F: ハイブリッド（地形・岩・幹・キャラクターを E のメッシュ、草花・葉を C の円盤で、同じ深度バッファに描いて後処理を 1 回）
 */
export type RenderMethod = 'points' | 'splats' | 'surfels' | 'voxels' | 'pixelmesh' | 'hybrid';
export const RENDER_METHODS: RenderMethod[] = ['points', 'splats', 'surfels', 'voxels', 'pixelmesh', 'hybrid'];
/** 画面表示用の短い名前 */
export const METHOD_NAME: Record<RenderMethod, string> = { points: 'A：ポイント', splats: 'B：Gaussian Splats', surfels: 'C：サーフェル', voxels: 'D：ボクセル', pixelmesh: 'E：ピクセル化メッシュ', hybrid: 'F：Hybrid (E+C)' };
/** 方式の記号（ファイル名など） */
export const METHOD_LETTER: Record<RenderMethod, string> = { points: 'A', splats: 'B', surfels: 'C', voxels: 'D', pixelmesh: 'E', hybrid: 'F' };
/** 方式 F で幹・枝をどちらで描くか（mesh = E 側のメッシュ / surfel = C 側の円盤） */
export type HybridTrunk = 'mesh' | 'surfel';
/**
 * 方式 F の道・地面の配色（v2）。legacy = v1 と同じ（地形の網の頂点に点群の色を写すだけ。道に大きな色むらが出る）。
 * それ以外は地面を画素ごとに塗る（道は道の距離場 + 石畳の模様、草地は細かな色の揺らぎ）。
 */
export type HybridRoad = 'legacy' | 'cobble' | 'slate' | 'sandstone' | 'dirt';
export const HYBRID_ROADS: [HybridRoad, string][] = [
  ['legacy', '改善前（点群の色を写す）'],
  ['cobble', '石畳：灰（推奨）'],
  ['slate', '石畳：青灰・暗め'],
  ['sandstone', '石畳：砂岩（暖色）'],
  ['dirt', '土の小道（小石まじり）'],
];
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
  /** 左右比較の左・右に描く方式 */
  compareLeft: RenderMethod;
  compareRight: RenderMethod;
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
  // サーフェル（方式 C）
  surfelScale: number;
  surfelBillboard: boolean;
  // ボクセル（方式 D）
  /** 浮き島のボクセルの一辺（ワールド単位。変えると作り直す） */
  voxelSize: number;
  /** キャラクターのボクセルの一辺（変えると作り直す） */
  voxelCharSize: number;
  /** 草の粒を立体ボクセルにする割合（変えると作り直す） */
  voxelDecor: number;
  /** 花の粒を立体ボクセルにする（変えると作り直す） */
  voxelFlowers: boolean;
  /** 立方体の縁の暗さ */
  voxelEdge: number;
  /** 隅の遮蔽（AO）の強さ */
  voxelAO: number;
  /** カメラから見て裏向きの面の組を描かない */
  voxelCull: boolean;
  // ピクセル化メッシュ（方式 E）
  /** 樹木・岩の SDF を三角形にする格子の一辺（地形の網・キャラクターもこれに比例。変えると作り直す） */
  meshDetail: number;
  /** フラットシェーディング（三角形ごとの面の向きで陰影をつける） */
  meshFlat: boolean;
  /** 草の葉を描く割合（0..1。作り直さない） */
  meshGrass: number;
  // ハイブリッド（方式 F。形状の細かさ・フラットシェーディングは E、円盤の大きさ・密度は C の設定を共用）
  /** 幹・枝を E（メッシュ）と C（円盤）のどちらで描くか（変えると C 側の円盤を作り直す） */
  hybridTrunk: HybridTrunk;
  /** 道・地面の配色（legacy = v1 のまま） */
  hybridRoad: HybridRoad;
  /** 草の葉の表示密度（0..1。1 = v1 と同じ全部。房ではなく葉 1 枚単位で間引く。作り直さない） */
  hybridGrass: number;
  /** 草の根元の色を地面の色へ寄せる量（0 = v1） */
  hybridGrassBlend: number;
  /** 草の円盤の大きさ（C の「円盤の大きさ」に掛ける。1 = v1） */
  hybridGrassSize: number;
  /** 遠景で残す草の割合（1 = 間引かない = v1） */
  hybridGrassFar: number;
  /** 草地の地面の細かな色の揺らぎ（0 = v1。legacy 以外の配色で有効） */
  hybridGroundDetail: number;
  /** キャラクターの足元の草を押し倒す強さ（0 = v1） */
  hybridTrample: number;
  /** キャラクターの明るさの持ち上げと縁の光（0 = v1） */
  hybridCharLift: number;
  /** 足元の接地影（地面だけ。0 = v1。legacy 以外の配色で有効） */
  hybridContact: number;
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
  compareLeft: 'points',
  compareRight: 'splats',
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
  surfelScale: 1,
  surfelBillboard: false,
  voxelSize: 0.2,
  voxelCharSize: 0.06,
  voxelDecor: 0,
  voxelFlowers: true,
  voxelEdge: 0.15,
  voxelAO: 0.6,
  voxelCull: true,
  meshDetail: 0.14,
  meshFlat: false,
  meshGrass: 1,
  hybridTrunk: 'mesh',
  hybridRoad: 'cobble',
  hybridGrass: 0.7,
  hybridGrassBlend: 0.45,
  hybridGrassSize: 1,
  hybridGrassFar: 0.5,
  hybridGroundDetail: 0.5,
  hybridTrample: 0.8,
  hybridCharLift: 0.2,
  hybridContact: 0.5,
};

/** 方式 F の v1（改善前）の見た目を再現する値（プリセット「ハイブリッド：改善前（v1）」と比較撮影で使う） */
export const HYBRID_V1: Partial<RenderSettings> = {
  hybridRoad: 'legacy', hybridGrass: 1, hybridGrassBlend: 0, hybridGrassSize: 1, hybridGrassFar: 1,
  hybridGroundDetail: 0, hybridTrample: 0, hybridCharLift: 0, hybridContact: 0,
};

/** 方式 D の作り直しが必要な設定の選択肢（連続値にすると操作のたびに作り直しが走るため段階で選ぶ） */
export const VOXEL_SIZES = [0.1, 0.14, 0.2, 0.28, 0.4];
export const VOXEL_CHAR_SIZES = [0.04, 0.06, 0.08, 0.12];
export const VOXEL_DECOR_LEVELS = [0, 0.1, 0.25, 0.5, 1];
/** 方式 E の形状の細かさの選択肢（作り直しが必要なので段階で選ぶ） */
export const MESH_DETAILS = [0.2, 0.14, 0.1, 0.07];
/** 方式 E のキャラクターの格子の一辺（浮き島の細かさに比例） */
export function meshCharCell(detail: number): number {
  return Math.max(0.015, detail * 0.25);
}

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
  if (!RENDER_METHODS.includes(out.renderMethod)) out.renderMethod = DEFAULT_SETTINGS.renderMethod;
  if (!RENDER_METHODS.includes(out.compareLeft)) out.compareLeft = DEFAULT_SETTINGS.compareLeft;
  if (!RENDER_METHODS.includes(out.compareRight)) out.compareRight = DEFAULT_SETTINGS.compareRight;
  if (!['mesh', 'surfel'].includes(out.hybridTrunk)) out.hybridTrunk = DEFAULT_SETTINGS.hybridTrunk;
  if (!HYBRID_ROADS.some(([k]) => k === out.hybridRoad)) out.hybridRoad = DEFAULT_SETTINGS.hybridRoad;
  if (!['convert', 'sdf'].includes(out.splatSource)) out.splatSource = DEFAULT_SETTINGS.splatSource;
  // 方式 D の作り直しが必要な設定は選択肢の値だけ受け付ける（任意の値で極端に重い生成をさせない）
  if (!VOXEL_SIZES.includes(out.voxelSize)) out.voxelSize = DEFAULT_SETTINGS.voxelSize;
  if (!VOXEL_CHAR_SIZES.includes(out.voxelCharSize)) out.voxelCharSize = DEFAULT_SETTINGS.voxelCharSize;
  if (!VOXEL_DECOR_LEVELS.includes(out.voxelDecor)) out.voxelDecor = DEFAULT_SETTINGS.voxelDecor;
  if (!MESH_DETAILS.includes(out.meshDetail)) out.meshDetail = DEFAULT_SETTINGS.meshDetail;
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
  // 方式 C 用
  'サーフェル：標準': { renderMethod: 'surfels', surfelScale: 1, surfelBillboard: false },
  'サーフェル：隙間を埋める': { renderMethod: 'surfels', surfelScale: 1.4, surfelBillboard: false },
  // 方式 D 用
  'ボクセル：標準': { renderMethod: 'voxels', voxelSize: 0.2, voxelCharSize: 0.06, voxelDecor: 0, voxelFlowers: true, voxelEdge: 0.15, voxelAO: 0.6 },
  'ボクセル：細かい': { renderMethod: 'voxels', voxelSize: 0.1, voxelCharSize: 0.04, voxelDecor: 0.25, voxelFlowers: true, voxelEdge: 0, voxelAO: 0.5 },
  'ボクセル：粗いブロック': { renderMethod: 'voxels', voxelSize: 0.4, voxelCharSize: 0.08, voxelDecor: 0, voxelFlowers: false, voxelEdge: 0.3, voxelAO: 0.8 },
  // 方式 E 用
  'ピクセル化メッシュ：標準': { renderMethod: 'pixelmesh', meshDetail: 0.14, meshFlat: false, meshGrass: 1 },
  'ピクセル化メッシュ：ローポリ': { renderMethod: 'pixelmesh', meshDetail: 0.2, meshFlat: true, meshGrass: 0.5, lightSteps: 3, outline: 1 },
  'ピクセル化メッシュ：トゥーン': { renderMethod: 'pixelmesh', meshDetail: 0.14, meshFlat: false, lightSteps: 2, outline: 1, outlineThresh: 0.3, outlineDarken: 0.3, dither: 0.2 },
  // 方式 F 用
  'ハイブリッド：標準（幹は E）': { renderMethod: 'hybrid', meshDetail: 0.14, meshFlat: false, surfelScale: 1, hybridTrunk: 'mesh' },
  'ハイブリッド：幹も C': { renderMethod: 'hybrid', meshDetail: 0.14, meshFlat: false, surfelScale: 1, hybridTrunk: 'surfel' },
  'ハイブリッド：改善前（v1）': { renderMethod: 'hybrid', meshDetail: 0.14, meshFlat: false, surfelScale: 1, hybridTrunk: 'mesh', ...HYBRID_V1 },
};
