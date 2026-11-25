// 水槽の見た目の生成（CPU 側。Three.js に依存しない）。方式 F v2 の分担に合わせて 2 種類を作る。
// - E 側（三角形メッシュ。MeshBuild の MeshBuilder / surfaceNets を共有）：
//   底床（高さ場の網 + ガラス際の断面）・小石・岩（洞窟を含む SDF）・流木・水槽の枠・部屋・カニ。
//   水槽台・底板と天板・濾過槽の中身・部屋の家具は AquariumStandBuild（buildAquariumMeshes から呼ぶ）。
// - C 側（法線を向いた不透明な円盤。SurfelRenderer にそのまま渡せる SplatPointSet）：
//   水草（テープ状の葉・有茎草・前景の絨毯草）・流木と岩の苔・陸地の苔・シダ・葉の広い草・汀線の細い草。
// 色は頂点 / 円盤ごとに持ち、照明の当たり（日照）は AquariumWorld.sunVisibility を粗い格子に焼いて写す。
// 穴掘り：底床の三角形（ガラス際の断面の帯も、接する区画へ）は 1×1 の区画（DIG.chunk）ごとに並べて範囲を記録し
// （terrainChunks）、掘った区画は描画側で隠して buildDigChunk（掘った後の砂の SDF を Surface Nets で三角形にしたもの。
// ガラスに接する区画は断面も）に差し替える。小石の範囲（pebbleList）と
// 植物の円盤の根元（anchors）も記録し、根元の砂が無くなったものを描画側で消す。

import { clamp, fbm2, hash2, hex, lerp, mixRGB, mulberry32, noise2, noise3, smoothstep, type RGB, type Rng } from '../core/math';
import { MeshBuilder, surfaceNets, type TriMesh } from '../render/pixelmesh/MeshBuild';
import type { SplatPointSet } from '../render/shared/PointSet';
import { sampleSdfSurface, sdCapsule, sdEllipsoid, smin, type Box3Like, type Sdf } from '../visual/sdf/sdf';
import type { Find } from './AquariumSpots';
import { LAMP_DIR, TANK, type AquariumWorld } from './AquariumWorld';
import { buildStandMeshes, SLEEVE_PAD } from './AquariumStandBuild';
import { DIG, type DigView } from './AquariumDig';
import { crabParts } from './crabModel';

const u8 = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));

// ---------------- 日照の格子 ----------------

/** 照明の当たり（日照）を粗い 3D 格子に焼いたもの。頂点・円盤ごとに追跡すると重いので補間して使う */
export class LightGrid {
  private readonly cell = 0.7;
  private readonly n: [number, number, number];
  private readonly min: [number, number, number] = [TANK.minX, TANK.floorY, TANK.minZ];
  private readonly v: Float32Array;

  constructor(world: AquariumWorld) {
    const c = this.cell;
    this.n = [Math.ceil((TANK.maxX - TANK.minX) / c) + 1, Math.ceil((TANK.topY + 1 - TANK.floorY) / c) + 1, Math.ceil((TANK.maxZ - TANK.minZ) / c) + 1];
    const [nx, ny, nz] = this.n;
    this.v = new Float32Array(nx * ny * nz);
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const x = this.min[0] + i * c, y = this.min[1] + j * c, z = this.min[2] + k * c;
      // 固体の中の格子点は、表面の外側へ少し出した位置で測る（表面の頂点の補間が暗くなりすぎない）
      let px = x, py = y, pz = z;
      const d = world.solid(px, py, pz);
      if (d < 0.15) {
        const nn = world.solidNormal(px, py, pz);
        const push = 0.15 - d;
        px += nn[0] * push;
        py += nn[1] * push;
        pz += nn[2] * push;
      }
      this.v[(k * ny + j) * nx + i] = world.sunVisibility(px, py, pz);
    }
  }

  sample(x: number, y: number, z: number): number {
    const [nx, ny, nz] = this.n;
    const fx = clamp((x - this.min[0]) / this.cell, 0, nx - 1.001);
    const fy = clamp((y - this.min[1]) / this.cell, 0, ny - 1.001);
    const fz = clamp((z - this.min[2]) / this.cell, 0, nz - 1.001);
    const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
    const u = fx - i, v = fy - j, w = fz - k;
    const g = (a: number, b: number, c: number) => this.v[((k + c) * ny + (j + b)) * nx + (i + a)];
    const l = (b: number, c: number) => lerp(g(0, b, c), g(1, b, c), u);
    return lerp(lerp(l(0, 0), l(1, 0), v), lerp(l(0, 1), l(1, 1), v), w);
  }
}

// ---------------- E 側：メッシュ ----------------

/** 底床の三角形の、区画ごとの範囲（頂点番号の配列の開始位置と数。区画番号 = j × ncx + i） */
export interface TerrainChunks {
  ncx: number;
  ncz: number;
  start: Uint32Array;
  count: Uint32Array;
}

/** 小石 1 個の頂点の範囲と大きさ（掘って下の砂が無くなったら消す） */
export interface PebbleInfo {
  x: number;
  y: number;
  z: number;
  /** 底の高さ */
  bottom: number;
  v0: number;
  vn: number;
}

export interface AquariumMeshes {
  terrain: TriMesh;
  terrainChunks: TerrainChunks;
  pebbleList: PebbleInfo[];
  pebbles: TriMesh;
  rocks: TriMesh;
  woods: TriMesh;
  frame: TriMesh;
  room: TriMesh;
  /** 水槽台・濾過槽の中身・底板と天板・部屋の家具（AquariumStandBuild） */
  stand: TriMesh;
  /** 水槽台の外側の面（箱庭カメラで透かす） */
  cabinetOuter: TriMesh;
  /** 台の中の照明（自ら光る） */
  emissive: TriMesh;
}

const SAND = { light: hex('#dccba0'), mid: hex('#c5b085'), dark: hex('#a48f6a'), gravel: hex('#8a7b62'), wet: hex('#8c7656'), wetDark: hex('#66533e') };
const SOIL = { top: hex('#4a3a2a'), moss: hex('#3b5529'), deep: hex('#5b4431'), gravel: hex('#3a322b') };

/** 地表の色（高さと場所から。水中の砂・汀線の濡れた砂・陸地の土） */
export function groundColor(world: AquariumWorld, x: number, z: number, h: number): RGB {
  const wl = TANK.waterY;
  const n1 = noise2(x * 0.9, z * 0.9, 3) * 0.5 + 0.5;
  const n2 = noise2(x * 3.1, z * 3.1, 4) * 0.5 + 0.5;
  let c = mixRGB(SAND.mid, SAND.light, n1 * 0.8 + n2 * 0.2);
  // 岩の根元・奥側は砂利まじりで暗め
  const near = world.solid(x, h + 0.35, z);
  c = mixRGB(c, SAND.gravel, (1 - smoothstep(0.1, 0.9, near)) * 0.55);
  c = mixRGB(c, SAND.dark, smoothstep(-2, -9, z) * 0.3 * n2);
  // 汀線：水面の少し下から上は濡れて暗い
  const wet = smoothstep(wl - 0.5, wl - 0.05, h);
  c = mixRGB(c, SAND.wet, wet * 0.7);
  c = mixRGB(c, SAND.wetDark, smoothstep(wl - 0.05, wl + 0.25, h) * 0.8);
  // 陸地：土と苔
  const land = smoothstep(wl + 0.25, wl + 0.7, h);
  const soil = mixRGB(SOIL.top, SOIL.moss, smoothstep(-0.2, 0.4, fbm2(x * 0.4, z * 0.4, 2, 7)));
  return mixRGB(c, soil, land);
}

/** ガラス際の断面の色（層状の底床：下の大粒の砂利 → 砂の層 → 陸地は土） */
export function strataColor(x: number, y: number, z: number, top: number): RGB {
  const wl = TANK.waterY;
  if (y < 0.3 + noise2(x * 2, z * 2, 8) * 0.08) return SOIL.gravel;
  const band = Math.sin(y * 9 + noise2(x * 0.7, z * 0.7, 9) * 3) * 0.5 + 0.5;
  const sand = mixRGB(SAND.mid, SAND.dark, band * 0.5);
  if (top < wl + 0.3) return y > top - 0.12 ? SAND.mid : sand;
  // 陸地の下：上は土、下は砂
  const soilDepth = 1.2 + noise2(x * 0.5, z * 0.5, 10) * 0.4;
  if (y > top - soilDepth) return mixRGB(SOIL.deep, SOIL.top, smoothstep(top - soilDepth, top, y) * 0.7);
  return sand;
}

