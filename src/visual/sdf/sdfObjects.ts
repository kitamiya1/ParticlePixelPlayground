// 樹木・岩・キャラクターを SDF から生成する（描画方式 B の「SDF 生成」用）。
// 形の計画（TreePlan / RockPlan / CHARACTER_PARTS）は既存の粒生成と共有し、表面の点の作り方だけを変える。
// 既存の粒版は「球やカプセルの表面に点を並べ、埋もれた点を手で除く」方式、
// こちらは「形状を 1 つの距離場として合成し、その表面だけを取り出す」方式。

import { hex, mulberry32, noise3, fbm3, pick, scaleRGB, mixRGB, type RGB, type Rng } from '../../core/math';
import type { IslandLayout } from '../../world/IslandLayout';
import { ParticleBuilder } from '../ParticleBuilder';
import { bakeSunShadows, type SphereOccluder } from '../ShadowBaker';
import { BONE, BONE_PIVOTS, CHARACTER_COLORS as C } from '../emitters/character';
import { planRock, rockOccluders, type RockPlan } from '../emitters/rock';
import { planTree, treeOccluders, type TreePlan } from '../emitters/tree';
import { SUN_DIR } from '../WorldVisualBuilder';
import { sampleSdfSurface, sdCapsule, sdCone, sdEllipsoid, smin, type Box3Like } from './sdf';

const LEAF_STEP = 0.13;
const BARK_STEP = 0.075;
const ROCK_STEP = 0.1;

function trunkPoint(plan: TreePlan, f: number): [number, number, number] {
  const k = f * f;
  return [plan.x + plan.bend[0] * k, plan.y + plan.trunkH * f, plan.z + plan.bend[1] * k];
}

/** 幹と枝の SDF */
export function barkSdf(plan: TreePlan) {
  const segs: { a: number[]; b: number[]; ra: number; rb: number }[] = [];
  const n = 6;
  for (let i = 0; i < n; i++) {
    const f0 = i / n, f1 = (i + 1) / n;
    const r = (f: number) => plan.trunkR * (1 + 0.7 * Math.exp(-f * plan.trunkH * 3)) * (1 - f * 0.35);
    segs.push({ a: trunkPoint(plan, f0), b: trunkPoint(plan, f1), ra: r(f0), rb: r(f1) });
  }
  const top = trunkPoint(plan, 0.85);
  for (const bl of plan.blobs.slice(1, 4)) {
    segs.push({ a: top, b: [(top[0] + bl.x) / 2, (top[1] + bl.y) / 2, (top[2] + bl.z) / 2], ra: plan.trunkR * 0.4, rb: plan.trunkR * 0.25 });
  }
  return (x: number, y: number, z: number) => {
    let d = Infinity;
    for (const s of segs) d = smin(d, sdCapsule(x, y, z, s.a[0], s.a[1], s.a[2], s.b[0], s.b[1], s.b[2], s.ra, s.rb), plan.trunkR * 0.5);
    return d;
  };
}

/** 樹冠の SDF（球のなめらかな和集合 + ノイズのでこぼこ） */
export function canopySdf(plan: TreePlan) {
  const mainR = plan.blobs[0]?.r ?? 1;
  return (x: number, y: number, z: number) => {
    let d = Infinity;
    for (const bl of plan.blobs) d = smin(d, sdEllipsoid(x, y, z, bl.x, bl.y, bl.z, bl.r, bl.r * 0.88, bl.r), mainR * 0.45);
    for (const c of plan.cones) d = smin(d, sdCone(x, y, z, plan.x, plan.y + c.y, plan.z, c.r, c.h), c.r * 0.15);
    const amp = plan.cones.length ? 0.1 : 0.2 * mainR;
    return d - noise3(x * 1.3, y * 1.3, z * 1.3, plan.seed) * amp;
  };
}

export function treeBox(plan: TreePlan): Box3Like {
  let r = plan.trunkR * 3;
  let top = plan.y + plan.trunkH;
  let x0 = plan.x - r, x1 = plan.x + r, z0 = plan.z - r, z1 = plan.z + r;
  for (const b of plan.blobs) {
    const m = b.r * 1.35;
    x0 = Math.min(x0, b.x - m); x1 = Math.max(x1, b.x + m);
    z0 = Math.min(z0, b.z - m); z1 = Math.max(z1, b.z + m);
    top = Math.max(top, b.y + m);
  }
  for (const c of plan.cones) {
    r = c.r * 1.2;
    x0 = Math.min(x0, plan.x - r); x1 = Math.max(x1, plan.x + r);
    z0 = Math.min(z0, plan.z - r); z1 = Math.max(z1, plan.z + r);
    top = Math.max(top, plan.y + c.y + c.h + 0.3);
  }
  return { min: [x0, plan.y - 0.2, z0], max: [x1, top, z1] };
}

