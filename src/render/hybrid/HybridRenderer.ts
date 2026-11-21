// 描画方式 F：ハイブリッド（E のピクセル化メッシュ + C のサーフェル）。Spark には依存しない。
// - E 側（三角形メッシュ）：地形・道・岩・島の下面・雲・キャラクター、幹・枝（設定で C 側へ切り替え可）。
//   樹冠は三角形化しない（MeshBuild の hybrid オプション）。草の葉・花の帯や星形の円盤も GPU へ上げない。
// - C 側（法線を向いた不透明な円盤）：草・花・つた（カテゴリ「草花」）と樹木の葉（「樹木」のうち風で揺れる粒）。
//   幹を C 側にしたときは「樹木」の粒をすべて円盤にする。
// - 両方を **同じ低解像度ターゲット・同じ深度バッファ** に続けて描くので、草花・葉と地形・岩・キャラクターの前後関係は
//   画素ごとの深度テストで決まる（別々に描いて重ねる合成ではない）。後処理（輪郭・ディザ・減色・拡大）もこの 1 枚に 1 回だけかける。
// - 光・影・風・霞は E・C とも同じ GLSL（LIGHTING_CHUNK）と同じ共有ユニフォームなので、陰影の段階・霞も揃う。
// v2（画質改善）：
// - 地面：地形の網を画素ごとに塗るマテリアル（道の距離場 + 石畳の模様・草地の細かな明暗・接地影）。配色はプリセット（hybridRoad）。
//   legacy は v1 と同じ worldMat（頂点に点群の色を写すだけ）。
// - 草：C 側を「草の葉」と「それ以外（花・つた・木の葉）」の 2 層に分ける。草の層は葉 1 枚単位の順位の昇順に並べ、
//   密度（hybridGrass）・根元の色合わせ・足元の押し倒し・遠景の間引きを持つ。花・つた・木の葉は間引かない。
// - キャラクター：明るさの持ち上げ（hybridCharLift）。
// 改善前と同じ見た目は HYBRID_V1 の値（legacy・密度 1・ほかは 0 / 1）で再現できる。

import * as THREE from 'three';
import { fbm2, hex, type RGB } from '../../core/math';
import type { HybridRoad, RenderSettings } from '../../settings';
import type { Terrain } from '../../world/Terrain';
import type { CharacterRig } from '../CharacterRig';
import type { SharedUniforms } from '../ParticleMaterial';
import { PixelPipeline } from '../PixelPipeline';
import type { PixelMeshCharacter, PixelMeshWorld } from '../pixelmesh/MeshBuild';
import { PixelMeshRenderer, type GroundField } from '../pixelmesh/PixelMeshRenderer';
import { pointSetFromGeometry, type SplatPointSet } from '../shared/PointSet';
import { SurfelRenderer } from '../surfel/SurfelRenderer';

/**
 * C 側で描く粒を取り出す（既存の粒データから）。
 * - fixed：花・つた（「草花」のうち草の葉でない粒）と木の葉（「樹木」のうち風で揺れる粒）。trunk=true なら幹・枝も。
 *   並びは生成時のシャッフル順のままなので、全体の密度は先頭から N 個で間引ける。
 * - grass：草の葉の粒を葉の順位（ParticleBuilder の grassRank）の昇順に並べたもの。先頭から N 個で葉 1 枚単位に間引ける。
 */
export interface HybridSurfelSets {
  fixed: SplatPointSet;
  grass: SplatPointSet;
  grassRanks: Float32Array;
}

export function hybridSurfelSets(world: THREE.BufferGeometry, trunk: boolean): HybridSurfelSets {
  const rank = world.userData.grassRank as Float32Array | undefined;
  const isGrass = (i: number) => !!rank && rank[i] >= 0;
  const fixed = pointSetFromGeometry(world, [], (cat, wind, i) => (cat === '草花' && !isGrass(i)) || (cat === '樹木' && (trunk || wind > 0)));
  const ranks: number[] = [];
  const raw = pointSetFromGeometry(world, [], (cat, _w, i) => {
    if (cat !== '草花' || !isGrass(i)) return false;
    ranks.push(rank![i]);
    return true;
  });
  const order = ranks.map((_, i) => i).sort((a, b) => ranks[a] - ranks[b]);
  return { fixed, grass: permute(raw, order), grassRanks: Float32Array.from(order, (i) => ranks[i]) };
}

function permute(src: SplatPointSet, order: number[]): SplatPointSet {
  const n = order.length;
  const out: SplatPointSet = { count: n, pos: new Float32Array(n * 3), col: new Uint8Array(n * 3), nrm: new Float32Array(n * 3), size: new Float32Array(n), wind: new Float32Array(n), sun: new Float32Array(n) };
  order.forEach((i, o) => {
    for (let k = 0; k < 3; k++) {
      out.pos[o * 3 + k] = src.pos[i * 3 + k];
      out.col[o * 3 + k] = src.col[i * 3 + k];
      out.nrm[o * 3 + k] = src.nrm[i * 3 + k];
    }
    out.size[o] = src.size[i];
    out.wind[o] = src.wind[i];
    out.sun[o] = src.sun[i];
  });
  return out;
}