function buildTerrain(world: AquariumWorld, light: LightGrid): { mesh: TriMesh; chunks: TerrainChunks } {
  const mb = new MeshBuilder();
  const step = 0.2;
  const nx = Math.round((TANK.maxX - TANK.minX) / step) + 1;
  const nz = Math.round((TANK.maxZ - TANK.minZ) / step) + 1;
  const ids = new Int32Array(nx * nz);
  // 縦の管が砂を貫く所は、管の外周に沿った丸い穴にする：穴の円の内側に入った格子点を円周まで押し出し（inHole）、
  // 3 点とも押し出した三角形と、押し出しで裏返った三角形は張らない。穴の縁は砂の断面の円筒（sandSleeve）と同じ半径
  const holes = world.stand.columns.map((c) => ({ x: c.x, z: c.z, r: c.r + SLEEVE_PAD }));
  const inHole = new Uint8Array(nx * nz);
  const gx0 = new Float32Array(nx * nz), gz0 = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      let x = TANK.minX + i * step, z = TANK.minZ + j * step;
      for (const c of holes) {
        const dx = x - c.x, dz = z - c.z, r = Math.hypot(dx, dz);
        if (r >= c.r) continue;
        inHole[j * nx + i] = 1;
        // 中心ちょうどの点は、どの三角形でも 3 点とも穴の中なので使われない
        if (r > 1e-6) {
          x = c.x + (dx / r) * c.r;
          z = c.z + (dz / r) * c.r;
        }
      }
      gx0[j * nx + i] = x;
      gz0[j * nx + i] = z;
      const h = world.groundAt(x, z);
      const [gx, gy, gz] = world.groundNormal(x, z);
      const c = groundColor(world, x, z, h);
      const sun = light.sample(x, h + 0.1, z);
      // 洞窟や岩の根元のくぼみを少し暗く（距離関数 1 回の簡易な遮蔽）
      const ao = 0.72 + 0.28 * smoothstep(0.05, 0.5, world.solid(x, h + 0.4, z));
      const grain = h < TANK.waterY ? 0.75 : 0.5;
      ids[j * nx + i] = mb.vertex(x, h, z, gx, gy, gz, u8(c[0] * ao), u8(c[1] * ao), u8(c[2] * ao), sun, grain);
    }
  }
  // 穴の縁の三角形：3 点とも穴の円周上なら張らない。押し出しで向き（上から見た回り方）が変わった・ほぼつぶれたものも張らない
  const holeTri = (p: number, q: number, r: number) => {
    if (inHole[p] + inHole[q] + inHole[r] === 0) return true;
    if (inHole[p] && inHole[q] && inHole[r]) return false;
    const area = (gx0[q] - gx0[p]) * (gz0[r] - gz0[p]) - (gz0[q] - gz0[p]) * (gx0[r] - gx0[p]);
    // 格子のままの三角形の外積は +step²（上から見て同じ回り方）。押し出し後に同じ向きで 2% 以上残るものだけ張る
    return area > 0.02 * step * step;
  };
  // ガラス際の断面（地表から水槽の底まで。ガラス越しに層が見える）：4 辺の頂点の列を先に作り、隣の列とつなぐ帯を
  // その帯の真ん中が入る区画（ガラスに接する区画）へ割り当てる。区画の範囲に断面も入るので、掘った区画を隠すと
  // そこの断面も隠れ、buildDigChunk が作るガラスの面（穴の開いた断面）に置き換わる
  const CH = Math.round(DIG.chunk / step);
  const ncx = Math.ceil((nx - 1) / CH), ncz = Math.ceil((nz - 1) / CH);
  const wallCols = (pts: [number, number][], nxo: number, nzo: number) => {
    const cols: number[][] = [];
    for (const [x, z] of pts) {
      const top = world.groundAt(x, z);
      const K = Math.max(2, Math.ceil((top - TANK.floorY) / 0.15));
      const col: number[] = [];
      for (let q = 0; q <= K; q++) {
        const y = top + ((TANK.floorY - top) * q) / K;
        const c = strataColor(x, y, z, top);
        col.push(mb.vertex(x, y, z, nxo, 0.8, nzo, u8(c[0]), u8(c[1]), u8(c[2]), 0.9, 0.6));
      }
      cols.push(col);
    }
    return { cols, nxo, nzo };
  };
  const xs: [number, number][] = [], xs2: [number, number][] = [], zs: [number, number][] = [], zs2: [number, number][] = [];
  for (let i = 0; i < nx; i++) {
    const x = TANK.minX + i * step;
    xs.push([x, TANK.maxZ]);
    xs2.push([x, TANK.minZ]);
  }
  for (let j = 0; j < nz; j++) {
    const z = TANK.minZ + j * step;
    zs.push([TANK.maxX, z]);
    zs2.push([TANK.minX, z]);
  }
  // 辺ごとの列と、帯 a（列 a と a + 1 の間）が入る区画の番号
  const sides = [
    { ...wallCols(xs, 0, 1), chunkOf: (a: number) => (ncz - 1) * ncx + Math.floor(a / CH) },
    { ...wallCols(xs2, 0, -1), chunkOf: (a: number) => Math.floor(a / CH) },
    { ...wallCols(zs, 1, 0), chunkOf: (a: number) => Math.floor(a / CH) * ncx + ncx - 1 },
    { ...wallCols(zs2, -1, 0), chunkOf: (a: number) => Math.floor(a / CH) * ncx },
  ];
  const wallBands = new Map<number, [number, number][]>();
  sides.forEach((S, si) => {
    for (let a = 0; a < S.cols.length - 1; a++) {
      const id = S.chunkOf(a);
      let l = wallBands.get(id);
      if (!l) wallBands.set(id, (l = []));
      l.push([si, a]);
    }
  });
  const band = (si: number, a: number) => {
    const { cols, nxo, nzo } = sides[si];
    const A = cols[a], B = cols[a + 1];
    const K = Math.max(A.length, B.length) - 1;
    for (let q = 0; q < K; q++) {
      const a0 = A[Math.min(q, A.length - 1)], a1 = A[Math.min(q + 1, A.length - 1)];
      const b0 = B[Math.min(q, B.length - 1)], b1 = B[Math.min(q + 1, B.length - 1)];
      mb.tri(a0, a1, b1, nxo, 0, nzo);
      mb.tri(a0, b1, b0, nxo, 0, nzo);
    }
  };
  // 区画（穴掘りの単位）ごとにまとめて並べ、範囲を記録する（掘った区画だけ隠せるように）。ガラスに接する区画は断面の帯も
  const chunks: TerrainChunks = { ncx, ncz, start: new Uint32Array(ncx * ncz), count: new Uint32Array(ncx * ncz) };
  for (let cj = 0; cj < ncz; cj++) for (let ci = 0; ci < ncx; ci++) {
    const s0 = mb.indexCount;
    for (let j = cj * CH; j < Math.min((cj + 1) * CH, nz - 1); j++) {
      for (let i = ci * CH; i < Math.min((ci + 1) * CH, nx - 1); i++) {
        const ia = j * nx + i, ib = ia + 1, ic = ia + nx, id = ic + 1;
        const a = ids[ia], b = ids[ib], c = ids[ic], d = ids[id];
        if (holeTri(ia, ib, id)) mb.tri(a, b, d, 0, 1, 0);
        if (holeTri(ia, id, ic)) mb.tri(a, d, c, 0, 1, 0);
      }
    }
    for (const [si, a] of wallBands.get(cj * ncx + ci) ?? []) band(si, a);
    chunks.start[cj * ncx + ci] = s0;
    chunks.count[cj * ncx + ci] = mb.indexCount - s0;
  }
  return { mesh: mb.finish(), chunks };
}

/**
 * 掘った区画の断面（ガラスの面）を置く所：ガラスの内側の面から内側へこの距離。高さ場の網の断面（ガラスの内側の面ちょうど）より
 * わずかに奥なので、隣の掘っていない区画と重なる半マスでは網の断面が手前に描かれる（重なりのちらつきが出ない）
 */
const GLASS_FACE = 0.015;

/**
 * 掘った区画（i, j）の砂を三角形にする：高さ場 − 空洞（AquariumWorld.sandSolid と同じ値）を Surface Nets（格子 DIG.cell）で。
 * - 標本の範囲は区画 + 1 マス外側まで（隣の区画・高さ場の網と半マス重なり、継ぎ目に隙間ができない）。
 *   標本の位置は水槽全体で共通の格子に揃える（隣の掘った区画と重なる所の頂点が同じ位置になる）。
 * - 縦の範囲は、区画の地表のいちばん低い所・空洞のいちばん低い所の少し下から、地表のいちばん高い所の少し上まで。
 *   下端の標本はすべて砂の中・上端はすべて水（空気）の中なので、箱の上下に余計な面はできない。
 * - ガラスに接する区画（水槽の縁の区画）は、砂をガラスの内側の面（GLASS_FACE）で切り、水槽の底の少し下から作る：
 *   高さ場の網の断面（buildTerrain が同じ区画の範囲に入れている）の代わりに、穴の開いた断面がこの区画の三角形になる
 *   （ガラス際まで掘った穴を外から見られる）。断面の頂点は網の断面と同じ色・向き・明るさ。
 *   空洞・地表より十分下の断面（平らな面だけの所）は Surface Nets を使わず同じ格子の頂点・四角形を並べる（stripCap。
 *   角の区画を除く）。区画の作り直しの時間は、空洞の距離関数（AquariumDig.carve）の評価がほとんどを占める。
 * - 色：掘っていない地表は高さ場の網と同じ色・法線・日照（継ぎ目で色が変わらない）。掘った面は断面と同じ地層の色にして、
 *   元の地表より深いほど暗く・日が当たらなくする（トンネルの中は薄暗いが、環境光で見える）。
 * - 空洞の形は view の版（作り直し中は 'snap'。AquariumDigFx が全区画を同時に差し替えてから当たり判定へ commit する）。
 */
