// 接地主導の移動（第 7 段階）：崖・段差を、脚が下の足場を確保してから胴体を下ろして降りる。
//
// 歩き方「接地主導」（AquaUiPrefs の gait = 'lead'）のときだけ CrabController が使う。接地 IK（CrabFeet）の脚の接地を、
// 見た目・速さだけでなく胴体の移動そのものへ返す最初の段階で、崖・段差を降りる所だけを扱う。
//
// 1. 縁を見つける（scanLedge）：歩いている向きの前方を 0.08 ごとに真下へ探り、0.05 進むごとに 0.075 より大きく下がる所
//    （約 56° より急な下り = 歩いては下りられない所）を縁とする。縁の外向き（水平）は、縁の少し外・少し下の点の
//    距離関数の勾配から（斜めに近づいても、縁に垂直な向きで止める）。
// 2. 種類を決める（CrabController）：下の足場まで stepMax 以下 = 段差（脚を下へ伸ばして胴体を下ろす）、
//    それより高く、縁の下の側面が登れる面 = 崖（側面へ脚を掛けて、壁登りへ移って降りる）、どちらでもない = 足場が無い。
// 3. 胴体は、先頭の脚が下の足場（縁より下）に needDown 本以上掛かるまで縁から出ない（縁へ近づく速さを、はみ出しの上限までの
//    距離に比例して落とす。縁に沿う向きの動きはそのまま）。段差は少しだけ身を乗り出し（leanOver。縁の角に乗って体が傾く）、脚を届かせる。
// 4. 脚が掛かったら、胴体は脚に支えられて descRate で下の足場へ下ろす（重力で落とさない）。下に隙間が大きい間は水平の速さを
//    落とす（胴体だけが崖の先へ浮いて進まない）。後ろの脚は伸びきる・理想の位置から離れると踏み替える（CrabFeet）。
// 5. 崖：側面に needFace 本以上（または縁より下に needFace + 1 本以上）の脚が掛かったら、縁を回り込む道（descentPath）をたどって側面に張り付き、そのまま壁登りで降りる
//    （スティックの向きは壁登りの「壁から離れる = 下」へ続く）。
// 6. 足場が見つからないまま押し続けたら（holdT / holdTMax）、縁から踏み出す（自然に落ちる・沈む）。
//    支えていた脚の足場が消えた（掘った）・脚が足りなくなったら、支えを失って落ちる。

import type { AquariumWorld } from './AquariumWorld';

export type LedgeKind = 'step' | 'climb' | 'none';

/** 縁の状態（CrabController が持ち、CrabRig → CrabFeet へ探す手がかりとして渡す。診断の表示も読む） */
export interface Ledge {
  /** 縁の外向き（水平の単位）・縁の上の点（足元の高さ）・下の足場までの高さ（探す深さで切る）・種類 */
  readonly e: [number, number, number];
  readonly lip: [number, number, number];
  drop: number;
  kind: LedgeKind;
  /** 体の中心の、縁から外へのはみ出し（水平・e の向き。縁の手前は負） */
  over: number;
  /** 縁で押し続けて待っている時間・足場が無いので踏み出した */
  holdT: number;
  stepOff: boolean;
  /** 脚が支えて胴体を下ろしている・縁を越え始めた（もう探し直さない）・見つけてからの時間 */
  lowering: boolean;
  committed: boolean;
  t: number;
  /** 胴体の下の隙間（脚で支えている間）・崖を降り始める道を次に探すまでの時間 */
  gap: number;
  retry: number;
  /** 支えが足りない時間（踏み替えの間は looseT まで待つ） */
  loose: number;
  /** 縁の外へ向かって押している（脚が縁の下を探す。押すのをやめたら探さない＝止まっている間に踏み替えない） */
  seek: boolean;
}

export const LEDGE = {
  /** 縁とみなす下り：0.05 進むごとに下がる量（約 56° より急）・縁とみなす高さ */
  slopeDrop: 0.075,
  minDrop: 0.12,
  /** 前方を探る間隔と回数（0.08〜0.48） */
  scanStep: 0.08,
  scanN: 6,
  /** 脚と胴体を下ろして降りる段差の高さの上限（これより高い崖は側面へ脚を掛けて降りる）・探す深さ */
  stepMax: 0.8,
  depth: 1.6,
  /** 縁で待つときの体の中心のはみ出しの上限（崖・足場が無い）と、段差で身を乗り出す上限・そのとき下げてよい高さ */
  holdOver: 0.03,
  leanOver: 0.14,
  /** 胴体を下ろしている途中で支えが足りなくなっても、踏み替えの間は待つ時間 */
  looseT: 0.25,
  /** 下の足場に掛かった脚がこの本数以上で胴体が縁を越える・胴体を下ろす速さ（/ 秒） */
  needDown: 2,
  descRate: 1.0,
  /** 下に隙間がある間の水平の速さ：隙間がこれだけあると最小（minK） */
  gapSlow: 0.3,
  minK: 0.3,
  /** 縁へ近づくときの減速（はみ出しの上限までの距離 × これ = 縁へ向かう速さの上限） */
  approachK: 7,
  /** 足場が見つからないまま押し続けたら踏み出す時間（足場が無い・段差 / 崖で脚が掛からない） */
  holdT: 0.6,
  holdTMax: 1.4,
  /** 崖：側面に掛かった脚の本数（足りなくても holdFace 秒待って 1 本あれば）・回り込む速さ */
  needFace: 2,
  holdFace: 0.5,
  climbSpeed: 0.85,
} as const;