/**
 * 地面用の距離場：道の符号付き距離（R、-2..2 を 0..255）と草の多さ（G。粒の草むらの生成と同じ fbm）を
 * 上から見た格子（一辺 cell）に焼く。地面の画素ごとの塗り分けに使う。
 */
export function buildGroundField(t: Terrain, cell = 0.125): GroundField {
  const ext = t.cfg.radius * 1.12;
  const w = Math.ceil((ext * 2) / cell) + 1;
  const data = new Uint8Array(w * w * 4);
  for (let j = 0; j < w; j++) {
    for (let i = 0; i < w; i++) {
      const x = -ext + i * cell, z = -ext + j * cell;
      const sd = t.pathSignedDistance(x, z);
      const meadow = fbm2(x * 0.09, z * 0.09, 3, 51) * 0.5 + 0.5;
      const o = (j * w + i) * 4;
      data[o] = Math.max(0, Math.min(255, Math.round(((sd + 2) / 4) * 255)));
      data[o + 1] = Math.max(0, Math.min(255, Math.round(meadow * 255)));
      data[o + 3] = 255;
    }
  }
  // テクセル中心が格子点に来るよう、範囲を半セル広げる
  const size = w * cell;
  return { data, w, h: w, min: [-ext - cell / 2, -ext - cell / 2], size: [size, size] };
}

/** 道の配色プリセット（石 3 色・目地・土・苔、[石の細かさ, 目地の幅, 土のセルの割合, 石の明るさのばらつき]、石の縁の傾き） */
interface RoadLook {
  stones: [string, string, string];
  mortar: string;
  dirt: string;
  moss: string;
  road: [number, number, number, number];
  relief: number;
}
export const ROAD_LOOKS: Record<Exclude<HybridRoad, 'legacy'>, RoadLook> = {
  // 既定パレット（草原 38 色）は灰色が 4 段しかなく、太陽の暖色で明るい灰色が黄土色・水色に寄るので、石は少し青みのある中間の灰色にする
  cobble: { stones: ['#8a8a93', '#7c7c86', '#94939b'], mortar: '#4a4248', dirt: '#94643a', moss: '#4f7a38', road: [2.2, 0.075, 0.06, 0.16], relief: 0.55 },
  slate: { stones: ['#6c7385', '#5f6678', '#78808f'], mortar: '#36323e', dirt: '#7e5a3c', moss: '#46703a', road: [2.7, 0.07, 0.03, 0.14], relief: 0.6 },
  sandstone: { stones: ['#b0906c', '#a2845f', '#bb9d78'], mortar: '#6a4e36', dirt: '#94643a', moss: '#5c7f3a', road: [1.8, 0.08, 0.08, 0.14], relief: 0.55 },
  dirt: { stones: ['#8a8a93', '#7c7c86', '#94939b'], mortar: '#6a4a30', dirt: '#94643a', moss: '#5a7f3a', road: [3.4, 0.1, 0.82, 0.2], relief: 0.5 },
};

/** 草の根元を寄せる地面の色（粒の地形の草の 4 色の平均に近い色） */
const GROUND_TONE: RGB = hex('#609f46');

export interface HybridStats {
  meshTris: number;
  surfels: number;
  /** C 側の円盤の内訳（総数） */
  surfelTotal: number;
  surfelBuildMs: number;
  trunk: 'mesh' | 'surfel';
}

export class HybridRenderer {
  /** E 側（地形・岩・幹・キャラクター） */
  readonly mesh: PixelMeshRenderer;
  /** C 側（花・つた・木の葉。幹を C にしたときは幹も）。作り直し中は null */
  surfel: SurfelRenderer | null = null;
  /** C 側の草の層（葉 1 枚単位で間引ける） */
  grass: SurfelRenderer | null = null;
  /** 方式 F 専用の低解像度ターゲットと後処理（E と C の両方をここに描く） */
  readonly pipeline = new PixelPipeline();
  private surfelKey = '';
  surfelBuildMs = 0;
  surfelRebuilds = 0;
  private disposed = false;
  drawnTris = 0;
  drawnSurfels = 0;
  /** 草の層で描いた円盤の数（drawnSurfels に含む。遠景の間引きでつぶした分も数える） */
  drawnGrass = 0;

  constructor(private readonly shared: SharedUniforms, private readonly rig: CharacterRig) {
    this.mesh = new PixelMeshRenderer(shared, rig);
  }

  setWorld(data: PixelMeshWorld) {
    this.mesh.setWorld(data, { decor: false });
  }

  setCharacter(data: PixelMeshCharacter) {
    this.mesh.setCharacter(data);
  }