export function buildDigChunk(world: AquariumWorld, light: LightGrid, i: number, j: number, view: DigView = 'live'): TriMesh {
  const mb = new MeshBuilder();
  const dig = world.dig;
  const h = DIG.cell;
  const per = Math.round(DIG.chunk / h);
  const I0 = i * per - 1, K0 = j * per - 1;
  const n = per + 3;
  // ガラスに接する区画：砂をガラスの内側の面（の GLASS_FACE 内側）で切り、断面（ガラスの面）も同じ Surface Nets で作る。
  // 穴がガラスまで届いた所は面に穴が開き、その周りには地層の断面が残る。断面は水槽の底の少し下まで（底板に隠れる）
  const edge = i === 0 || j === 0 || i === dig.ncx - 1 || j === dig.ncz - 1;
  const glassIn = (x: number, z: number) => Math.min(x - TANK.minX, TANK.maxX - x, z - TANK.minZ, TANK.maxZ - z);
  const ox = TANK.minX + I0 * h, oz = TANK.minZ + K0 * h;
  // 標本の列ごとの地表の高さと法線の y（solid と同じ式）
  const H = new Float32Array(n * n), NY = new Float32Array(n * n);
  let gMin = Infinity, gMax = -Infinity;
  for (let k = 0; k < n; k++) for (let q = 0; q < n; q++) {
    const x = TANK.minX + (I0 + q) * h, z = TANK.minZ + (K0 + k) * h;
    const g = world.groundAt(x, z);
    H[k * n + q] = g;
    NY[k * n + q] = world.groundNormal(x, z)[1];
    gMin = Math.min(gMin, g);
    gMax = Math.max(gMax, g);
  }
  const cMin = dig.chunkMinY(dig.chunkId(i, j), view);
  const lo = edge ? TANK.floorY - 0.25 : Math.max(TANK.floorY, Math.min(gMin, cMin) - 0.3);
  // ガラスに接する区画の、空洞のいちばん低い所より十分下（空洞の値が必ず下限 PAD になる所）：空洞を調べずに砂と面だけで決める
  // （断面は水槽の底まであるので、その大半を占める空洞の下の部分を安くする。符号と面の近くの値は空洞を調べたときと同じ）
  const deepY = cMin - 0.6;
  const y0 = TANK.floorY + Math.floor((lo - TANK.floorY) / h) * h;
  const ny = Math.ceil((gMax + 0.3 - y0) / h) + 1;
  // ガラスの 1 面だけに接する区画（角の区画を除く）：断面の下の部分（空洞・地表より十分下で、砂の中に平らな断面だけがある所）は
  // Surface Nets を使わず、Surface Nets が作るのと同じ格子の頂点・四角形を並べる（cut 行目の格子点まで。stripCap）。
  // Surface Nets は cut 行目から上だけ（掘って形が変わりうる高さ）。cut 行目の格子点は、断面の 1 列目（ガラスの面から 1 マス）で
  // 砂の値が −0.1 以下（面が必ずガラスの面の GLASS_FACE 内側を通る）・すべての列で砂の中になる所まで
  const corner = (i === 0 || i === dig.ncx - 1) && (j === 0 || j === dig.ncz - 1);
  let cut = 0;
  if (edge && !corner) {
    let top = cMin - 0.45;
    for (let q = 0; q < n * n; q++) top = Math.min(top, H[q] - 0.1 / Math.max(NY[q], 0.1));
    cut = Math.max(0, Math.floor((top - h - y0) / h));
    if (cut < 4) cut = 0;
  }
  const yb = y0 + cut * h;
  const box: Box3Like = { min: [ox, yb, oz], max: [ox + (n - 1 - 1e-3) * h, y0 + (ny - 1 - 1e-3) * h, oz + (n - 1 - 1e-3) * h] };
  const sdf: Sdf = (x, y, z) => {
    const fq = (x - ox) / h, fk = (z - oz) / h;
    const q = Math.round(fq), k = Math.round(fk);
    let g: number, nyv: number;
    if (q >= 0 && q < n && k >= 0 && k < n && Math.abs(fq - q) < 1e-6 && Math.abs(fk - k) < 1e-6) {
      g = H[k * n + q];
      nyv = NY[k * n + q];
    } else {
      // Surface Nets の間引きの判定（ブロックの中心）が箱の外に出たときだけ
      g = world.groundAt(x, z);
      nyv = world.groundNormal(x, z)[1];
    }
    if (edge) {
      // ガラスの面の外の格子点：符号（外）だけが要る（頂点・法線はガラスの面と 1 列目の間のセルの隅の値だけで決まる）
      const cap = GLASS_FACE - glassIn(x, z);
      if (cap > GLASS_FACE) return cap;
      if (y < deepY) return Math.max((y - g) * nyv, cap);
      return Math.max(dig.meshValue((y - g) * nyv, x, y, z, view), cap);
    }
    return dig.meshValue((y - g) * nyv, x, y, z, view);
  };
  const wl = TANK.waterY;
  const vert = (x: number, y: number, z: number, nx: number, nyy: number, nz: number): number => {
    const g = world.groundAt(x, z);
    const depth = g - y;
    if (edge) {
      // ガラスの面（断面）：高さ場の網の断面（buildTerrain）と同じ色・向き・明るさ。面の外向き（ガラスの側）を向いた頂点だけ
      // （ガラスに接するトンネルの床・壁の頂点は、下の掘った面の色にする）
      const e = glassIn(x, z);
      if (e < GLASS_FACE + 0.06) {
        const ox = x - TANK.minX === e ? -1 : TANK.maxX - x === e ? 1 : 0;
        const oz = ox !== 0 ? 0 : z - TANK.minZ === e ? -1 : 1;
        const l = Math.hypot(nx, nyy, nz) || 1;
        if ((nx * ox + nz * oz) / l > 0.7) {
          const c = strataColor(x, Math.min(y, g), z, g);
          return mb.vertex(x, y, z, ox, 0.8, oz, u8(c[0]), u8(c[1]), u8(c[2]), 0.9, 0.6);
        }
      }
    }
    const cv = dig.carve(x, y, z, view);
    if (depth < 0.05 && cv > 0.2) {
      // 掘っていない地表：高さ場の網と同じ
      const [gx, gy, gz] = world.groundNormal(x, z);
      const c = groundColor(world, x, z, g);
      const ao = 0.72 + 0.28 * smoothstep(0.05, 0.5, world.solid(x, g + 0.4, z));
      return mb.vertex(x, g, z, gx, gy, gz, u8(c[0] * ao), u8(c[1] * ao), u8(c[2] * ao), light.sample(x, g + 0.1, z), g < wl ? 0.75 : 0.5);
    }
    const l = Math.hypot(nx, nyy, nz) || 1;
    const nn = [nx / l, nyy / l, nz / l];
    // 掘った面：地層の色（縁の近くは地表の色へなじませる）。湿って少し暗い
    const top = groundColor(world, x, z, g);
    const st = strataColor(x, Math.min(y, g - 0.13), z, g);
    let c = mixRGB(top, st, smoothstep(0.02, 0.25, depth));
    c = mixRGB(c, SAND.wetDark, 0.12);
    const cover = smoothstep(0.08, 0.75, depth);
    const ao = 0.6 + 0.4 * smoothstep(0.0, 0.35, world.solid(x + nn[0] * 0.35, y + nn[1] * 0.35, z + nn[2] * 0.35));
    const k = ao * (1 - 0.34 * cover);
    const sun = light.sample(x + nn[0] * 0.15, y + nn[1] * 0.15, z + nn[2] * 0.15) * (1 - 0.88 * cover);
    return mb.vertex(x, y, z, nx, nyy, nz, u8(c[0] * k), u8(c[1] * k), u8(c[2] * k), sun, 0.7);
  };
  surfaceNets(sdf, box, h, mb, vert, true);
  if (cut > 0) stripCap(mb, vert, i === 0 ? 'minX' : i === dig.ncx - 1 ? 'maxX' : j === 0 ? 'minZ' : 'maxZ', ox, oz, y0, h, n, cut);
  return mb.finish();
}

/**
 * ガラスに接する区画の断面の下の部分（buildDigChunk の cut 行目まで）：Surface Nets が平らな断面に作るのと同じ頂点・四角形。
 * 断面の格子（ガラスの面と 1 列目の格子点の間のセル）の頂点は、面に沿った向き・高さの向きにセルの中心、面からは GLASS_FACE 内側
 * （1 列目の砂の値が −0.085 以下なら、Surface Nets の辺の交点は必ずここ）。四角形は高さ 1〜cut 行目・面に沿った 1〜n − 2 列目の
 * 格子点のまわり（Surface Nets が箱の中の 4 つのセルで張るのと同じ）。cut 行目のセルの頂点は Surface Nets の側にも同じ位置にあり、
 * 継ぎ目は同じ位置の頂点どうしでつながる。頂点の色は vert（Surface Nets と同じ関数）で決める
 */
function stripCap(mb: MeshBuilder, vert: (x: number, y: number, z: number, nx: number, ny: number, nz: number) => number, side: 'minX' | 'maxX' | 'minZ' | 'maxZ', ox: number, oz: number, y0: number, h: number, n: number, cut: number) {
  const alongX = side === 'minZ' || side === 'maxZ';
  const out: [number, number] = side === 'minX' ? [-1, 0] : side === 'maxX' ? [1, 0] : side === 'minZ' ? [0, -1] : [0, 1];
  const face = side === 'minX' ? TANK.minX + GLASS_FACE : side === 'maxX' ? TANK.maxX - GLASS_FACE : side === 'minZ' ? TANK.minZ + GLASS_FACE : TANK.maxZ - GLASS_FACE;
  const o = alongX ? ox : oz;
  const cols = n - 1;
  const id = new Int32Array((cut + 1) * cols);
  for (let r = 0; r <= cut; r++) for (let q = 0; q < cols; q++) {
    const s = o + (q + 0.5) * h, y = y0 + (r + 0.5) * h;
    id[r * cols + q] = alongX ? vert(s, y, face, 0, 0, out[1]) : vert(face, y, s, out[0], 0, 0);
  }
  for (let r = 1; r <= cut; r++) for (let q = 1; q < cols; q++) {
    const a = id[(r - 1) * cols + q - 1], b = id[r * cols + q - 1], c = id[r * cols + q], d = id[(r - 1) * cols + q];
    mb.tri(a, b, c, out[0], 0, out[1]);
    mb.tri(a, c, d, out[0], 0, out[1]);
  }
}

/** 小石：低ポリゴンの楕円体（正二十面体を 1 回分割）を砂の上に散らす */
function buildPebbles(world: AquariumWorld, light: LightGrid, rng: Rng): { mesh: TriMesh; list: PebbleInfo[] } {
  const mb = new MeshBuilder();
  const list: PebbleInfo[] = [];
  const ico = icosphere();
  const colors = ['#a29d94', '#e2ddd3', '#a2805e', '#77716a', '#c9b08a', '#bdb7ad', '#8a7058'].map(hex);
  let placed = 0;
  for (let tries = 0; tries < 6000 && placed < 520; tries++) {
    // 岩の根元・汀線のあたりに多く
    const x = lerp(TANK.minX + 0.4, 8.5, rng()), z = lerp(TANK.minZ + 0.4, TANK.maxZ - 0.4, rng());
    const h = world.groundAt(x, z);
    if (h > TANK.waterY + 0.35) continue;
    const near = world.solid(x, h + 0.3, z);
    const want = 0.18 + (1 - smoothstep(0.2, 1.6, near)) * 0.6 + (1 - smoothstep(0, 1.2, Math.abs(h - TANK.waterY))) * 0.4 + (z > 6 ? 0.15 : 0);
    if (rng() > want) continue;
    if (near < 0.15) continue;
    if (world.pipeClear(x, z) < 0.15) continue;
    const r = 0.05 + Math.pow(rng(), 2.2) * 0.14;
    const rx = r * (0.8 + rng() * 0.5), ry = r * (0.45 + rng() * 0.3), rz = r * (0.8 + rng() * 0.5);
    const rot = rng() * Math.PI * 2;
    const cr = Math.cos(rot), sr = Math.sin(rot);
    const base = colors[Math.floor(rng() * colors.length)];
    const cy = h + ry * 0.35;
    const sun = light.sample(x, cy + 0.1, z);
    const vid: number[] = [];
    list.push({ x, y: cy, z, bottom: cy - ry, v0: mb.vertexCount, vn: ico.pos.length });
    for (const [px, py, pz] of ico.pos) {
      const bump = 1 + noise3(px * 2 + x, py * 2, pz * 2 + z, 77) * 0.12;
      const lx = px * rx * bump, ly = py * ry * bump, lz = pz * rz * bump;
      const wx = x + lx * cr - lz * sr, wz = z + lx * sr + lz * cr;
      const nx = (px / rx) * cr - (pz / rz) * sr, nz = (px / rx) * sr + (pz / rz) * cr;
      const shade = 0.85 + 0.15 * py;
      vid.push(mb.vertex(wx, cy + ly, wz, nx, py / ry, nz, u8(base[0] * shade), u8(base[1] * shade), u8(base[2] * shade), sun, 0.3));
    }
    for (const [a, b, c] of ico.tris) mb.triByNormals(vid[a], vid[b], vid[c]);
    placed++;
  }
  return { mesh: mb.finish(), list };
}

