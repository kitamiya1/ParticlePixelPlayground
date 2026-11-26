// 景色の小石（AquariumBuild の buildPebbles、約 520 個）と、水槽の中の発見物の貝殻・巻貝を、どれでも挟めるようにする。
//
// 負荷を抑えるため、ふだんは物理の物にしない：
// - 景色の物は 1 つの大きなメッシュのまま描く。それぞれに楕円体の「影」（Prop。PropSystem の props には入れない）を
//   持たせ、挟む候補（GrabSystem.pick・狙いの補助）としてだけ調べる
// - 鋏を閉じた瞬間（GrabSystem.beginClose）に、その影を PropSystem へ入れて物理の物にする（promote）。
//   掘って足もとの砂が無くなった小石も物理の物にして落とす（DigFx の pebbleLost。数の上限を越えたら従来どおり消す）
// - 物理の物になっている間は、景色のメッシュのその物の頂点（と法線）を、物の位置・向きで毎フレーム書き直す
//   （元の頂点を覚えておき、置いた時の姿勢からの回転・移動を掛ける）。描画の部品は増やさない
// - 眠って（止まって）いて、挟んでいない・カニから DEMOTE_R より遠い物は、物理の物から外す（いまの位置のまま、景色に戻る）
// - 重さは大きさ（楕円体の体積）で決める。大きな石は重くて持ち上がらず、引きずる・動かない（カニの方が引っ張られる）
// - 物の位置は保存しない（読み込み直すと置いた所へ戻る。挟める物と同じ）
//
// 発見物（AquariumSpots の Find）の貝殻・巻貝は、場所の発見とは別の目印なので、動かしても発見の記録は変わらない。

import type * as THREE from 'three';
import { Prop, qrot, type PropKind, type PropSystem, type Q4, type V3 } from './AquaGrab';

/** 物理の物にしておく上限（これを越えたら遠くの眠っている物から景色へ戻す） */
const MAX_ACTIVE = 28;
/** カニからこれより遠い・眠っている物は景色へ戻す */
const DEMOTE_R = 2.6;

/** 景色の物 1 つ（頂点の範囲・置いた時の姿勢・楕円体） */
export interface DecorSource {
  /** 景色のメッシュ（頂点を書き換える） */
  geo: THREE.BufferGeometry;
  items: DecorItemDef[];
}

export interface DecorItemDef {
  kind: PropKind;
  name: string;
  /** 楕円体の中心（当たり判定）と半径・向き（y 軸まわり）・重さ */
  c: V3;
  semi: V3;
  yaw: number;
  mass: number;
  /** 頂点の範囲 */
  v0: number;
  vn: number;
}

interface Item {
  src: number;
  def: DecorItemDef;
  ghost: Prop;
  /** 置いた時の頂点・法線（世界）と、置いた時の中心・向きの逆 */
  pos0: Float32Array;
  nrm0: Float32Array;
  q0inv: Q4;
  active: boolean;
  /** 景色から消した（掘って根元の砂が無くなり、上限で物理の物にできなかった） */
  gone: boolean;
  /** 前に頂点を書いた姿勢（変わっていなければ書かない） */
  lastSig: number;
}

export class DecorProps {
  private readonly items: Item[] = [];
  private readonly srcs: DecorSource[];
  readonly stats = { total: 0, promoted: 0, demoted: 0, active: 0, fell: 0, hiddenByLimit: 0, writes: 0 };

  constructor(private readonly props: PropSystem, sources: DecorSource[]) {
    this.srcs = sources;
    sources.forEach((s, si) => {
      const P = s.geo.getAttribute('position') as THREE.BufferAttribute;
      const N = s.geo.getAttribute('normal') as THREE.BufferAttribute;
      P.setUsage(35048 /* THREE.DynamicDrawUsage */);
      N.setUsage(35048);
      s.items.forEach((def, k) => {
        const q: Q4 = [0, Math.sin(def.yaw / 2), 0, Math.cos(def.yaw / 2)];
        const ghost = new Prop(`decor${si}_${k}`, def.kind, 1, def.c, def.yaw, { semi: def.semi, mass: def.mass, name: def.name, q });
        ghost.decor = this.items.length;
        ghost.awake = false;
        this.items.push({
          src: si,
          def,
          ghost,
          pos0: (P.array as Float32Array).slice(def.v0 * 3, (def.v0 + def.vn) * 3),
          nrm0: (N.array as Float32Array).slice(def.v0 * 3, (def.v0 + def.vn) * 3),
          q0inv: [-q[0], -q[1], -q[2], q[3]],
          active: false,
          gone: false,
          lastSig: 0,
        });
      });
    });
    this.stats.total = this.items.length;
  }

  /** 挟む候補（まだ物理の物になっていない・消えていない影） */
  *ghosts(): Iterable<Prop> {
    for (const it of this.items) if (!it.active && !it.gone) yield it.ghost;
  }