function emitSdfTree(b: ParticleBuilder, plan: TreePlan, rng: Rng) {
  b.setCategory('樹木');
  const canopy = canopySdf(plan);
  const bark = barkSdf(plan);
  const box = treeBox(plan);
  const isConifer = plan.cones.length > 0;
  // 樹冠
  sampleSdfSurface((x, y, z) => canopy(x, y, z), box, LEAF_STEP, rng, (x, y, z, nx, ny, nz) => {
    if (bark(x, y, z) < 0) return;
    const hNorm = (y - plan.y) / Math.max(1, box.max[1] - plan.y);
    const tone = ny * 0.45 + (nx * 0.2 - nz * 0.1) + noise3(x * 1.5, y * 1.5, z * 1.5, plan.seed + 1) * 0.6;
    let c: RGB;
    if (isConifer) {
      c = tone > 0.5 ? plan.leaf[2] : tone > 0.2 ? plan.leaf[0] : tone > -0.1 ? plan.leaf[1] : plan.leaf[3];
      if (ny < 0) c = scaleRGB(c, 0.6);
    } else {
      const idx = tone > 0.45 ? 4 : tone > 0.15 ? 0 : tone > -0.2 ? 1 : tone > -0.5 ? 2 : 3;
      c = plan.leaf[Math.min(idx, plan.leaf.length - 1)];
      if (plan.variant === 'blossom' && rng() < 0.06) c = hex('#ffffff');
    }
    b.push(x, y, z, c, nx, ny + 0.15, nz, { size: 0.21, wind: 0.25 + 0.25 * Math.min(1, hNorm) });
  });
  // 幹・枝（樹冠の内側に埋もれた部分は出さない）
  sampleSdfSurface(bark, box, BARK_STEP, rng, (x, y, z, nx, ny, nz) => {
    if (y < plan.y - 0.1 || canopy(x, y, z) < 0) return;
    const streak = noise3(x * 2, y * 9, z * 2, plan.seed) * 0.5 + 0.5;
    b.push(x, y, z, scaleRGB(pick(plan.bark, streak), 0.9 + rng() * 0.15), nx, ny, nz, { size: 0.12 });
  });
}

const ROCK_COL: RGB[] = ['#9a958f', '#86817c', '#aaa59d', '#7a7570'].map(hex);
const MOSS = hex('#6f9a4a');

/** 岩の SDF（楕円体 + 低周波ノイズの変位 + 角ばり） */
export function rockSdf(plan: RockPlan) {
  const c = Math.cos(plan.rot), s = Math.sin(plan.rot);
  const minR = Math.min(plan.rx, plan.ry, plan.rz);
  return (x: number, y: number, z: number) => {
    const wx = x - plan.x, wz = z - plan.z;
    const lx = (wx * c + wz * s) / plan.rx, ly = (y - plan.y) / plan.ry, lz = (-wx * s + wz * c) / plan.rz;
    const l = Math.hypot(lx, ly, lz) || 1e-6;
    const dx = lx / l, dy = ly / l, dz = lz / l;
    const disp = 1 + 0.28 * fbm3(dx * 1.6, dy * 1.6, dz * 1.6, 3, plan.seed);
    // 角ばり：軸に近い方向を少し平らに
    const facet = Math.max(Math.abs(dx), Math.abs(dy) * 1.2, Math.abs(dz));
    return (l - disp * (0.82 + 0.18 / Math.max(0.6, facet))) * minR;
  };
}

export function rockBox(plan: RockPlan): Box3Like {
  const m = Math.max(plan.rx, plan.ry, plan.rz) * 1.7;
  return { min: [plan.x - m, plan.y - m, plan.z - m], max: [plan.x + m, plan.y + m, plan.z + m] };
}