function icosphere(): { pos: [number, number, number][]; tris: [number, number, number][] } {
  const t = (1 + Math.sqrt(5)) / 2;
  let pos: [number, number, number][] = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
  let tris: [number, number, number][] = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  const norm = (p: number[]): [number, number, number] => {
    const l = Math.hypot(p[0], p[1], p[2]);
    return [p[0] / l, p[1] / l, p[2] / l];
  };
  pos = pos.map(norm);
  const mid = new Map<string, number>();
  const m = (a: number, b: number) => {
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    let i = mid.get(key);
    if (i === undefined) {
      i = pos.push(norm([(pos[a][0] + pos[b][0]) / 2, (pos[a][1] + pos[b][1]) / 2, (pos[a][2] + pos[b][2]) / 2])) - 1;
      mid.set(key, i);
    }
    return i;
  };
  const next: [number, number, number][] = [];
  for (const [a, b, c] of tris) {
    const ab = m(a, b), bc = m(b, c), ca = m(c, a);
    next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
  }
  tris = next;
  return { pos, tris };
}

const STONE = [hex('#7a746c'), hex('#8f8981'), hex('#655f59'), hex('#a39c92')];
const ALGAE = hex('#5d6b45');
const ROCK_MOSS = hex('#4d6b32');
const WET_STONE = hex('#4f4a45');

function buildRocks(world: AquariumWorld, light: LightGrid): TriMesh {
  const mb = new MeshBuilder();
  for (const r of world.rocks) {
    surfaceNets(r.sdf, r.box, 0.12, mb, (x, y, z, nx, ny, nz) => {
      const l = Math.hypot(nx, ny, nz) || 1;
      const n = [nx / l, ny / l, nz / l];
      const s1 = noise3(x * 0.8, y * 0.8, z * 0.8, r.seed + 1) * 0.5 + 0.5;
      // 層状の縞（堆積岩らしく水平に）
      const band = Math.sin(y * 6.5 + noise3(x * 0.6, y * 0.6, z * 0.6, r.seed) * 2.5) * 0.5 + 0.5;
      let c = mixRGB(STONE[0], STONE[1], s1);
      c = mixRGB(c, band > 0.75 ? STONE[3] : STONE[2], Math.abs(band - 0.5) * 0.6);
      const wl = TANK.waterY;
      if (y < wl) c = mixRGB(c, ALGAE, Math.max(0, n[1]) * 0.45 + 0.1);
      else c = mixRGB(c, ROCK_MOSS, smoothstep(0.45, 0.85, n[1]) * smoothstep(-0.3, 0.3, noise3(x * 1.3, y * 1.3, z * 1.3, r.seed + 3)) * 0.7);
      c = mixRGB(c, WET_STONE, (1 - smoothstep(0.05, 0.4, Math.abs(y - wl - 0.1))) * 0.6);
      const ox = x + n[0] * 0.12, oy = y + n[1] * 0.12, oz = z + n[2] * 0.12;
      const ao = 0.62 + 0.38 * smoothstep(0.0, 0.35, world.solid(x + n[0] * 0.35, y + n[1] * 0.35, z + n[2] * 0.35));
      return mb.vertex(x, y, z, nx, ny, nz, u8(c[0] * ao), u8(c[1] * ao), u8(c[2] * ao), light.sample(ox, oy, oz), 0.6);
    });
  }
  return mb.finish();
}

const BARK = [hex('#4e3a2a'), hex('#6e5139'), hex('#8a6a4a')];

function buildWoods(world: AquariumWorld, light: LightGrid): TriMesh {
  const mb = new MeshBuilder();
  const { logA, logB } = world.landmarks;
  for (const w of world.woods) {
    // 中空の倒木の内壁は暗く（節穴から差す光と、明るい出口との対比を付ける）
    const hollow = w.name === 'hollowlog' ? w.holes[0] : null;
    surfaceNets(w.sdf, w.box, 0.06, mb, (x, y, z, nx, ny, nz) => {
      const l = Math.hypot(nx, ny, nz) || 1;
      const n = [nx / l, ny / l, nz / l];
      const g = noise3(x * 4, y * 4, z * 4, w.seed) * 0.5 + 0.5;
      let c = mixRGB(BARK[0], BARK[1], g);
      if (g > 0.72) c = mixRGB(c, BARK[2], 0.6);
      if (y < TANK.waterY) c = mixRGB(c, hex('#3f4a30'), 0.25 + Math.max(0, n[1]) * 0.25);
      if (hollow) {
        const r = sdCapsule(x, y, z, hollow.a[0], hollow.a[1], hollow.a[2], hollow.b[0], hollow.b[1], hollow.b[2], 0);
        // 口から 0.9 以上奥ほど暗い（口の近くは外の光が回り込む）
        const ax = logB[0] - logA[0], az = logB[2] - logA[2], al = Math.hypot(ax, az);
        const t = ((x - logA[0]) * ax + (z - logA[2]) * az) / al;
        const deep = smoothstep(0.2, 1.3, Math.min(t, al - t));
        if (r < 0.7) c = mixRGB(c, hex('#1e1712'), 0.55 * deep);
      }
      const ao = 0.7 + 0.3 * smoothstep(0, 0.3, world.solid(x + n[0] * 0.3, y + n[1] * 0.3, z + n[2] * 0.3));
      return mb.vertex(x, y, z, nx, ny, nz, u8(c[0] * ao), u8(c[1] * ao), u8(c[2] * ao), light.sample(x + n[0] * 0.15, y + n[1] * 0.15, z + n[2] * 0.15), 0.5);
    });
  }
  return mb.finish();
}

/** 直方体（outward = false なら内向き：部屋の壁） */
function addBox(mb: MeshBuilder, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, colorOf: (face: string) => RGB, sun = 1, outward = true) {
  const s = outward ? 1 : -1;
  const face = (name: string, p: [number, number, number][], n: [number, number, number]) => {
    const c = colorOf(name);
    const ids = p.map((q) => mb.vertex(q[0], q[1], q[2], n[0] * s, n[1] * s, n[2] * s, u8(c[0]), u8(c[1]), u8(c[2]), sun, 0.15));
    mb.tri(ids[0], ids[1], ids[2], n[0] * s, n[1] * s, n[2] * s);
    mb.tri(ids[0], ids[2], ids[3], n[0] * s, n[1] * s, n[2] * s);
  };
  face('top', [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], [0, 1, 0]);
  face('bottom', [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0]);
  face('front', [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1]);
  face('back', [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], [0, 0, -1]);
  face('right', [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], [1, 0, 0]);
  face('left', [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]], [-1, 0, 0]);
}

/** 水槽の枠（上縁・下の縁・角のシリコン）。底板・台の天板・台の箱は AquariumStandBuild（管の穴・中の濾過槽があるため） */
function buildFrame(): TriMesh {
  const mb = new MeshBuilder();
  const g = TANK.glass;
  const black = hex('#17191d');
  const x0 = TANK.minX - g, x1 = TANK.maxX + g, z0 = TANK.minZ - g, z1 = TANK.maxZ + g;
  const k = () => black;
  // 下の縁（ガラスの外を囲む）と底板
  const bh = 0.55, bw = 0.3;
  addBox(mb, x0 - bw, -0.35, z1 - 0.05, x1 + bw, bh - 0.35, z1 + bw, k);
  addBox(mb, x0 - bw, -0.35, z0 - bw, x1 + bw, bh - 0.35, z0 + 0.05, k);
  addBox(mb, x0 - bw, -0.35, z0, x0 + 0.05, bh - 0.35, z1, k);
  addBox(mb, x1 - 0.05, -0.35, z0, x1 + bw, bh - 0.35, z1, k);
  // 上縁
  const ty = TANK.topY, th = 0.32, tw = 0.36;
  addBox(mb, x0 - 0.04, ty - th, z1 - tw + g, x1 + 0.04, ty + 0.04, z1 + 0.04, k);
  addBox(mb, x0 - 0.04, ty - th, z0 - 0.04, x1 + 0.04, ty + 0.04, z0 + tw - g, k);
  addBox(mb, x0 - 0.04, ty - th, z0, x0 + tw - g, ty + 0.04, z1, k);
  addBox(mb, x1 - tw + g, ty - th, z0, x1 + 0.04, ty + 0.04, z1, k);
  // 角のシリコン（細い縦の帯）
  const sil = hex('#2a3032');
  for (const [cx, cz] of [[TANK.minX, TANK.minZ], [TANK.maxX, TANK.minZ], [TANK.minX, TANK.maxZ], [TANK.maxX, TANK.maxZ]]) {
    addBox(mb, cx - 0.09, TANK.floorY, cz - 0.09, cx + 0.09, ty - th, cz + 0.09, () => sil);
  }
  return mb.finish();
}

/** 部屋（内向きの箱）：床・壁・天井。水槽の外の背景で、ガラス越しの奥行きの基準になる */
function buildRoom(): TriMesh {
  const mb = new MeshBuilder();
  // 薄暗い部屋（照明の当たる水槽が浮き立つよう、パレットにある暗い色そのまま）
  const floor = hex('#452e22'), wall = hex('#5c4f47'), wallBack = hex('#3a3230'), ceil = hex('#5c4f47');
  addBox(mb, -80, -12, -42, 80, 48, 80, (f) => (f === 'bottom' ? floor : f === 'top' ? ceil : f === 'back' ? wallBack : wall), 0.7, false);
  // 床の板目（細い帯）
  for (let i = -8; i <= 8; i++) addBox(mb, i * 10 - 0.08, -11.99, -42, i * 10 + 0.08, -11.97, 80, () => hex('#2a1d17'), 0.7);
  return mb.finish();
}