  /** 影を物理の物にする（挟んだ瞬間・足もとの砂が無くなった） */
  promote(pr: Prop) {
    const it = this.items[pr.decor];
    if (!it || it.active) return;
    it.active = true;
    pr.wake();
    this.props.props.push(pr);
    this.stats.promoted++;
    this.trim();
  }

  /**
   * 掘って根元の砂が無くなった景色の小石（DigFx の pebbleLost。source 0 の番号）：物理の物にして落とす。
   * 上限で物理の物にできなければ false（DigFx が従来どおり消す）
   */
  pebbleLost(k: number): boolean {
    // 景色の小石（source 0）は最初に並べたので、番号がそのまま items の番号
    const it = this.srcs.length && k < this.srcs[0].items.length ? this.items[k] : undefined;
    if (!it) return false;
    if (it.active) return true;
    if (this.activeCount() >= MAX_ACTIVE && !this.trim(true)) {
      it.gone = true;
      this.stats.hiddenByLimit++;
      return false;
    }
    this.promote(it.ghost);
    this.stats.fell++;
    return true;
  }

  private activeCount(): number {
    let n = 0;
    for (const it of this.items) if (it.active) n++;
    return n;
  }

  /** 上限を越えたら、眠っていて挟んでいない物のうちいちばん古い物を景色へ戻す。force なら上限ちょうどでも 1 つ空ける */
  private trim(force = false): boolean {
    let n = this.activeCount();
    let freed = false;
    while (n > MAX_ACTIVE - (force ? 1 : 0)) {
      const victim = this.props.props.find((p) => p.decor >= 0 && !p.awake && !p.held);
      if (!victim) break;
      this.demote(victim);
      n--;
      freed = true;
    }
    return freed;
  }

  private demote(pr: Prop) {
    const it = this.items[pr.decor];
    const i = this.props.props.indexOf(pr);
    if (i >= 0) this.props.props.splice(i, 1);
    it.active = false;
    pr.awake = false;
    this.stats.demoted++;
  }

  /**
   * 毎フレーム（物の時間を進めた後）：物理の物になっている景色の物の頂点を書き直し、遠くで眠っている物を景色へ戻す
   */
  update(crab: { x: number; y: number; z: number }) {
    let active = 0;
    for (const it of this.items) {
      if (!it.active) continue;
      active++;
      const pr = it.ghost;
      this.write(it);
      if (!pr.awake && !pr.held && Math.hypot(pr.p[0] - crab.x, pr.p[1] - crab.y, pr.p[2] - crab.z) > DEMOTE_R) {
        this.demote(pr);
        active--;
      }
    }
    this.stats.active = active;
  }

  /** 物の姿勢で頂点・法線を書く（置いた時からの回転 qd = q · q0⁻¹ と移動） */
  private write(it: Item) {
    const pr = it.ghost;
    const sig = pr.p[0] * 1.3 + pr.p[1] * 2.1 + pr.p[2] * 3.7 + pr.q[0] * 5.1 + pr.q[1] * 7.3 + pr.q[2] * 11.9 + pr.q[3] * 13.1;
    if (sig === it.lastSig) return;
    it.lastSig = sig;
    const geo = this.srcs[it.src].geo;
    const P = geo.getAttribute('position') as THREE.BufferAttribute;
    const N = geo.getAttribute('normal') as THREE.BufferAttribute;
    const pa = P.array as Float32Array, na = N.array as Float32Array;
    const qd = qmul(pr.q, it.q0inv);
    const c = it.def.c;
    const t: V3 = [0, 0, 0];
    const v0 = it.def.v0, vn = it.def.vn;
    for (let v = 0; v < vn; v++) {
      const o = v * 3;
      qrot(qd, it.pos0[o] - c[0], it.pos0[o + 1] - c[1], it.pos0[o + 2] - c[2], t);
      pa[(v0 + v) * 3] = pr.p[0] + t[0];
      pa[(v0 + v) * 3 + 1] = pr.p[1] + t[1];
      pa[(v0 + v) * 3 + 2] = pr.p[2] + t[2];
      qrot(qd, it.nrm0[o], it.nrm0[o + 1], it.nrm0[o + 2], t);
      na[(v0 + v) * 3] = t[0];
      na[(v0 + v) * 3 + 1] = t[1];
      na[(v0 + v) * 3 + 2] = t[2];
    }
    P.addUpdateRange(v0 * 3, vn * 3);
    N.addUpdateRange(v0 * 3, vn * 3);
    P.needsUpdate = true;
    N.needsUpdate = true;
    this.stats.writes++;
  }

  /** 自動検証用：番号の景色の物（影）と、物理の物になっているか */
  item(i: number): { prop: Prop; active: boolean; gone: boolean; name: string; src: number; v0: number } | null {
    const it = this.items[i];
    return it ? { prop: it.ghost, active: it.active, gone: it.gone, name: it.def.name, src: it.src, v0: it.def.v0 } : null;
  }

  get count(): number {
    return this.items.length;
  }


}

function qmul(a: Q4, b: Q4): Q4 {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