function emitSdfRock(b: ParticleBuilder, plan: RockPlan, layout: IslandLayout, rng: Rng) {
  b.setCategory('岩');
  const sdf = rockSdf(plan);
  const box = rockBox(plan);
  const t = layout.terrain;
  sampleSdfSurface(sdf, box, ROCK_STEP, rng, (x, y, z, nx, ny, nz) => {
    if (y < t.heightRaw(x, z) - 0.05) return;
    let col = pick(ROCK_COL, fbm3(x * 2, y * 2, z * 2, 2, plan.seed) * 0.5 + 0.5 + (rng() - 0.5) * 0.2);
    if (ny > 0.55 && fbm3(x * 1.2, 0, z * 1.2, 2, plan.seed + 3) > -0.05) col = mixRGB(col, MOSS, 0.75);
    b.push(x, y, z, scaleRGB(col, 0.95 + rng() * 0.1), nx, ny, nz, { size: 0.16 });
  });
}

/** 浮き島の樹木と岩を SDF から生成し、太陽の影を焼き込んだ粒データを返す */
export function buildSdfObjects(layout: IslandLayout, seed = 11): ParticleBuilder {
  const rng = mulberry32(seed);
  const b = new ParticleBuilder(1 << 17);
  const occ: SphereOccluder[] = [];
  for (const p of layout.placements) {
    if (p.kind === 'tree') {
      const plan = planTree(p);
      emitSdfTree(b, plan, rng);
      occ.push(...treeOccluders(plan));
    } else if (p.kind === 'rock') {
      const plan = planRock(p);
      emitSdfRock(b, plan, layout, rng);
      occ.push(...rockOccluders(plan));
    }
  }
  // 地形の影と樹冠・岩の影（既存の焼き込みをそのまま使う）。
  // 遮蔽物の球が自分自身に影を落とさないよう、既存の粒と同じく法線方向に少し浮かせて判定される。
  bakeSunShadows(b, layout.terrain, occ, SUN_DIR);
  return b;
}

// ---------------- キャラクター ----------------

/** キャラクターのスプラット元データ（静止姿勢のキャラクター座標、最大 2 ボーンの重み） */
export interface CharacterSplatSource {
  count: number;
  pos: Float32Array;
  col: Uint8Array;
  nrm: Float32Array;
  size: Float32Array;
  bone0: Uint8Array;
  bone1: Uint8Array;
  weight0: Float32Array;
}

/** キャラクターの部位 SDF（1 部位 = 1 ボーン。色は表面の位置と法線から決める） */
export interface CharacterSdfPart {
  bone: number;
  d: (x: number, y: number, z: number) => number;
  color: (x: number, y: number, z: number, nx: number, ny: number, nz: number) => RGB;
}

/** 部位同士をなめらかにつなぐ幅（smin の k） */
export const CHARACTER_BLEND = 0.035;

/**
 * キャラクターを部位 SDF のなめらかな和集合として生成する。
 * 部位の継ぎ目（首・肩・股）の点には 2 本のボーンを距離に応じた重みで割り当て、
 * Spark の SplatSkinning（デュアルクォータニオン）で継ぎ目がなめらかに曲がるかを検証できるようにする。
 */
export function buildSdfCharacter(seed = 5): CharacterSplatSource {
  const rng = mulberry32(seed);
  const parts = characterSdfParts();
  const K = CHARACTER_BLEND; // 部位同士の継ぎ目の丸み
  const union = (x: number, y: number, z: number) => {
    let d = Infinity;
    for (const p of parts) d = smin(d, p.d(x, y, z), K);
    return d;
  };
  const out = { pos: [] as number[], col: [] as number[], nrm: [] as number[], size: [] as number[], b0: [] as number[], b1: [] as number[], w0: [] as number[] };
  const step = 0.04;
  sampleSdfSurface(union, { min: [-0.4, -0.05, -0.3], max: [0.4, 1.4, 0.3] }, step, rng, (x, y, z, nx, ny, nz) => {
    // 最も近い 2 部位
    let i0 = 0, i1 = 0, d0 = Infinity, d1 = Infinity;
    for (let i = 0; i < parts.length; i++) {
      const d = parts[i].d(x, y, z);
      if (d < d0) { d1 = d0; i1 = i0; d0 = d; i0 = i; } else if (d < d1) { d1 = d; i1 = i; }
    }
    const p0 = parts[i0], p1 = parts[i1];
    // 距離差が小さいほど 2 本目のボーンの影響を強くする（継ぎ目の幅 ≒ K）
    const t = Math.min(1, Math.max(0, (d1 - d0) / K));
    const w0 = p0.bone === p1.bone ? 1 : 0.5 + 0.5 * t;
    const c = scaleRGB(p0.color(x, y, z, nx, ny, nz), 0.96 + rng() * 0.08);
    out.pos.push(x, y, z);
    out.col.push(...c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)));
    out.nrm.push(nx, ny, nz);
    out.size.push(0.085);
    out.b0.push(p0.bone);
    out.b1.push(p1.bone);
    out.w0.push(w0);
  });
  return {
    count: out.size.length,
    pos: Float32Array.from(out.pos),
    col: Uint8Array.from(out.col),
    nrm: Float32Array.from(out.nrm),
    size: Float32Array.from(out.size),
    bone0: Uint8Array.from(out.b0),
    bone1: Uint8Array.from(out.b1),
    weight0: Float32Array.from(out.w0),
  };
}