export function buildAquariumMeshes(world: AquariumWorld): { meshes: AquariumMeshes; light: LightGrid; ms: Record<string, number> } {
  const ms: Record<string, number> = {};
  let t = performance.now();
  const lap = (k: string) => {
    const n = performance.now();
    ms[k] = n - t;
    t = n;
  };
  const light = new LightGrid(world);
  lap('light');
  const rng = mulberry32(42);
  const { mesh: terrain, chunks: terrainChunks } = buildTerrain(world, light);
  lap('terrain');
  const { mesh: pebbles, list: pebbleList } = buildPebbles(world, light, rng);
  lap('pebbles');
  const rocks = buildRocks(world, light);
  lap('rocks');
  const woods = buildWoods(world, light);
  lap('woods');
  const frame = buildFrame();
  const room = buildRoom();
  const st = buildStandMeshes(world);
  lap('frame');
  return { meshes: { terrain, terrainChunks, pebbleList, pebbles, rocks, woods, frame, room, stand: st.stand, cabinetOuter: st.cabinetOuter, emissive: st.emissive }, light, ms };
}

/** カニ：部位の SDF をボーンごとに三角形にする（頂点はボーンのローカル座標） */
export function buildCrabMesh(): TriMesh {
  const mb = new MeshBuilder();
  for (const part of crabParts()) {
    surfaceNets(part.sdf, part.box, part.cell, mb, (x, y, z, nx, ny, nz) => {
      const l = Math.hypot(nx, ny, nz) || 1;
      const c = part.color(x, y, z, nx / l, ny / l, nz / l);
      return mb.vertex(x, y, z, nx, ny, nz, u8(c[0]), u8(c[1]), u8(c[2]), 1, part.grain, part.bone);
    });
  }
  return mb.finish(true);
}

// ---------------- C 側：サーフェル ----------------

class PointsOut {
  pos: number[] = [];
  col: number[] = [];
  nrm: number[] = [];
  size: number[] = [];
  wind: number[] = [];
  sun: number[] = [];
  /** 根元（砂に植わっている所）。掘って根元の砂が無くなった円盤を消すのに使う。NaN = 岩・流木の上（消さない） */
  anc: number[] = [];
  private ax = NaN;
  private ay = NaN;
  private az = NaN;
  constructor(private readonly light: LightGrid) {}
  /** これから足す円盤の根元（植物 1 本・1 株ごとに決める） */
  anchor(x: number, y: number, z: number) {
    this.ax = x;
    this.ay = y;
    this.az = z;
  }
  noAnchor() {
    this.ax = this.ay = this.az = NaN;
  }
  push(x: number, y: number, z: number, c: RGB, nx: number, ny: number, nz: number, size: number, wind: number, sunBias = 0) {
    const l = Math.hypot(nx, ny, nz) || 1;
    this.anc.push(this.ax, this.ay, this.az);
    this.pos.push(x, y, z);
    this.col.push(u8(c[0]), u8(c[1]), u8(c[2]));
    this.nrm.push(nx / l, ny / l, nz / l);
    this.size.push(size);
    this.wind.push(wind);
    this.sun.push(clamp(this.light.sample(x, y, z) + sunBias, 0.05, 1));
  }
  get count() {
    return this.size.length;
  }
  toSet(rng: Rng): { set: SplatPointSet; anchors: Float32Array } {
    // シャッフル（先頭から N 個描けば全体から均一に間引ける。SurfelRenderer の密度と同じ前提）
    const n = this.count;
    const order = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const out: SplatPointSet = { count: n, pos: new Float32Array(n * 3), col: new Uint8Array(n * 3), nrm: new Float32Array(n * 3), size: new Float32Array(n), wind: new Float32Array(n), sun: new Float32Array(n) };
    const anchors = new Float32Array(n * 3);
    order.forEach((i, o) => {
      for (let k = 0; k < 3; k++) {
        anchors[o * 3 + k] = this.anc[i * 3 + k];
        out.pos[o * 3 + k] = this.pos[i * 3 + k];
        out.col[o * 3 + k] = this.col[i * 3 + k];
        out.nrm[o * 3 + k] = this.nrm[i * 3 + k];
      }
      out.size[o] = this.size[i];
      out.wind[o] = this.wind[i];
      out.sun[o] = this.sun[i];
    });
    return { set: out, anchors };
  }
}

/** テープ状の葉の水草（バリスネリアのような細長い葉が水面近くまで伸びる） */
/** 水草の森の細い通路・小部屋を空けておく幅（植物を置かない） */
const PATH_CLEAR = 0.5;

function tapeGrass(P: PointsOut, world: AquariumWorld, rng: Rng, cx: number, cz: number, radius: number, blades: number) {
  const cols = [hex('#3f7434'), hex('#55913f'), hex('#79b252'), hex('#9cc66a')];
  for (let b = 0; b < blades; b++) {
    const a = rng() * Math.PI * 2, rr = Math.sqrt(rng()) * radius;
    const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
    if (world.forestPathDist(x, z) < PATH_CLEAR) continue;
    if (world.pipeClear(x, z) < 0.35) continue;
    const g = world.groundAt(x, z);
    if (world.solid(x, g + 0.1, z) < 0.05) continue;
    const depth = TANK.waterY - g;
    if (depth < 0.8) continue;
    P.anchor(x, g, z);
    const H = Math.min(depth - 0.15, depth * (0.55 + rng() * 0.5));
    const lean = rng() * Math.PI * 2, leanAmt = 0.2 + rng() * 0.35;
    const twist0 = rng() * Math.PI, twistRate = (rng() - 0.5) * 2.2;
    const w = 0.075 + rng() * 0.03;
    const steps = Math.ceil(H / 0.045);
    for (let s = 0; s <= steps; s++) {
      const f = s / steps;
      const bx = x + Math.cos(lean) * leanAmt * f * f * H * 0.35;
      const bz = z + Math.sin(lean) * leanAmt * f * f * H * 0.35;
      const by = g + f * H;
      const tw = twist0 + twistRate * f;
      // 葉の面の向き（ねじれる）
      const nx = Math.cos(tw), nz = Math.sin(tw);
      const tx = -nz, tz = nx;
      const ww = w * (1 - 0.6 * f * f);
      const c = f < 0.33 ? mixRGB(cols[0], cols[1], f * 3) : mixRGB(cols[1], cols[2], (f - 0.33) * 1.5);
      const cc = f > 0.92 ? mixRGB(c, cols[3], 0.6) : c;
      for (const side of [-0.25, 0.25]) P.push(bx + tx * ww * side, by, bz + tz * ww * side, cc, nx, 0.15, nz, 0.06, Math.pow(f, 1.3));
    }
  }
}

/** 有茎草（対生の小さな葉が節ごとに付き、上の方は赤く色づく） */
function stemPlants(P: PointsOut, world: AquariumWorld, rng: Rng, cx: number, cz: number, radius: number, stems: number, red: boolean, leafLen = 0.13) {
  const low = hex('#4f8a3a'), mid = hex('#6ea548'), top = red ? hex('#d2734a') : hex('#9fcc5e'), tip = red ? hex('#e3967a') : hex('#c4e08a');
  const stemC = hex('#6d7a3a');
  for (let s = 0; s < stems; s++) {
    const a = rng() * Math.PI * 2, rr = Math.sqrt(rng()) * radius;
    const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
    if (world.forestPathDist(x, z) < PATH_CLEAR) continue;
    if (world.pipeClear(x, z) < 0.3) continue;
    const g = world.groundAt(x, z);
    if (world.solid(x, g + 0.1, z) < 0.05) continue;
    const H = Math.min(TANK.waterY - g - 0.25, (0.55 + rng() * 0.45) * (TANK.waterY - g) * 0.85);
    if (H < 0.4) continue;
    P.anchor(x, g, z);
    const bend = (rng() - 0.5) * 0.4, bend2 = (rng() - 0.5) * 0.4;
    const nodes = Math.ceil(H / 0.11);
    let rot = rng() * Math.PI;
    for (let k = 0; k <= nodes; k++) {
      const f = k / nodes;
      const nx0 = x + bend * f * f * H * 0.5, nz0 = z + bend2 * f * f * H * 0.5, ny0 = g + f * H;
      P.push(nx0, ny0, nz0, stemC, Math.cos(rot), 0, Math.sin(rot), 0.035, Math.pow(f, 1.2) * 0.8);
      // 対生の葉（節ごとに 90° 回る）
      const c = f < 0.5 ? mixRGB(low, mid, f * 2) : mixRGB(mid, top, smoothstep(0.55, 0.95, f));
      const L = leafLen * (0.6 + 0.6 * Math.sin(Math.PI * Math.min(1, f * 1.2 + 0.1)));
      for (const side of [0, Math.PI]) {
        const la = rot + side;
        const dx = Math.cos(la), dz = Math.sin(la);
        for (let q = 1; q <= 2; q++) {
          const t = q / 2;
          const px = nx0 + dx * L * t, pz = nz0 + dz * L * t, py = ny0 + L * t * 0.35;
          P.push(px, py, pz, f > 0.96 ? tip : c, dx * 0.4, 1, dz * 0.4, 0.07, Math.pow(f, 1.2) * 0.85);
        }
      }
      rot += Math.PI / 2;
    }
  }
}

/** 前景の絨毯状の水草（丸い小さな葉が砂の上を覆う） */
function carpet(P: PointsOut, world: AquariumWorld, rng: Rng, cx: number, cz: number, radius: number) {
  const cols = [hex('#5f9e44'), hex('#7bb853'), hex('#94c962'), hex('#4a8a3a')];
  const n = Math.round((Math.PI * radius * radius) / 0.0045);
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2, rr = Math.sqrt(rng()) * radius;
    const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
    // ふちは途切れがちに
    if (rr / radius > 0.75 + noise2(x * 2, z * 2, 31) * 0.25) continue;
    if (world.pipeClear(x, z) < 0.04) continue;
    const g = world.groundAt(x, z);
    if (world.solid(x, g + 0.08, z) < 0.04) continue;
    const hgt = 0.02 + rng() * rng() * 0.12;
    const c = cols[Math.floor(rng() * cols.length)];
    P.anchor(x, g, z);
    P.push(x, g + hgt, z, c, (rng() - 0.5) * 0.8, 1, (rng() - 0.5) * 0.8, 0.065, 0.12 + hgt);
  }
}

