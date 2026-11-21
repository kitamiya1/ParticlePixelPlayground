// 画面右側の日本語調整パネル。設定オブジェクトを直接書き換え、描画側は毎フレームそれを参照する。

import { BUILTIN_PRESETS, DEFAULT_SETTINGS, METHOD_LETTER, METHOD_NAME, VOXEL_CHAR_SIZES, VOXEL_DECOR_LEVELS, VOXEL_SIZES, cloneSettings, type RenderMethod, type RenderSettings } from '../settings';
import { PALETTES } from '../render/palettes';
import { builtinPreset, deleteUserPreset, downloadJSON, readJSONFile, saveCurrent, saveUserPreset, userPresets } from './presets';

type Key = keyof RenderSettings;
/** only: その描画方式でだけ効く設定（ほかの方式では UI 上で区別して無効表示にする） */
type Common = { key: Key; label: string; hint?: string; only?: RenderMethod[] };
type Control =
  | (Common & { type: 'range'; min: number; max: number; step: number; fmt?: (v: number) => string })
  | (Common & { type: 'select'; options: [string | number, string][] })
  | (Common & { type: 'check' });

const A_ONLY: RenderMethod[] = ['points'];
const B_ONLY: RenderMethod[] = ['splats'];
const C_ONLY: RenderMethod[] = ['surfels'];
const D_ONLY: RenderMethod[] = ['voxels'];
/** 点（粒・スプラット・円盤）で描く方式（A・B・C）だけで効く設定。D は格子なので点の密度・吸着の概念がない */
const ABC: RenderMethod[] = ['points', 'splats', 'surfels'];
/** 粒・円盤の中心を吸着する方式（A と C） */
const AC: RenderMethod[] = ['points', 'surfels'];
/** 深度を書く方式（A・C・D）だけで効く設定 */
const ACD: RenderMethod[] = ['points', 'surfels', 'voxels'];
const METHOD_OPTIONS: [string, string][] = [['points', 'A：ポイント描画（既存）'], ['splats', 'B：Pixel Art Gaussian Splats'], ['surfels', 'C：サーフェル（円盤＋深度）'], ['voxels', 'D：ボクセル（立方体＋深度）']];

