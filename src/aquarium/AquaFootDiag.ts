// 接地 IK の診断の表示（第 4 段階）：「🔊 音と設定」の「接地の診断」・?diag のときだけ。画面全体の透明な Canvas に、
// 脚ごとの 足先（接地 = 緑 / 足場が無い = 赤 / 踏み替え中 = 水色）・次の足場の候補（黄の ×）・付け根から届く範囲（細い円。
// 付け根の位置で、届く長さを画面の大きさへ直した半径）・付け根 → 足先の線、と左上の小さな数字（接地している脚・
// 張り付いた面に掛かっている脚・伸びの最大・速さの割合）を描く。

import type { CrabFeet } from './CrabFeet';

type Project = (x: number, y: number, z: number) => { x: number; y: number } | null;

export class FootDiag {
  on = false;
  private readonly cv: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private shown = false;

  constructor() {
    this.cv = document.createElement('canvas');
    this.cv.id = 'foot-diag';
    this.cv.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:2;display:none';
    document.body.appendChild(this.cv);
    this.g = this.cv.getContext('2d')!;
  }

  draw(feet: CrabFeet | null, project: Project, active: boolean) {
    const show = this.on && !!feet && active;
    if (show !== this.shown) {
      this.cv.style.display = show ? 'block' : 'none';
      this.shown = show;
    }
    if (!show || !feet) return;
    const W = this.cv.clientWidth, H = this.cv.clientHeight;
    if (this.cv.width !== W || this.cv.height !== H) {
      this.cv.width = W;
      this.cv.height = H;
    }
    const g = this.g;
    g.clearRect(0, 0, W, H);
    g.lineWidth = 1.5;
    for (const f of feet.feet) {
      const hp = project(f.hip[0], f.hip[1], f.hip[2]);
      const fp = project(f.pos[0], f.pos[1], f.pos[2]);
      const np = project(f.next[0], f.next[1], f.next[2]);
      if (hp && fp) {
        g.strokeStyle = 'rgba(255,255,255,0.55)';
        g.beginPath();
        g.moveTo(hp.x, hp.y);
        g.lineTo(fp.x, fp.y);
        g.stroke();
      }
      if (hp) {
        // 届く範囲：付け根から届く長さ分ずらした点を投影して、画面の半径にする
        const rp = project(f.hip[0] + f.reach, f.hip[1], f.hip[2]);
        if (rp) {
          g.strokeStyle = 'rgba(180,220,255,0.25)';
          g.beginPath();
          g.arc(hp.x, hp.y, Math.hypot(rp.x - hp.x, rp.y - hp.y), 0, Math.PI * 2);
          g.stroke();
        }
      }
      if (fp) {
        g.fillStyle = f.swing ? 'rgba(120,220,255,0.95)' : f.valid ? 'rgba(120,255,140,0.95)' : 'rgba(255,90,80,0.95)';
        g.beginPath();
        g.arc(fp.x, fp.y, 4, 0, Math.PI * 2);
        g.fill();
      }
      if (np) {
        g.strokeStyle = 'rgba(255,230,90,0.9)';
        g.beginPath();
        g.moveTo(np.x - 4, np.y - 4);
        g.lineTo(np.x + 4, np.y + 4);
        g.moveTo(np.x + 4, np.y - 4);
        g.lineTo(np.x - 4, np.y + 4);
        g.stroke();
      }
    }
    const S = feet.support;
    g.font = '12px ui-monospace, Menlo, Consolas, monospace';
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.fillRect(8, H - 64, 300, 54);
    g.fillStyle = '#d8fff4';
    g.fillText(`接地 ${S.planted}/8  面に掛かる ${S.onClimb}  伸び ${S.maxStretch.toFixed(2)}`, 14, H - 46);
    g.fillText(`速さ ×${S.speed.toFixed(2)}${S.lost ? '  支えを失った' : ''}  踏み替え ${feet.stats.steps}`, 14, H - 30);
    g.fillText(`探索 ${feet.stats.probes}  ${feet.stats.ms.toFixed(2)} ms`, 14, H - 14);
  }
}