/** SDF の表面（上向きの面）に苔を付ける */
function mossOnSurface(P: PointsOut, sdf: Sdf, box: Box3Like, rng: Rng, step: number, opts: { minNy: number; colors: RGB[]; size: number; under: boolean | null; mask: number; seed: number }) {
  // 外接箱が丸ごと水中（または水上）で、条件に合う点が 1 つも無いものは表面を探さない（生成時間の節約）
  if (opts.under === false && box.max[1] < TANK.waterY + 0.05) return;
  if (opts.under === true && box.min[1] > TANK.waterY - 0.05) return;
  P.noAnchor();
  sampleSdfSurface(sdf, box, step, rng, (x, y, z, nx, ny, nz) => {
    if (ny < opts.minNy) return;
    if (opts.under === true && y > TANK.waterY - 0.05) return;
    if (opts.under === false && y < TANK.waterY + 0.05) return;
    if (noise3(x * 0.9, y * 0.9, z * 0.9, opts.seed) < opts.mask) return;
    const off = 0.015 + rng() * 0.06;
    const c = opts.colors[Math.floor(rng() * opts.colors.length)];
    P.push(x + nx * off, y + ny * off, z + nz * off, c, nx + (rng() - 0.5) * 0.6, ny, nz + (rng() - 0.5) * 0.6, opts.size, 0.25);
  });
}

/** 陸地の苔の絨毯（地表を覆う。汀線の近くは濡れて暗い） */
function landMoss(P: PointsOut, world: AquariumWorld, rng: Rng) {
  const cols = [hex('#4f8a36'), hex('#5f943b'), hex('#3e6e2c'), hex('#46802f')];
  const wetC = hex('#365c2a');
  const step = 0.1;
  for (let x = 4; x < TANK.maxX; x += step) {
    for (let z = TANK.minZ; z < TANK.maxZ; z += step) {
      const px = x + (rng() - 0.5) * step, pz = z + (rng() - 0.5) * step;
      const g = world.groundAt(px, pz);
      if (g < TANK.waterY + 0.08) continue;
      const m = fbm2(px * 0.35, pz * 0.35, 3, 23);
      if (m < -0.3 + smoothstep(TANK.waterY + 0.08, TANK.waterY + 0.6, g) * -0.1) continue;
      if (world.solid(px, g + 0.06, pz) < 0.03) continue;
      const [nx, ny, nz] = world.groundNormal(px, pz);
      const wet = 1 - smoothstep(TANK.waterY + 0.08, TANK.waterY + 0.7, g);
      const c = mixRGB(cols[Math.floor(hash2(Math.floor(px * 7), Math.floor(pz * 7), 5) * cols.length)], wetC, wet * 0.7);
      const hgt = 0.02 + rng() * 0.05;
      P.anchor(px, g, pz);
      P.push(px, g + hgt, pz, c, nx + (rng() - 0.5) * 0.5, ny, nz + (rng() - 0.5) * 0.5, 0.11, 0.1);
    }
  }
}

/** シダ（中心から放射状に葉が弧を描き、羽片が対に並ぶ） */
function fern(P: PointsOut, world: AquariumWorld, rng: Rng, cx: number, cz: number, scale: number) {
  const g = world.groundAt(cx, cz);
  P.anchor(cx, g, cz);
  const fronds = 7 + Math.floor(rng() * 4);
  const dark = hex('#3f7a34'), light = hex('#7cb350'), rach = hex('#5d6e34');
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * Math.PI * 2 + rng() * 0.4;
    const len = (0.8 + rng() * 0.5) * scale;
    const rise = 0.9 + rng() * 0.5;
    const young = rng() < 0.25;
    const segs = 16;
    const dx = Math.cos(a), dz = Math.sin(a);
    for (let s = 1; s <= segs; s++) {
      const t = s / segs;
      // 立ち上がってから外へ垂れる弧
      const r = len * t;
      const y = g + rise * len * (t * 0.9 - t * t * 0.75);
      const x = cx + dx * r, z = cz + dz * r;
      P.push(x, y, z, rach, 0, 1, 0, 0.035, t * 0.6);
      const pin = 0.28 * scale * (1 - t) * (0.4 + t * 1.2);
      for (const side of [1, -1]) {
        const px = -dz * side, pz = dx * side;
        for (let q = 1; q <= 3; q++) {
          const u = q / 3;
          const c = mixRGB(young ? light : dark, light, u * 0.5 + (young ? 0.3 : 0));
          P.push(x + px * pin * u + dx * pin * u * 0.3, y - pin * u * 0.25, z + pz * pin * u + dz * pin * u * 0.3, c, px * 0.3, 1, pz * 0.3, 0.06, t * 0.6);
        }
      }
    }
  }
}

/** 葉の広い草（白い葉脈の入った楕円の葉が数枚） */
function broadleaf(P: PointsOut, world: AquariumWorld, rng: Rng, cx: number, cz: number) {
  const g = world.groundAt(cx, cz);
  P.anchor(cx, g, cz);
  const leaves = 6 + Math.floor(rng() * 5);
  const leafC = hex('#2f6a35'), vein = hex('#d8e8d0'), edge = hex('#245a2c');
  for (let i = 0; i < leaves; i++) {
    const a = rng() * Math.PI * 2;
    const h = 0.08 + rng() * 0.35;
    const L = 0.22 + rng() * 0.08, W = L * 0.62;
    const tilt = 0.5 + rng() * 0.4;
    const bx = cx + Math.cos(a) * 0.08, bz = cz + Math.sin(a) * 0.08, by = g + h;
    const ux = Math.cos(a), uz = Math.sin(a);
    const vx = -uz, vz = ux;
    for (let p = 0; p <= 5; p++) for (let q = -2; q <= 2; q++) {
      const s = p / 5, w = q / 2;
      const half = Math.sin(Math.PI * Math.max(0.08, s)) * W * 0.5;
      const ox = ux * L * s + vx * half * w, oz = uz * L * s + vz * half * w;
      const oy = -L * s * s * 0.35 * tilt + Math.abs(w) * 0.02;
      const isVein = q === 0 || (Math.abs(q) === 1 && p % 2 === 1);
      const c = isVein ? mixRGB(leafC, vein, 0.55) : Math.abs(q) === 2 ? edge : leafC;
      P.push(bx + ox, by + oy, bz + oz, c, -ux * tilt * 0.5, 1, -uz * tilt * 0.5, 0.075, 0.35);
    }
  }
}

/** 汀線の細い草（水際から陸地へかけての細い葉の株） */
function hairGrass(P: PointsOut, world: AquariumWorld, rng: Rng) {
  const cols = [hex('#6aa64a'), hex('#8cbf5f'), hex('#548f3c')];
  let tufts = 0;
  for (let tries = 0; tries < 3000 && tufts < 46; tries++) {
    const x = lerp(0, 12, rng()), z = lerp(TANK.minZ + 0.5, TANK.maxZ - 0.5, rng());
    const g = world.groundAt(x, z);
    if (Math.abs(g - (TANK.waterY + 0.1)) > 0.65) continue;
    if (world.solid(x, g + 0.1, z) < 0.08) continue;
    tufts++;
    const blades = 8 + Math.floor(rng() * 10);
    for (let b = 0; b < blades; b++) {
      const bx = x + (rng() - 0.5) * 0.25, bz = z + (rng() - 0.5) * 0.25;
      const bg = world.groundAt(bx, bz);
      P.anchor(bx, bg, bz);
      const H = 0.25 + rng() * 0.45;
      const la = rng() * Math.PI * 2, lean = rng() * 0.35;
      const c = cols[Math.floor(rng() * cols.length)];
      const n = Math.ceil(H / 0.04);
      for (let s = 1; s <= n; s++) {
        const f = s / n;
        P.push(bx + Math.cos(la) * lean * f * f * H, bg + f * H, bz + Math.sin(la) * lean * f * f * H, f > 0.85 ? mixRGB(c, hex('#c2d98a'), 0.4) : c, Math.cos(la + 1.5), 0.2, Math.sin(la + 1.5), 0.045, f * 0.8);
      }
    }
  }
}