const SECTIONS: { title: string; open?: boolean; controls: Control[] }[] = [
  {
    title: '表示比較',
    open: true,
    controls: [
      { type: 'select', key: 'renderMethod', label: '描画方式', options: METHOD_OPTIONS, hint: '切り替えてもカメラとキャラクターの位置は保たれます' },
      { type: 'select', key: 'viewMode', label: '表示方式', options: [['particles', '選択した描画方式'], ['compare', '方式の左右比較（下で 2 方式を選択）'], ['mesh', '簡易メッシュ'], ['split', '左右比較（左:選択方式 / 右:メッシュ）']] },
      { type: 'select', key: 'compareLeft', label: '左右比較：左', options: METHOD_OPTIONS },
      { type: 'select', key: 'compareRight', label: '左右比較：右', options: METHOD_OPTIONS },
      { type: 'select', key: 'splatSource', label: '形状の生成方法（A・B・C 共通）', options: [['convert', '既存の粒データ'], ['sdf', '樹木・岩・キャラを SDF から生成']], hint: 'SDF：距離関数を合成して表面だけを取り出す手続き的生成。A・B・C は同じ形状データを使います。D は樹木・岩・キャラの立体を常に SDF の内外判定で作り、ここでは色を写す元の点群だけが変わります' },
    ],
  },
  {
    title: '描画解像度・粒',
    open: true,
    controls: [
      { type: 'range', key: 'pixelScale', label: '画素サイズ（描画解像度）', min: 1, max: 8, step: 1, fmt: (v) => `${v}倍`, hint: '大きいほど粗いドットになります' },
      { type: 'range', key: 'pointSize', label: '粒のサイズ', min: 0.3, max: 3, step: 0.05, only: A_ONLY },
      { type: 'range', key: 'density', label: '粒の密度', min: 0.05, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%`, only: ABC },
      { type: 'check', key: 'densityComp', label: '密度に応じて粒を大きくする', hint: '方式 B ではスプラットの広がりに掛かります', only: ABC },
      { type: 'check', key: 'pointSnap', label: '粒・円盤の中心を画素グリッドに吸着（ちらつき軽減）', only: AC },
    ],
  },
  {
    title: 'ガウス濃淡（方式 A の粒）',
    open: true,
    controls: [
      { type: 'range', key: 'gaussShade', label: 'ガウス濃淡の強さ', min: 0, max: 1, step: 0.01, only: A_ONLY },
      { type: 'range', key: 'gaussSharp', label: 'ガウス分布の鋭さ', min: 0.2, max: 8, step: 0.05, only: A_ONLY },
      { type: 'range', key: 'alphaCut', label: '粒の縁のしきい値', min: 0.01, max: 0.9, step: 0.01, only: A_ONLY },
      { type: 'check', key: 'alphaDither', label: '縁をディザで透過させる', only: A_ONLY },
    ],
  },
  {
    title: 'Gaussian Splats（方式 B）',
    open: true,
    controls: [
      { type: 'range', key: 'splatScale', label: 'スプラットの広がり', min: 0.3, max: 3, step: 0.05, only: B_ONLY },
      { type: 'range', key: 'splatFlat', label: '厚み（円盤 ↔ 球）', min: 0.02, max: 1, step: 0.01, only: B_ONLY, hint: '小さいほど面の向きに沿った平たい円盤になります' },
      { type: 'range', key: 'splatAniso', label: '縦方向の伸び（異方性）', min: 0.3, max: 3, step: 0.05, only: B_ONLY, hint: '円盤面内で世界の上方向へ伸ばします' },
      { type: 'range', key: 'splatFalloff', label: 'ガウスの減衰（0 = 平らな円盤）', min: 0, max: 1, step: 0.01, only: B_ONLY },
      { type: 'range', key: 'splatStdDev', label: '描画する範囲（標準偏差の倍数）', min: 1, max: 3.2, step: 0.05, only: B_ONLY, fmt: (v) => `${v.toFixed(2)}σ` },
      { type: 'check', key: 'splatCrisp', label: 'くっきり表示（被覆率で画素を塗る）', only: B_ONLY, hint: 'オフにするとガウスの濃淡を残したやわらかい表示になります' },
      { type: 'range', key: 'splatCoverage', label: '被覆のしきい値（くっきり表示）', min: 0.05, max: 0.98, step: 0.01, only: B_ONLY },
      { type: 'select', key: 'splatSupersample', label: 'スーパーサンプリング', options: [[1, 'なし（1 画素 1 サンプル）'], [2, '2×2（4 サンプルで判定）']], only: B_ONLY },
      { type: 'range', key: 'splatOpacity', label: 'スプラットの不透明度', min: 0.1, max: 1, step: 0.01, only: B_ONLY },
    ],
  },
  {
    title: 'サーフェル（方式 C）',
    open: true,
    controls: [
      { type: 'range', key: 'surfelScale', label: '円盤の大きさ', min: 0.3, max: 3, step: 0.05, only: C_ONLY, hint: '1 = 方式 A の粒と同じ直径。大きくすると隙間は減り、重ね塗りは増えます' },
      { type: 'check', key: 'surfelBillboard', label: '円盤を画面に向ける（比較用：面の向きを無視）', only: C_ONLY, hint: 'オンにすると方式 A に近い「画面に正対した円」になります' },
    ],
  },
  {
    title: 'ボクセル（方式 D）',
    open: true,
    controls: [
      { type: 'select', key: 'voxelSize', label: '粒度（浮き島のボクセルの大きさ）', options: VOXEL_SIZES.map((v) => [v, `${v}（${v <= 0.1 ? '細かい・生成が重い' : v >= 0.4 ? '粗いブロック' : '中間'}）`]), only: D_ONLY, hint: '1 個の立方体の一辺（ワールド単位）。変えるとボクセルを作り直します' },
      { type: 'select', key: 'voxelCharSize', label: 'キャラクターの粒度', options: VOXEL_CHAR_SIZES.map((v) => [v, String(v)]), only: D_ONLY, hint: 'キャラクターは浮き島とは別の細かさでボクセル化します（粗すぎると手足が消えます）' },
      { type: 'check', key: 'voxelFlowers', label: '花を立方体で立てる', only: D_ONLY, hint: '花の粒（緑以外の色）を、地面から立つ立方体にします。オフなら地面の色だけ' },
      { type: 'select', key: 'voxelDecor', label: '草の立体化（表示密度）', options: VOXEL_DECOR_LEVELS.map((v) => [v, v === 0 ? 'なし（地面の色だけ）' : `${Math.round(v * 100)}%`]), only: D_ONLY, hint: '草の粒のうち、立方体として地面から立てる割合。増やすと地面がでこぼこになり、側面の影で暗い点が増えます' },
      { type: 'range', key: 'voxelEdge', label: '立方体の縁の暗さ', min: 0, max: 0.6, step: 0.01, only: D_ONLY, hint: '面の縁 1 画素を暗くして、立方体の区切りを見せます' },
      { type: 'range', key: 'voxelAO', label: '隅の陰（AO）', min: 0, max: 1, step: 0.01, only: D_ONLY, hint: '隣のボクセルに囲まれた角ほど暗くします（立体感）' },
      { type: 'check', key: 'voxelCull', label: '裏向きの面の組を描かない（高速化）', only: D_ONLY, hint: '面を向きごとに 6 組に分け、カメラから見て裏向きの組を丸ごと省きます。見た目は変わりません' },
    ],
  },
  {
    title: '色数・ディザリング',
    open: true,
    controls: [
      { type: 'select', key: 'palette', label: 'カラーパレット', options: PALETTES.map((p) => [p.id, p.colors.length ? `${p.label}` : p.label]) },
      { type: 'range', key: 'colorLevels', label: '色数（階調制限時の各色段階）', min: 2, max: 16, step: 1, fmt: (v) => `${v}段階 (${v ** 3}色)` },
      { type: 'range', key: 'dither', label: 'ディザリングの強さ', min: 0, max: 1.5, step: 0.01 },
      { type: 'select', key: 'ditherMatrix', label: 'ディザパターン', options: [[2, '2×2'], [4, '4×4'], [8, '8×8']] },
    ],
  },
  {
    title: '輪郭',
    controls: [
      { type: 'range', key: 'outline', label: '輪郭の強さ', min: 0, max: 1, step: 0.01 },
      { type: 'range', key: 'outlineThresh', label: '輪郭を出す奥行き差', min: 0.05, max: 4, step: 0.05, only: ACD, hint: '方式 B は深度を書かないため、シルエット（被覆の境界）で輪郭を出します' },
      { type: 'range', key: 'outlineDarken', label: '輪郭の明るさ', min: 0, max: 1, step: 0.01 },
    ],
  },
  {
    title: '光と環境',
    controls: [
      { type: 'range', key: 'lightSteps', label: '陰影の段階（0 = なめらか）', min: 0, max: 8, step: 1 },
      { type: 'range', key: 'ambient', label: '環境光', min: 0, max: 1.6, step: 0.01 },
      { type: 'range', key: 'shadowStrength', label: '影の濃さ', min: 0, max: 1, step: 0.01 },
      { type: 'range', key: 'wind', label: '風の強さ', min: 0, max: 3, step: 0.01 },
      { type: 'range', key: 'fog', label: '空気遠近（霞）', min: 0, max: 1, step: 0.01 },
    ],
  },
  {
    title: 'カメラ',
    controls: [
      { type: 'select', key: 'projection', label: '投影方式', options: [['ortho', '平行投影（ドット絵向き）'], ['perspective', '透視投影']] },
      { type: 'range', key: 'fov', label: '視野角（透視投影）', min: 15, max: 75, step: 1, fmt: (v) => `${v}°` },
      { type: 'check', key: 'cameraSnap', label: 'カメラを画素単位に吸着（平行投影）' },
    ],
  },
];

export interface PanelCallbacks {
  onScreenshot(): void;
  onToggleViewing(): boolean;
  onToggleAutoRotate(): boolean;
  /** 比較・計測ツール */
  onCaptureAB(): void;
  onCaptureZoom(): void;
  onCapturePitch(): void;
  onGapAnalysis(): void;
  onFlickerTest(): void;
  onBenchmark(): void;
}

export class Panel {
  readonly root: HTMLElement;
  private readonly inputs = new Map<Key, { el: HTMLInputElement | HTMLSelectElement; val?: HTMLElement; ctl: Control; row: HTMLElement }>();
  private reportEl!: HTMLElement;
  private readonly statsEl: HTMLElement;
  private presetSelect!: HTMLSelectElement;
  private viewBtn!: HTMLButtonElement;
  private toast: HTMLElement;

  constructor(private readonly settings: RenderSettings, private readonly cb: PanelCallbacks) {
    this.root = document.createElement('aside');
    this.root.id = 'panel';
    this.root.innerHTML = `<header><h1>Particle Pixel Playground</h1><button class="mini" data-act="hide" title="H キーでも切り替え">隠す</button></header>`;
    this.statsEl = document.createElement('div');
    this.statsEl.className = 'stats';
    this.root.appendChild(this.statsEl);

    this.root.appendChild(this.buildActions());
    this.root.appendChild(this.buildCompare());
    this.root.appendChild(this.buildPresets());
    for (const sec of SECTIONS) this.root.appendChild(this.buildSection(sec.title, sec.controls, sec.open));

    this.toast = document.createElement('div');
    this.toast.id = 'toast';
    document.body.appendChild(this.toast);
    document.body.appendChild(this.root);
    this.root.querySelector<HTMLButtonElement>('[data-act=hide]')!.onclick = () => this.toggle();
    // パネルが隠れているときに開くためのボタン（キーボードの無い端末向け）
    const open = document.createElement('button');
    open.id = 'panel-open';
    open.textContent = '設定';
    open.onclick = () => this.toggle();
    document.body.appendChild(open);
    // 小さな画面では最初は閉じておく
    if (window.matchMedia('(max-width: 760px)').matches) document.body.classList.add('panel-hidden');
    this.refresh();
  }

  toggle() {
    document.body.classList.toggle('panel-hidden');
  }

  notify(msg: string) {
    this.toast.textContent = msg;
    this.toast.classList.add('show');
    clearTimeout((this.toast as unknown as { _t: number })._t);
    (this.toast as unknown as { _t: number })._t = window.setTimeout(() => this.toast.classList.remove('show'), 1800);
  }

  setViewingLabel(viewing: boolean) {
    this.viewBtn.textContent = viewing ? '鑑賞モード：ON（V）' : '鑑賞モード：OFF（V）';
    this.viewBtn.classList.toggle('on', viewing);
  }

  private buildActions(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'actions';
    const btn = (label: string, fn: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = fn;
      wrap.appendChild(b);
      return b;
    };
    this.viewBtn = btn('鑑賞モード：OFF（V）', () => this.setViewingLabel(this.cb.onToggleViewing()));
    const ar = btn('自動回転：OFF', () => {
      const on = this.cb.onToggleAutoRotate();
      ar.textContent = on ? '自動回転：ON' : '自動回転：OFF';
      ar.classList.toggle('on', on);
    });
    btn('スクリーンショット保存（P）', () => this.cb.onScreenshot());
    btn('パラメーター初期化', () => {
      Object.assign(this.settings, cloneSettings(DEFAULT_SETTINGS));
      this.changed();
      this.notify('初期値に戻しました');
    });
    return wrap;
  }

  /** A/B 比較・計測ツール */
  private buildCompare(): HTMLElement {
    const det = document.createElement('details');
    det.open = true;
    det.innerHTML = `<summary>方式の比較・計測（A・B・C・D）</summary>`;
    const body = document.createElement('div');
    body.className = 'section-body';
    const grid = document.createElement('div');
    grid.className = 'actions tight';
    const btn = (label: string, title: string, fn: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.onclick = fn;
      grid.appendChild(b);
    };
    btn('A/B/C/D 同条件で撮影', '同じカメラ位置・描画解像度で A・B・C・D のスクリーンショットを続けて保存します', () => this.cb.onCaptureAB());
    btn('ズーム3段階を撮影', 'A・B・C・D をそれぞれズーム 3 段階で保存します（輪郭の変化の確認）', () => this.cb.onCaptureZoom());
    btn('見下ろし角3段階を撮影', 'A・B・C・D をそれぞれ見下ろし角 3 段階で保存します（浅い角度での円盤の隙間の確認）', () => this.cb.onCapturePitch());
    btn('隙間・重ね塗り解析', '基準形状のシルエットに対する隙間と、1 画素あたりの断片数を A・B・C・D で比べます', () => this.cb.onGapAnalysis());
    btn('ちらつき計測', 'カメラを一定速度で平行移動させ、フレーム間で変化した画素の割合を A・B・C・D で測ります', () => this.cb.onFlickerTest());
    btn('性能ベンチマーク', 'カメラを回しながら A・B・C・D それぞれの FPS・フレーム時間・GPU 時間を測ります', () => this.cb.onBenchmark());
    body.appendChild(grid);
    this.reportEl = document.createElement('div');
    this.reportEl.className = 'report';
    this.reportEl.textContent = '計測結果はここに表示されます';
    body.appendChild(this.reportEl);
    det.appendChild(body);
    return det;
  }

  /** 計測結果の表示（JSON はコピー用ボタン付き） */
  setReport(html: string, json?: unknown) {
    this.reportEl.innerHTML = html;
    if (json !== undefined) {
      const b = document.createElement('button');
      b.className = 'mini';
      b.textContent = '結果を JSON でコピー';
      b.onclick = async () => {
        try {
          await navigator.clipboard.writeText(JSON.stringify(json, null, 2));
          this.notify('コピーしました');
        } catch {
          this.notify('コピーできませんでした');
        }
      };
      this.reportEl.appendChild(b);
    }
  }

  private buildPresets(): HTMLElement {
    const det = document.createElement('details');
    det.open = true;
    det.innerHTML = `<summary>プリセット</summary>`;
    const body = document.createElement('div');
    body.className = 'section-body';
    this.presetSelect = document.createElement('select');
    const name = document.createElement('input');
    name.type = 'text';
    name.placeholder = '保存する名前';
    const row = (...els: HTMLElement[]) => {
      const d = document.createElement('div');
      d.className = 'row-buttons';
      els.forEach((e) => d.appendChild(e));
      body.appendChild(d);
    };
    const button = (label: string, fn: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = fn;
      return b;
    };
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = 'application/json,.json';
    file.style.display = 'none';
    file.onchange = async () => {
      const f = file.files?.[0];
      if (!f) return;
      try {
        const { name: n, settings } = await readJSONFile(f);
        Object.assign(this.settings, settings);
        saveUserPreset(n, settings);
        this.fillPresets(`user:${n}`);
        this.changed();
        this.notify(`「${n}」を読み込みました`);
      } catch {
        this.notify('JSON の読み込みに失敗しました');
      }
      file.value = '';
    };

    row(this.presetSelect);
    row(
      button('読み込み', () => {
        const v = this.presetSelect.value;
        if (v.startsWith('builtin:')) {
          const name = v.slice(8);
          // 描画方式を指定しないプリセットは、いま比較中の方式を変えない
          const keep = BUILTIN_PRESETS[name]?.renderMethod ? null : this.settings.renderMethod;
          Object.assign(this.settings, builtinPreset(name));
          if (keep) this.settings.renderMethod = keep;
        } else {
          const p = userPresets()[v.slice(5)];
          if (p) Object.assign(this.settings, p);
        }
        this.changed();
        this.notify(`「${v.slice(v.indexOf(':') + 1)}」を適用しました`);
      }),
      button('削除', () => {
        const v = this.presetSelect.value;
        if (!v.startsWith('user:')) return this.notify('組み込みプリセットは削除できません');
        deleteUserPreset(v.slice(5));
        this.fillPresets();
        this.notify('削除しました');
      }),
    );
    row(
      name,
      button('保存', () => {
        const n = name.value.trim() || `プリセット ${new Date().toLocaleTimeString('ja-JP')}`;
        saveUserPreset(n, this.settings);
        this.fillPresets(`user:${n}`);
        name.value = '';
        this.notify(`「${n}」を保存しました`);
      }),
    );
    row(
      button('JSON 書き出し', () => {
        const v = this.presetSelect.value;
        downloadJSON(v.startsWith('user:') ? v.slice(5) : 'current', this.settings);
      }),
      button('JSON 読み込み', () => file.click()),
    );
    body.appendChild(file);
    det.appendChild(body);
    this.fillPresets();
    return det;
  }

  private fillPresets(select?: string) {
    const s = this.presetSelect;
    s.innerHTML = '';
    const g1 = document.createElement('optgroup');
    g1.label = '組み込み';
    for (const k of Object.keys(BUILTIN_PRESETS)) g1.appendChild(new Option(k, `builtin:${k}`));
    s.appendChild(g1);
    const user = Object.keys(userPresets());
    if (user.length) {
      const g2 = document.createElement('optgroup');
      g2.label = '保存済み';
      for (const k of user) g2.appendChild(new Option(k, `user:${k}`));
      s.appendChild(g2);
    }
    if (select) s.value = select;
  }

  private buildSection(title: string, controls: Control[], open = false): HTMLElement {
    const det = document.createElement('details');
    det.open = open;
    det.innerHTML = `<summary>${title}</summary>`;
    const body = document.createElement('div');
    body.className = 'section-body';
    for (const ctl of controls) body.appendChild(this.buildControl(ctl));
    det.appendChild(body);
    return det;
  }

  private buildControl(ctl: Control): HTMLElement {
    const row = document.createElement('label');
    row.className = `ctl ctl-${ctl.type}`;
    if (ctl.hint) row.title = ctl.hint;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = ctl.label;
    if (ctl.only) {
      // 効く方式を A / B / C のバッジで示す（複数可）
      for (const m of [...ctl.only].reverse()) {
        const tag = document.createElement('em');
        tag.className = `only only-${m}`;
        tag.textContent = METHOD_LETTER[m];
        name.prepend(tag);
      }
      row.title = `${ctl.only.map((m) => METHOD_NAME[m]).join('・')} でだけ効く設定${ctl.hint ? `\n${ctl.hint}` : ''}`;
    }
    row.classList.toggle('has-only', Boolean(ctl.only));
    if (ctl.type === 'check') {
      const el = document.createElement('input');
      el.type = 'checkbox';
      el.onchange = () => {
        (this.settings[ctl.key] as boolean) = el.checked;
        this.changed(false);
      };
      row.append(el, name);
      this.inputs.set(ctl.key, { el, ctl, row });
    } else if (ctl.type === 'select') {
      const el = document.createElement('select');
      for (const [v, l] of ctl.options) el.appendChild(new Option(l, String(v)));
      el.onchange = () => {
        const cur = this.settings[ctl.key];
        (this.settings as unknown as Record<string, unknown>)[ctl.key] = typeof cur === 'number' ? Number(el.value) : el.value;
        this.changed(false);
        el.blur();
      };
      row.append(name, el);
      this.inputs.set(ctl.key, { el, ctl, row });
    } else {
      const val = document.createElement('span');
      val.className = 'val';
      const el = document.createElement('input');
      el.type = 'range';
      el.min = String(ctl.min);
      el.max = String(ctl.max);
      el.step = String(ctl.step);
      el.oninput = () => {
        (this.settings[ctl.key] as number) = Number(el.value);
        val.textContent = this.format(ctl, Number(el.value));
        this.changed(false);
      };
      el.onchange = () => el.blur();
      const head = document.createElement('div');
      head.className = 'head';
      head.append(name, val);
      row.append(head, el);
      this.inputs.set(ctl.key, { el, val, ctl, row });
    }
    return row;
  }

  private format(ctl: Control, v: number): string {
    if (ctl.type !== 'range') return String(v);
    if (ctl.fmt) return ctl.fmt(v);
    return ctl.step >= 1 ? String(v) : v.toFixed(2);
  }

  private changed(refresh = true) {
    if (refresh) this.refresh();
    else this.refreshAvailability();
    saveCurrent(this.settings);
  }

  /** 選択中の描画方式で効かない設定を区別して表示する（A/B 左右比較中はどちらも有効） */
  private refreshAvailability() {
    const s = this.settings;
    const active = new Set<RenderMethod>(s.viewMode === 'compare' ? [s.compareLeft, s.compareRight] : s.viewMode === 'mesh' ? [] : [s.renderMethod]);
    for (const { el, ctl, row } of this.inputs.values()) {
      if (!ctl.only) continue;
      const na = !ctl.only.some((m) => active.has(m));
      row.classList.toggle('na', na);
      el.disabled = na;
    }
    // くっきり表示をオフにしたら被覆しきい値は効かない
    const cov = this.inputs.get('splatCoverage');
    if (cov && !s.splatCrisp) {
      cov.row.classList.add('na');
      cov.el.disabled = true;
    }
    // 左右比較の左右の選択は、左右比較のときだけ有効
    for (const key of ['compareLeft', 'compareRight'] as const) {
      const c = this.inputs.get(key);
      if (!c) continue;
      const na = s.viewMode !== 'compare';
      c.row.classList.toggle('na', na);
      c.el.disabled = na;
    }
    document.body.classList.toggle('method-splats', s.renderMethod === 'splats');
    document.body.classList.toggle('method-surfels', s.renderMethod === 'surfels');
    document.body.classList.toggle('method-voxels', s.renderMethod === 'voxels');
  }

  /** 設定値 → UI へ反映 */
  refresh() {
    for (const [key, { el, val, ctl }] of this.inputs) {
      const v = this.settings[key];
      if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = Boolean(v);
      else el.value = String(v);
      if (val) val.textContent = this.format(ctl, Number(v));
    }
    this.refreshAvailability();
  }

  /** 外部（計測ツール等）から設定を書き換えた後に UI を合わせる */
  sync() {
    this.refresh();
  }

  setStats(html: string) {
    this.statsEl.innerHTML = html;
  }
}