/** 真下へ探った最初の上面（y0 が固体の中なら y0 = 前方は壁・上り。max より深ければ y0 − max） */
function below(w: AquariumWorld, x: number, y0: number, z: number, max: number): number {
  let py = y0;
  if (w.contactSolid(x, py, z) < 0.01) return y0;
  for (let i = 0; i < 48; i++) {
    const d = w.contactSolid(x, py, z);
    if (d < 0.01) return py;
    py -= Math.max(d * 0.9, 0.02);
    if (py < y0 - max) return y0 - max;
  }
  return py;
}

/** 足元（footY）から真下の足場までの隙間（max まで） */
export function gapBelow(w: AquariumWorld, x: number, footY: number, z: number, max: number): number {
  return footY + 0.05 - below(w, x, footY + 0.05, z, max + 0.05);
}

/**
 * 前方の縁を探す：(x, footY, z) から水平の単位 (ux, uz) の向きへ。縁が無い（平ら・緩い下り・上り・壁）なら null。
 * 戻り値：縁までの距離（a）・縁の上の高さ（lipY）・下の足場までの高さ（drop。深さ LEDGE.depth で切る）・縁の外向き（e）
 */
export function scanLedge(w: AquariumWorld, x: number, footY: number, z: number, ux: number, uz: number): { a: number; lipY: number; drop: number; e: [number, number, number] } | null {
  const S = LEDGE.scanStep;
  const step = LEDGE.slopeDrop * (S / 0.05);
  let prev = footY;
  for (let i = 1; i <= LEDGE.scanN; i++) {
    const a = i * S;
    const g = below(w, x + ux * a, footY + 0.3, z + uz * a, 0.3 + LEDGE.depth);
    // 上り・壁：その先は探さない
    if (g > prev + 0.25) return null;
    if (prev - g > step) {
      // 下の足場：この点と、もう少し先の点（0.3・0.6 先）のいちばん低い所（急な斜面・丸い岩の側面の途中を拾わない）
      let gl = g;
      for (const ex of [0.3, 0.6]) gl = Math.min(gl, below(w, x + ux * (a + ex), footY + 0.3, z + uz * (a + ex), 0.3 + LEDGE.depth));
      const drop = prev - gl;
      if (drop < LEDGE.minDrop) {
        prev = g;
        continue;
      }
      const la = a - S * 0.5;
      // 縁の外向き：縁の少し外・下の点（空いている所）から、いちばん近い面（縁の側面）へ向かう勾配の逆＝水平の成分
      const qx = x + ux * (la + 0.1), qy = prev - 0.15, qz = z + uz * (la + 0.1);
      const n = w.contactNormal(qx, qy, qz);
      const hl = Math.hypot(n[0], n[2]);
      let e: [number, number, number] = [ux, 0, uz];
      if (hl > 0.3 && (n[0] * ux + n[2] * uz) / hl > 0.3) e = [n[0] / hl, 0, n[2] / hl];
      return { a: la, lipY: prev, drop, e };
    }
    prev = g;
  }
  return null;
}

/**
 * 崖の側面が登れる面で、縁のすぐ下にあるか（脚を掛けて降りられるか）。縁の下 0.3 の高さで、縁から外へ 0〜0.5 の所に
 * 登れる面（climbSolid）が体の半径 + 0.12 以内にあれば true
 */
export function faceBelow(w: AquariumWorld, lip: readonly number[], e: readonly number[]): boolean {
  const y = lip[1] - 0.3;
  for (let b = 0; b <= 0.5001; b += 0.1) {
    if (w.climbSolid(lip[0] + e[0] * b, y, lip[2] + e[2] * b) < 0.12) return true;
  }
  return false;
}

/**
 * 崖を降り始める道：いまの体の中心 → 縁の上（縁の少し外・縁の高さ + 半径）→ 縁の下の側面（縁の 0.35 下で、
 * 側面から体の半径の所）。途中がすべて体の入る隙間で、着いた所が登れる面のそばなら、その折れ線。無ければ null
 */
export function descentPath(w: AquariumWorld, c: readonly number[], lip: readonly number[], e: readonly number[], R: number): [number, number, number][] | null {
  const free = (p: readonly number[], q: readonly number[]) => {
    const L = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    const k = Math.max(1, Math.ceil(L / 0.05));
    for (let i = 1; i <= k; i++) {
      const f = i / k;
      if (w.contactSolid(p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f, p[2] + (q[2] - p[2]) * f) < R - 0.03) return false;
    }
    return true;
  };
  const p0: [number, number, number] = [c[0], c[1], c[2]];
  for (const out of [0.05, 0.12, 0.2]) {
    const p1: [number, number, number] = [lip[0] + e[0] * out, Math.max(c[1], lip[1] + R + 0.02), lip[2] + e[2] * out];
    if (!free(p0, p1)) continue;
    for (const dn of [0.35, 0.28, 0.45]) {
      const y = lip[1] - dn;
      // 側面から体の半径の所（外から内へ探す）
      for (let b = 0.7; b >= 0; b -= 0.04) {
        const q: [number, number, number] = [lip[0] + e[0] * b, y, lip[2] + e[2] * b];
        const d = w.contactSolid(q[0], q[1], q[2]);
        if (d < R) {
          const p2: [number, number, number] = [lip[0] + e[0] * (b + 0.04), y, lip[2] + e[2] * (b + 0.04)];
          if (w.contactSolid(p2[0], p2[1], p2[2]) < R - 0.03) break;
          if (w.climbSolid(p2[0], p2[1], p2[2]) > R + 0.1) break;
          if (free(p1, p2)) return [p0, p1, p2];
          break;
        }
      }
    }
  }
  return null;
}