export function buildAquariumSurfels(world: AquariumWorld, light: LightGrid): { set: SplatPointSet; anchors: Float32Array; ms: number; counts: Record<string, number>; times: Record<string, number> } {
  const t0 = performance.now();
  const rng = mulberry32(9);
  const P = new PointsOut(light);
  const counts: Record<string, number> = {};
  const times: Record<string, number> = {};
  let last = 0, lastT = t0;
  const mark = (k: string) => {
    counts[k] = P.count - last;
    last = P.count;
    const now = performance.now();
    times[k] = Math.round(now - lastT);
    lastT = now;
  };
  // 水草（奥に背の高い葉、中景に有茎草、前景に絨毯）
  for (const [cx, cz, r, n] of [[-15.5, -8.4, 1.7, 46], [-10.5, -8.6, 1.6, 36], [-6.2, -8.6, 1.3, 30], [-0.8, -8.4, 1.5, 34], [-16.6, -2.5, 1.0, 22], [3.8, -8.2, 0.9, 14]] as const) tapeGrass(P, world, rng, cx, cz, r, n);
  // 水草の森：奥の左半分を背の高い葉で埋める（細い通路と小部屋だけ空ける）
  const frng = mulberry32(31);
  for (let cz = -9.3; cz <= -4.6; cz += 1.25) {
    for (let cx = -15.4; cx <= -4.4; cx += 1.35) {
      const jx = cx + (frng() - 0.5) * 0.7, jz = cz + (frng() - 0.5) * 0.5;
      tapeGrass(P, world, frng, jx, jz, 0.9, 13);
    }
  }
  // 小部屋を囲む厚い壁（外からは中が見えない）
  const [rx, , rz] = world.landmarks.forestRoom;
  for (let i = 0; i < 7; i++) {
    const a = Math.PI * 0.05 + (i / 6) * Math.PI * 0.9;
    tapeGrass(P, world, frng, rx + Math.cos(a) * 1.7, rz + Math.sin(a) * 1.5, 0.6, 16);
  }
  mark('テープ状の水草');
  stemPlants(P, world, rng, -15.4, -5.0, 1.2, 24, true);
  stemPlants(P, world, rng, -6.6, -6.2, 1.0, 18, true);
  stemPlants(P, world, rng, 0.6, -6.4, 1.0, 16, false);
  stemPlants(P, world, rng, -12.0, 3.2, 0.9, 12, false, 0.19);
  stemPlants(P, world, rng, -2.6, 1.8, 0.7, 9, true);
  // 森の中の色の変化（赤い有茎草の茂み）と、流木の小屋の手前を隠す茂み
  for (const [x, z, r, n, red] of [[-12.8, -7.4, 0.8, 12, true], [-8.0, -6.2, 0.7, 10, false], [-14.4, -8.8, 0.7, 10, false], [-5.0, -8.6, 0.6, 8, true]] as const) stemPlants(P, world, frng, x, z, r, n, red);
  const hut = world.landmarks.hut;
  for (const [dx, dz] of [[-1.0, 1.5], [0.4, 1.7], [1.5, 1.0], [-1.6, 0.4]] as const) stemPlants(P, world, frng, hut.x + dx, hut.z + dz, 0.5, 7, dx > 0);
  // 倒木のまわり（両端の口を少し隠す）
  const { logA, logB } = world.landmarks;
  stemPlants(P, world, frng, logA[0] - 0.4, logA[2] + 1.2, 0.5, 6, false, 0.17);
  tapeGrass(P, world, frng, logB[0] + 0.3, logB[2] - 1.3, 0.6, 8);
  mark('有茎草');
  carpet(P, world, rng, -9.2, 6.6, 2.6);
  carpet(P, world, rng, -3.4, 7.6, 1.8);
  carpet(P, world, rng, -16.0, 1.8, 1.5);
  carpet(P, world, rng, 0.4, 3.6, 1.2);
  mark('絨毯状の水草');
  // 流木・水中の岩の苔
  const javaC = [hex('#2f5a2a'), hex('#3d6b30'), hex('#4f7d38'), hex('#26492a')];
  for (const w of world.woods) mossOnSurface(P, w.sdf, w.box, rng, 0.055, { minNy: 0.05, colors: javaC, size: 0.075, under: true, mask: -0.25, seed: w.seed + 40 });
  for (const r of world.rocks.filter((q) => q.zone === 'water')) mossOnSurface(P, r.sdf, r.box, rng, 0.07, { minNy: 0.45, colors: javaC, size: 0.08, under: true, mask: 0.05, seed: r.seed + 40 });
  mark('水中の苔');
  // 陸地
  landMoss(P, world, rng);
  const landMossC = [hex('#4f8a36'), hex('#6a9e3e'), hex('#3e6e2c'), hex('#5c9440')];
  for (const r of world.rocks.filter((q) => !q.name.startsWith('mossball'))) mossOnSurface(P, r.sdf, r.box, rng, 0.08, { minNy: 0.5, colors: landMossC, size: 0.1, under: false, mask: -0.15, seed: r.seed + 50 });
  // 苔玉：横・下向きの面まで苔で覆う
  const ballC = [hex('#4f8a36'), hex('#5f943b'), hex('#6fa64e'), hex('#3e6e2c')];
  for (const r of world.rocks.filter((q) => q.name.startsWith('mossball'))) mossOnSurface(P, r.sdf, r.box, rng, 0.06, { minNy: -0.6, colors: ballC, size: 0.09, under: false, mask: -2, seed: r.seed + 60 });
  for (const w of world.woods) mossOnSurface(P, w.sdf, w.box, rng, 0.06, { minNy: 0.3, colors: landMossC, size: 0.08, under: false, mask: -0.1, seed: w.seed + 50 });
  mark('陸地の苔');
  for (const [x, z, s] of [[9.4, -3.6, 1], [12.2, 4.6, 1.15], [16.8, -6.4, 0.9], [8.6, 7.0, 0.85], [17.0, 8.2, 0.9], [13.0, 1.4, 0.8], [10.4, -6.0, 0.75]] as const) fern(P, world, rng, x, z, s);
  mark('シダ');
  for (const [x, z] of [[10.4, 2.4], [14.8, 0.6], [11.6, -7.0], [16.8, 4.4], [7.4, -2.0], [13.4, 8.0], [17.2, -8.6]] as const) broadleaf(P, world, rng, x, z);
  mark('葉の広い草');
  hairGrass(P, world, rng);
  mark('汀線の草');
  // 崖の抜け道の入口を隠すシダ（陸地の奥の角）
  const tin = world.landmarks.tunnelIn;
  for (const [x, z, s] of [[tin[0] - 0.4, tin[2] + 1.6, 0.85], [tin[0] + 1.3, tin[2] + 1.9, 0.7], [tin[0] - 1.6, tin[2] + 1.0, 0.6]] as const) fern(P, world, frng, x, z, s);
  mark('抜け道のシダ');
  const { set, anchors } = P.toSet(rng);
  times['並べ替え'] = Math.round(performance.now() - lastT);
  return { set, anchors, ms: performance.now() - t0, counts, times };
}

/** 照明の向き（描画側の太陽の向きと同じ） */
export { LAMP_DIR };

// ---------------- 発見物・小さな生き物（E 側） ----------------

const SHELL_TINT = [
  [hex('#f4ead0'), hex('#c8b48a')],
  [hex('#ea9a62'), hex('#f1caa0')],
  [hex('#8f6444'), hex('#e3d4ad')],
];

/** 貝殻（二枚貝：放射状の筋の入った扇形の殻）と巻貝（だんだん小さくなる球の螺旋） */
export function buildFindsMesh(finds: Find[], light: LightGrid): TriMesh {
  const mb = new MeshBuilder();
  for (const f of finds) {
    if (f.kind !== 'shell' && f.kind !== 'spiral') continue;
    const [px, py, pz] = f.pos;
    const s = f.scale;
    const cr = Math.cos(f.rot), sr = Math.sin(f.rot);
    const [c0, c1] = SHELL_TINT[f.tint % SHELL_TINT.length];
    // ローカル座標（向き・大きさを掛ける前）の SDF
    let sdf: Sdf;
    let box: Box3Like;
    if (f.kind === 'shell') {
      sdf = (x, y, z) => {
        const d = sdEllipsoid(x, y, z, 0, 0, 0, 0.13, 0.055, 0.12);
        // 下半分を切って伏せた殻にし、付け根を少し尖らせる
        return Math.max(d, -y - 0.005) + Math.max(0, -z - 0.06) * 0.25;
      };
      box = { min: [-0.16, -0.03, -0.15], max: [0.16, 0.08, 0.15] };
    } else {
      sdf = (x, y, z) => {
        let d = Infinity;
        for (let i = 0; i < 6; i++) {
          const a = i * 1.25, r = 0.075 * Math.pow(0.78, i), rad = 0.05 * Math.pow(0.8, i);
          d = smin(d, sdEllipsoid(x, y, z, Math.cos(a) * rad, r * 0.6 + i * 0.028, Math.sin(a) * rad + i * 0.02, r * 1.15, r, r * 1.15), 0.03);
        }
        return d;
      };
      box = { min: [-0.14, -0.06, -0.12], max: [0.14, 0.26, 0.2] };
    }
    surfaceNets(sdf, box, 0.018, mb, (x, y, z, nx, ny, nz) => {
      // 二枚貝は放射状の筋、巻貝は巻きの縞
      const t = f.kind === 'shell' ? Math.sin(Math.atan2(x, z + 0.06) * 18) * 0.5 + 0.5 : Math.sin(y * 70) * 0.5 + 0.5;
      const c = mixRGB(c0, c1, t * 0.7);
      const wx = px + (x * cr + z * sr) * s, wy = py + y * s, wz = pz + (-x * sr + z * cr) * s;
      return mb.vertex(wx, wy, wz, nx * cr + nz * sr, ny, -nx * sr + nz * cr, u8(c[0]), u8(c[1]), u8(c[2]), light.sample(wx, wy + 0.15, wz), 0.25);
    });
  }
  return mb.finish();
}

const GLOW_TINT = [
  [hex('#4aa08d'), hex('#b4dcc4')],
  [hex('#4a78a0'), hex('#cfe6f2')],
];

/** 光る石：細長い結晶の束。aMisc.x = 明滅の位相（0..1）、aMisc.y = 明るさ（根元は暗く先は明るい） */
export function buildGlowMesh(finds: Find[]): TriMesh {
  const mb = new MeshBuilder();
  finds.forEach((f, fi) => {
    if (f.kind !== 'glow') return;
    const [px, py, pz] = f.pos;
    const s = f.scale;
    const [c0, c1] = GLOW_TINT[f.tint % GLOW_TINT.length];
    const rng = mulberry32(100 + fi);
    const crystals: { b: [number, number, number]; r: number }[] = [];
    for (let i = 0; i < 5; i++) {
      const a = rng() * Math.PI * 2, lean = i === 0 ? 0.1 : 0.35 + rng() * 0.4;
      const L = (i === 0 ? 0.32 : 0.14 + rng() * 0.14) * s;
      crystals.push({ b: [Math.cos(a) * Math.sin(lean) * L, Math.cos(lean) * L, Math.sin(a) * Math.sin(lean) * L], r: (i === 0 ? 0.06 : 0.04) * s });
    }
    const sdf: Sdf = (x, y, z) => {
      let d = Infinity;
      for (const c of crystals) d = smin(d, sdCapsule(x, y, z, 0, -0.02, 0, c.b[0], c.b[1], c.b[2], c.r, c.r * 0.2), 0.02);
      return d;
    };
    const R = 0.4 * s;
    surfaceNets(sdf, { min: [-R, -0.06, -R], max: [R, R + 0.05, R] }, 0.016, mb, (x, y, z, nx, ny, nz) => {
      const t = clamp(y / (0.3 * s), 0, 1);
      const c = mixRGB(c0, c1, 0.3 + t * 0.7);
      return mb.vertex(px + x, py + y, pz + z, nx, ny, nz, u8(c[0]), u8(c[1]), u8(c[2]), (fi * 0.37) % 1, 0.4 + t * 0.6);
    });
  });
  return mb.finish();
}