  /** 地面用の距離場を渡す（地形を画素ごとに塗るのに使う） */
  setGroundField(f: GroundField) {
    this.mesh.setGroundField(f);
  }

  /** C 側の円盤を用意する（key が変わったときだけ作り直す。前のものは GPU から解放する） */
  setSurfels(key: string, make: () => HybridSurfelSets) {
    if (key === this.surfelKey && this.surfel) return;
    this.surfelKey = key;
    this.surfel?.dispose();
    this.grass?.dispose();
    // 構築時間 = 粒の取り出し（初回のみ。以後は CPU 側の保持分を使う）+ GPU 用の属性の用意
    const t0 = performance.now();
    const sets = make();
    this.surfel = new SurfelRenderer(this.shared, this.rig, sets.fixed, null);
    this.grass = new SurfelRenderer(this.shared, this.rig, sets.grass, null, sets.grassRanks);
    this.surfelBuildMs = performance.now() - t0;
    this.surfelRebuilds++;
  }

  get stats(): HybridStats | null {
    if (!this.surfel) return null;
    return { meshTris: this.drawnTris, surfels: this.drawnSurfels, surfelTotal: this.surfel.worldTotal + (this.grass?.worldTotal ?? 0), surfelBuildMs: this.surfelBuildMs, trunk: this.mesh.trunksVisible ? 'mesh' : 'surfel' };
  }

  update(s: RenderSettings, rig: CharacterRig, densityComp: number, lowW: number, lowH: number) {
    this.mesh.trunksVisible = s.hybridTrunk === 'mesh';
    this.applyGround(s);
    this.mesh.charLift = s.hybridCharLift;
    this.mesh.update(s, rig);
    this.drawnTris = this.mesh.drawnTris;
    this.drawnSurfels = 0;
    this.drawnGrass = 0;
    if (this.surfel) {
      this.surfel.update(s, rig, densityComp, lowW, lowH);
      this.drawnSurfels = this.surfel.drawn;
    }
    if (this.grass) {
      const g = this.grass.grassU;
      g.uGroundTone.value.set(GROUND_TONE[0], GROUND_TONE[1], GROUND_TONE[2]);
      g.uGrassBlend.value = s.hybridGrassBlend;
      g.uTrample.value = s.hybridTrample;
      g.uGrassFar.value = s.hybridGrassFar;
      this.grass.grassSize = s.hybridGrassSize;
      this.grass.update(s, rig, densityComp, lowW, lowH, s.hybridGrass);
      this.drawnGrass = this.grass.drawn;
      this.drawnSurfels += this.grass.drawn;
    }
  }

  /** 地面の配色プリセットをユニフォームへ（legacy なら地形は v1 と同じマテリアルで描く） */
  private applyGround(s: RenderSettings) {
    this.mesh.groundActive = s.hybridRoad !== 'legacy';
    if (s.hybridRoad === 'legacy') return;
    const look = ROAD_LOOKS[s.hybridRoad];
    const u = this.mesh.groundU;
    const v3 = (t: THREE.Vector3, c: string) => {
      const [r, g, b] = hex(c);
      t.set(r, g, b);
    };
    v3(u.uStone0.value, look.stones[0]);
    v3(u.uStone1.value, look.stones[1]);
    v3(u.uStone2.value, look.stones[2]);
    v3(u.uMortar.value, look.mortar);
    v3(u.uDirt.value, look.dirt);
    v3(u.uMoss.value, look.moss);
    u.uRoad.value.set(...look.road);
    u.uRelief.value = look.relief;
    u.uGroundDetail.value = s.hybridGroundDetail;
    u.uContact.value = s.hybridContact;
  }

  /** 低解像度ターゲットへ E → C（花・葉 → 草）の順に描く（2 回目以降はクリアしないので、深度バッファを共有する） */
  renderScene(renderer: THREE.WebGLRenderer, camera: THREE.Camera, canvasW: number, canvasH: number, scale: number) {
    this.pipeline.ensureSize(canvasW, canvasH, scale);
    this.pipeline.renderScene(renderer, this.mesh.scene, camera);
    if (this.surfel) {
      renderer.setRenderTarget(this.pipeline.rt);
      renderer.render(this.surfel.scene, camera);
      if (this.grass) renderer.render(this.grass.scene, camera);
      renderer.setRenderTarget(null);
    }
  }

  /** 重ね塗り計測：E と C の断片数を同じターゲットに足し合わせる */
  renderCount(renderer: THREE.WebGLRenderer, camera: THREE.Camera, target: THREE.WebGLRenderTarget) {
    this.mesh.renderCount(renderer, camera, target, true);
    this.surfel?.renderCount(renderer, camera, target, false);
    this.grass?.renderCount(renderer, camera, target, false);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh.dispose();
    this.surfel?.dispose();
    this.surfel = null;
    this.grass?.dispose();
    this.grass = null;
    this.pipeline.dispose();
  }
}