/** キャラクターの部位 SDF（方式 B・C の SDF 生成と方式 D のボクセル化で共有） */
export function characterSdfParts(): CharacterSdfPart[] {
  const parts: CharacterSdfPart[] = [
    {
      bone: BONE.body,
      d: (x, y, z) => smin(sdEllipsoid(x, y, z, 0, 0.66, 0, 0.19, 0.2, 0.15), sdCapsule(x, y, z, 0.06, 0.8, -0.14, 0.1, 0.62, -0.2, 0.035), 0.03),
      color: (_x, y, _z, _nx, ny) => (y > 0.8 ? C.scarf : Math.abs(y - 0.53) < 0.03 ? C.belt : ny < -0.3 ? C.tunicDark : C.tunic),
    },
    {
      bone: BONE.head,
      d: (x, y, z) => smin(sdEllipsoid(x, y, z, 0, 1.06, 0.01, 0.21, 0.2, 0.2), sdCapsule(x, y, z, 0, 1.25, 0.02, -0.04, 1.33, -0.03, 0.025), 0.02),
      color: (x, y, _z, _nx, ny, nz) => {
        if (y > 1.24) return C.hair;
        const front = nz > 0.55;
        if (front && Math.abs(Math.abs(x) - 0.075) < 0.03 && Math.abs(y - 1.05) < 0.04) return C.eye;
        if (front && Math.abs(Math.abs(x) - 0.12) < 0.035 && Math.abs(y - 0.99) < 0.025) return C.cheek;
        if (ny > 0.25 || nz < -0.2 || (ny > -0.1 && nz < 0.35)) return C.hair;
        if (front && y > 1.14) return C.hair;
        return C.skin;
      },
    },
  ];
  for (const [bone, sx] of [[BONE.armL, 1], [BONE.armR, -1]] as const) {
    parts.push({ bone, d: (x, y, z) => sdCapsule(x, y, z, 0.24 * sx, 0.78, 0, 0.27 * sx, 0.53, 0, 0.055), color: (_x, y) => (y < 0.56 ? C.skin : C.tunic) });
  }
  for (const [bone, sx] of [[BONE.legL, 1], [BONE.legR, -1]] as const) {
    parts.push({
      bone,
      d: (x, y, z) => smin(sdCapsule(x, y, z, 0.09 * sx, 0.46, 0, 0.09 * sx, 0.07, 0.02, 0.068), sdEllipsoid(x, y, z, 0.09 * sx, 0.05, 0.05, 0.075, 0.05, 0.11), 0.03),
      color: (_x, y) => (y < 0.17 ? C.boots : C.pants),
    });
  }
  return parts;
}

/** 既存の粒版キャラクター（ボーン支点からの相対座標）を、スプラット用の静止姿勢データに変換する */
export function characterSourceFromGeometry(pos: ArrayLike<number>, col: ArrayLike<number>, nrm: ArrayLike<number>, misc: ArrayLike<number>, bone: ArrayLike<number>, n: number): CharacterSplatSource {
  const src: CharacterSplatSource = {
    count: n,
    pos: new Float32Array(n * 3),
    col: new Uint8Array(n * 3),
    nrm: new Float32Array(n * 3),
    size: new Float32Array(n),
    bone0: new Uint8Array(n),
    bone1: new Uint8Array(n),
    weight0: new Float32Array(n).fill(1),
  };
  for (let i = 0; i < n; i++) {
    const bi = Math.round(bone[i]);
    const pv = BONE_PIVOTS[bi];
    for (let k = 0; k < 3; k++) {
      src.pos[i * 3 + k] = pos[i * 3 + k] + pv[k];
      src.col[i * 3 + k] = col[i * 3 + k];
      src.nrm[i * 3 + k] = nrm[i * 3 + k];
    }
    src.size[i] = misc[i * 3];
    src.bone0[i] = src.bone1[i] = bi;
  }
  return src;
}