/** 小魚（ネオンテトラのような小型の魚）。体の軸は +z が頭。aMisc.y = 尾の振れの強さ（頭 0 → 尾 1） */
export function buildFishMesh(): TriMesh {
  const mb = new MeshBuilder();
  const sdf: Sdf = (x, y, z) => {
    let d = sdEllipsoid(x, y, z, 0, 0, 0.01, 0.034, 0.058, 0.15);
    d = smin(d, sdEllipsoid(x, y, z, 0, 0, -0.17, 0.008, 0.06, 0.05), 0.03); // 尾びれ
    d = smin(d, sdEllipsoid(x, y, z, 0, 0.055, -0.03, 0.006, 0.03, 0.04), 0.02); // 背びれ
    return d;
  };
  const blue = hex('#86b4d4'), cyan = hex('#cfe6f2'), red = hex('#d06a3e'), silver = hex('#d2d6d6'), back = hex('#2c4a6e'), fin = hex('#aab0b4');
  surfaceNets(sdf, { min: [-0.06, -0.09, -0.24], max: [0.06, 0.1, 0.18] }, 0.011, mb, (x, y, z, nx, ny, nz) => {
    let c: RGB;
    if (z < -0.13) c = fin;
    else if (y > 0.02) c = back;
    else if (y > -0.008) c = mixRGB(blue, cyan, smoothstep(0.1, -0.05, z) * 0.6);
    else c = z < 0.03 ? red : silver;
    // 目
    if (z > 0.1 && Math.abs(y - 0.012) < 0.016 && Math.abs(x) > 0.018) c = hex('#0c0d12');
    const tail = smoothstep(0.06, -0.2, z);
    return mb.vertex(x, y, z, nx, ny, nz, u8(c[0]), u8(c[1]), u8(c[2]), 1, tail);
  });
  return mb.finish();
}

/** エビ（小さな赤いエビ）。体の軸は +z が頭。体の節は弧を描き、尾は扇形。aMisc.y = 尾の側ほど大きい（尾を打つ動き用） */
export function buildShrimpMesh(): TriMesh {
  const mb = new MeshBuilder();
  const segs: [number, number, number, number][] = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    // 頭（t = 0）→ 尾（t = 1）。背中が丸く、尾の先は下へ曲がる
    segs.push([0, 0.045 + Math.sin(Math.PI * t * 0.9) * 0.03 - t * t * 0.03, 0.12 - t * 0.27, 0.036 - t * 0.02]);
  }
  const sdf: Sdf = (x, y, z) => {
    let d = Infinity;
    for (let i = 0; i < segs.length - 1; i++) {
      const a = segs[i], b = segs[i + 1];
      d = smin(d, sdCapsule(x, y, z, a[0], a[1], a[2], b[0], b[1], b[2], a[3], b[3]), 0.012);
    }
    d = smin(d, sdEllipsoid(x, y, z, 0, 0.012, -0.175, 0.045, 0.008, 0.03), 0.015); // 尾扇
    d = smin(d, sdCapsule(x, y, z, 0, 0.05, 0.14, 0, 0.075, 0.2, 0.01, 0.004), 0.01); // 額角
    // 脚（太めにして画素に残す）
    for (let k = 0; k < 3; k++) {
      const zz = 0.06 - k * 0.04;
      for (const sx of [-1, 1]) d = smin(d, sdCapsule(x, y, z, sx * 0.012, 0.03, zz, sx * 0.04, -0.005, zz + 0.01, 0.008, 0.006), 0.008);
    }
    return d;
  };
  const red = hex('#d06a3e'), dark = hex('#a84530'), light = hex('#ea9a62');
  surfaceNets(sdf, { min: [-0.07, -0.03, -0.23], max: [0.07, 0.12, 0.23] }, 0.01, mb, (x, y, z, nx, ny, nz) => {
    let c = Math.sin(z * 75) > 0.55 ? light : red;
    if (y < 0.02) c = dark;
    if (z > 0.09 && z < 0.12 && Math.abs(x) > 0.022 && y > 0.05) c = hex('#0c0d12');
    return mb.vertex(x, y, z, nx, ny, nz, u8(c[0]), u8(c[1]), u8(c[2]), 1, smoothstep(0.02, -0.18, z));
  });
  return mb.finish();
}

/**
 * 最初の仲間：スナモグリ（砂に巣穴を掘るエビのなかま）。エビ（buildShrimpMesh）と同じ作りで、体を太く白っぽい桃色にし、
 * 片方（右）だけ大きな鋏・長い触角を付ける。体の軸は +z が頭。
 * aMisc.y = 尾の側ほど大きい（creatureVertex の尾を打つ動き）、aMisc.x = 触角の先ほど大きい（BUDDY の触角の揺れ）
 */
export function buildBuddyMesh(): TriMesh {
  const mb = new MeshBuilder();
  const segs: [number, number, number, number][] = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    // 頭の後ろ（t = 0）→ 尾（t = 1）。背中は低い弧、尾の先は少し下へ
    segs.push([0, 0.05 + Math.sin(Math.PI * t * 0.8) * 0.02 - t * t * 0.03, 0.12 - t * 0.33, 0.06 - t * 0.03]);
  }
  const ant = [-1, 1].map((sx) => ({ a: [sx * 0.022, 0.07, 0.2] as const, b: [sx * 0.085, 0.2, 0.44] as const }));
  const sdf: Sdf = (x, y, z) => {
    let d = Infinity;
    for (let i = 0; i < segs.length - 1; i++) {
      const a = segs[i], b = segs[i + 1];
      d = smin(d, sdCapsule(x, y, z, a[0], a[1], a[2], b[0], b[1], b[2], a[3], b[3]), 0.016);
    }
    d = smin(d, sdEllipsoid(x, y, z, 0, 0.055, 0.15, 0.062, 0.052, 0.085), 0.02); // 頭胸甲
    d = smin(d, sdEllipsoid(x, y, z, 0, 0.02, -0.24, 0.07, 0.01, 0.045), 0.015); // 尾扇
    // 大きな鋏（右 = +x）：腕 → 掌 → 指 2 本
    d = smin(d, sdCapsule(x, y, z, 0.035, 0.035, 0.17, 0.085, 0.03, 0.25, 0.022, 0.024), 0.012);
    d = smin(d, sdEllipsoid(x, y, z, 0.1, 0.03, 0.3, 0.048, 0.034, 0.06), 0.015);
    d = Math.min(d, sdCapsule(x, y, z, 0.112, 0.022, 0.34, 0.104, 0.018, 0.41, 0.014, 0.009));
    d = Math.min(d, sdCapsule(x, y, z, 0.086, 0.046, 0.34, 0.094, 0.04, 0.4, 0.012, 0.008));
    // 小さな鋏（左）
    d = smin(d, sdCapsule(x, y, z, -0.035, 0.035, 0.17, -0.07, 0.03, 0.24, 0.015, 0.016), 0.01);
    d = smin(d, sdEllipsoid(x, y, z, -0.075, 0.03, 0.27, 0.026, 0.02, 0.036), 0.01);
    // 触角（画素に残るよう太め）
    for (const A of ant) d = Math.min(d, sdCapsule(x, y, z, A.a[0], A.a[1], A.a[2], A.b[0], A.b[1], A.b[2], 0.011, 0.007));
    // 歩脚
    for (let k = 0; k < 3; k++) {
      const zz = 0.08 - k * 0.045;
      for (const sx of [-1, 1]) d = smin(d, sdCapsule(x, y, z, sx * 0.03, 0.03, zz, sx * 0.075, -0.012, zz + 0.012, 0.01, 0.007), 0.008);
    }
    return d;
  };
  // 砂（淡い黄土色）に埋もれないよう、桃色〜橙をはっきりさせる
  const cream = hex('#f4c2a6'), pink = hex('#e0866a'), band = hex('#b75c48'), claw = hex('#f0703c'), tip = hex('#ffd27a'), belly = hex('#d98e74');
  surfaceNets(sdf, { min: [-0.14, -0.04, -0.3], max: [0.15, 0.23, 0.47] }, 0.011, mb, (x, y, z, nx, ny, nz) => {
    let c: RGB = Math.sin(z * 60) > 0.6 ? band : mixRGB(cream, pink, smoothstep(0.08, -0.2, z) * 0.7);
    if (y < 0.025 && z < 0.2) c = belly;
    // 鋏は橙、指先は黄
    if (z > 0.2 && Math.abs(x) > 0.045 && y < 0.07) c = z > 0.36 ? tip : claw;
    const antenna = Math.max(0, ...ant.map((A) => (Math.hypot(x - A.a[0], z - A.a[2]) > 0.02 && y > 0.075 ? clamp((z - 0.2) / 0.24, 0, 1) : 0)));
    if (antenna > 0) c = mixRGB(pink, tip, antenna * 0.6);
    // 目（黒い小さな点）
    if (z > 0.2 && z < 0.24 && Math.abs(x) > 0.02 && Math.abs(x) < 0.05 && y > 0.06 && y < 0.09) c = hex('#0c0d12');
    return mb.vertex(x, y, z, nx, ny, nz, u8(c[0]), u8(c[1]), u8(c[2]), antenna, smoothstep(0.02, -0.22, z));
  });
  return mb.finish();
}

/** 巣穴の口：地表の小さな盛り上がりの輪と、中の暗い穴（地形の高さに沿わせる） */
export function buildBurrowMesh(world: AquariumWorld, light: LightGrid, bx: number, bz: number): TriMesh {
  const mb = new MeshBuilder();
  const g = (x: number, z: number) => world.groundAt(x, z);
  let gmin = Infinity, gmax = -Infinity;
  for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) {
    const h = g(bx + i * 0.1, bz + j * 0.1);
    gmin = Math.min(gmin, h);
    gmax = Math.max(gmax, h);
  }
  const sdf: Sdf = (x, y, z) => {
    const gy = g(x, z), r = Math.hypot(x - bx, z - bz);
    // 縁：輪の盛り上がり（地表より下は地形に隠れる）
    const rim = Math.hypot(r - 0.17, y - gy + 0.015) - 0.05;
    // 穴：地表に貼り付いた暗い円板
    const hole = Math.max(r - 0.13, Math.abs(y - gy - 0.008) - 0.01);
    return Math.max(smin(rim, hole, 0.02), gy - 0.03 - y);
  };
  const sand = hex('#c4ad82'), sand2 = hex('#a8926a'), dark = hex('#1d1712'), dark2 = hex('#3a2c20');
  surfaceNets(sdf, { min: [bx - 0.3, gmin - 0.05, bz - 0.3], max: [bx + 0.3, gmax + 0.1, bz + 0.3] }, 0.012, mb, (x, y, z, nx, ny, nz) => {
    const r = Math.hypot(x - bx, z - bz);
    const c = r < 0.125 ? mixRGB(dark, dark2, r / 0.125) : mixRGB(sand2, sand, clamp((y - g(x, z)) / 0.04, 0, 1));
    return mb.vertex(x, y, z, nx, ny, nz, u8(c[0]), u8(c[1]), u8(c[2]), light.sample(x, y + 0.15, z), 0.25);
  });
  return mb.finish();
}
