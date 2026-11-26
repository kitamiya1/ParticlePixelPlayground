// 画面の表示の設定（保存データとは別に localStorage `ppp-aquarium:ui` へ覚える）。
// - ボタンの大きさ（btnScale：1 = 以前の大きさ。既定 0.75 = 25% 小さく）と背景の濃さ（btnAlpha：既定 0.25）
// - 案内（guides：既定 false）：挟める物の輪・「挟める」「挟む：巻貝」「重い石」などの文字・引っこ抜きの手応えの輪と言葉・
//   「スポン！」の文字・天井歩きの矢印・操作の知らせ。ふだんは出さず、カニや物の動き・音・物理の反応で伝える。
//   ?diag で開いたときは出す（覚えない）。保存の失敗・競合・拡大などの警告は設定によらず出す
// - カメラの方式（camStyle：第 2 段階）
// 設定の欄は右上の「🔊」（音と設定）の中。

export const UI_KEY = 'ppp-aquarium:ui';

/** 冒険カメラの方式（第 2 段階）。classic = 従来、tps = 改良型三人称、close = 肩越し・一人称、free = 自由追従 */
export type CamStyle = 'classic' | 'tps' | 'close' | 'free';
export const CAM_STYLE_LABEL: Record<CamStyle, string> = { classic: '従来', tps: '三人称', close: '肩越し', free: '自由追従' };

/** 歩き方（第 4 段階）。cycle = 従来（歩行周期）、ik = 接地 IK */
export type GaitStyle = 'cycle' | 'ik';

/** 水草をかき分ける方式（第 3 段階）。dyn = 近くの植物だけばね、gpu = GPU だけ（状態なし） */
export type PlantStyle = 'dyn' | 'gpu';

export interface UiPrefs {
  btnScale: number;
  btnAlpha: number;
  guides: boolean;
  camStyle: CamStyle;
  gait: GaitStyle;
  plants: PlantStyle;
  /** 接地 IK の診断の表示（第 4 段階） */
  footDiag: boolean;
  /** 操作ボタンの名前を印の下に出す（第 6 段階。既定 false：絵だけ。初回は説明を閉じるまで出す） */
  labels: boolean;
}

export const UI_DEFAULTS: UiPrefs = { btnScale: 0.75, btnAlpha: 0.25, guides: false, camStyle: 'tps', gait: 'ik', plants: 'dyn', footDiag: false, labels: false };
export const BTN_SCALE_RANGE: [number, number] = [0.55, 1.1];
export const BTN_ALPHA_RANGE: [number, number] = [0.08, 0.6];

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const CAMS: CamStyle[] = ['classic', 'tps', 'close', 'free'];

export class UiPrefStore {
  prefs: UiPrefs;
  private readonly listeners: ((p: UiPrefs) => void)[] = [];

  /** force：URL などで決めた値（覚えない） */
  constructor(private readonly force: Partial<UiPrefs> = {}) {
    this.prefs = { ...readPrefs(), ...force };
  }

  onChange(fn: (p: UiPrefs) => void) {
    this.listeners.push(fn);
    fn(this.prefs);
  }

  set(part: Partial<UiPrefs>) {
    const p = { ...this.prefs, ...part };
    p.btnScale = clamp(p.btnScale, ...BTN_SCALE_RANGE);
    p.btnAlpha = clamp(p.btnAlpha, ...BTN_ALPHA_RANGE);
    if (!CAMS.includes(p.camStyle)) p.camStyle = UI_DEFAULTS.camStyle;
    if (p.gait !== 'cycle' && p.gait !== 'ik') p.gait = UI_DEFAULTS.gait;
    if (p.plants !== 'dyn' && p.plants !== 'gpu') p.plants = UI_DEFAULTS.plants;
    this.prefs = p;
    // URL で決めた値は覚えない（覚えている値の方を残す）
    const keep = { ...readPrefs(), ...p };
    for (const k of Object.keys(this.force) as (keyof UiPrefs)[]) if (!(k in part)) (keep as unknown as Record<string, unknown>)[k] = readPrefs()[k];
    writePrefs(keep);
    for (const fn of this.listeners) fn(p);
  }
}

function readPrefs(): UiPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(UI_KEY) ?? 'null');
    if (v && typeof v === 'object') {
      return {
        btnScale: typeof v.btnScale === 'number' ? clamp(v.btnScale, ...BTN_SCALE_RANGE) : UI_DEFAULTS.btnScale,
        btnAlpha: typeof v.btnAlpha === 'number' ? clamp(v.btnAlpha, ...BTN_ALPHA_RANGE) : UI_DEFAULTS.btnAlpha,
        guides: typeof v.guides === 'boolean' ? v.guides : UI_DEFAULTS.guides,
        camStyle: CAMS.includes(v.camStyle) ? v.camStyle : UI_DEFAULTS.camStyle,
        gait: v.gait === 'cycle' || v.gait === 'ik' ? v.gait : UI_DEFAULTS.gait,
        plants: v.plants === 'dyn' || v.plants === 'gpu' ? v.plants : UI_DEFAULTS.plants,
        footDiag: typeof v.footDiag === 'boolean' ? v.footDiag : UI_DEFAULTS.footDiag,
        labels: typeof v.labels === 'boolean' ? v.labels : UI_DEFAULTS.labels,
      };
    }
  } catch {
    /* 読めなければ既定 */
  }
  return { ...UI_DEFAULTS };
}

function writePrefs(p: UiPrefs) {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify(p));
  } catch {
    /* 覚えられない環境では、このページの間だけ */
  }
}

/**
 * 設定の欄（音の欄の下）に「操作ボタン」「表示」「カメラ」「歩き方」の段を足す。touch = false では操作ボタンの段を出さない
 */
export function mountUiPrefs(panel: HTMLElement, store: UiPrefStore, opts: { touch: boolean; cam?: boolean; gait?: boolean; plants?: boolean }) {
  const sec = document.createElement('div');
  sec.className = 'ui-prefs';
  sec.innerHTML = `${opts.touch ? `
    <div class="sec">操作ボタン</div>
    <label class="row">大きさ <input type="range" min="${BTN_SCALE_RANGE[0] * 100}" max="${BTN_SCALE_RANGE[1] * 100}" step="5" data-k="scale"><span data-k="sv"></span></label>
    <label class="row">濃さ <input type="range" min="${BTN_ALPHA_RANGE[0] * 100}" max="${BTN_ALPHA_RANGE[1] * 100}" step="2" data-k="alpha"><span data-k="av"></span></label>
    <label class="row"><input type="checkbox" data-k="labels"> ボタンの名前を表示（ジャンプ・ダッシュ・掘る・挟む・視点）</label>` : ''}${opts.cam ? `
    <div class="sec">冒険カメラの方式（視点の一覧・カメラのボタンでも選べる）</div>
    <div class="row seg" data-k="cam">${CAMS.map((c) => `<button type="button" data-v="${c}">${CAM_STYLE_LABEL[c]}</button>`).join('')}</div>` : ''}${opts.gait ? `
    <div class="sec">歩き方</div>
    <div class="row seg" data-k="gait"><button type="button" data-v="ik">接地 IK</button><button type="button" data-v="cycle">従来</button></div>
    <label class="row"><input type="checkbox" data-k="footdiag"> 接地の診断を表示（足先・次の足場・届く範囲・支え）</label>` : ''}${opts.plants ? `
    <div class="sec">水草のかき分け</div>
    <div class="row seg" data-k="plants"><button type="button" data-v="dyn">しなる（近くだけ計算）</button><button type="button" data-v="gpu">GPU だけ</button></div>` : ''}
    <div class="sec">表示</div>
    <label class="row"><input type="checkbox" data-k="guides"> 案内を出す（挟める物の輪・物の名前・引っ張りの手応え・操作の知らせ）</label>
    <div class="row"><button type="button" data-k="reset">表示の設定を元に戻す</button></div>`;
  panel.appendChild(sec);
  const q = <T extends HTMLElement>(k: string) => sec.querySelector<T>(`[data-k="${k}"]`);
  const scale = q<HTMLInputElement>('scale'), alpha = q<HTMLInputElement>('alpha'), guides = q<HTMLInputElement>('guides')!;
  scale?.addEventListener('input', () => store.set({ btnScale: Number(scale.value) / 100 }));
  alpha?.addEventListener('input', () => store.set({ btnAlpha: Number(alpha.value) / 100 }));
  guides.addEventListener('change', () => store.set({ guides: guides.checked }));
  const lb = q<HTMLInputElement>('labels');
  lb?.addEventListener('change', () => store.set({ labels: lb.checked }));
  const fd = q<HTMLInputElement>('footdiag');
  fd?.addEventListener('change', () => store.set({ footDiag: fd.checked }));
  for (const b of sec.querySelectorAll<HTMLButtonElement>('[data-k="cam"] button')) b.addEventListener('click', () => store.set({ camStyle: b.dataset.v as CamStyle }));
  for (const b of sec.querySelectorAll<HTMLButtonElement>('[data-k="gait"] button')) b.addEventListener('click', () => store.set({ gait: b.dataset.v as GaitStyle }));
  for (const b of sec.querySelectorAll<HTMLButtonElement>('[data-k="plants"] button')) b.addEventListener('click', () => store.set({ plants: b.dataset.v as PlantStyle }));
  q('reset')!.addEventListener('click', () => store.set({ btnScale: UI_DEFAULTS.btnScale, btnAlpha: UI_DEFAULTS.btnAlpha, guides: UI_DEFAULTS.guides, labels: UI_DEFAULTS.labels }));
  store.onChange((p) => {
    if (scale) scale.value = String(Math.round(p.btnScale * 100));
    if (alpha) alpha.value = String(Math.round(p.btnAlpha * 100));
    const sv = q('sv'), av = q('av');
    if (sv) sv.textContent = `${Math.round(p.btnScale * 100)}%`;
    if (av) av.textContent = `${Math.round(p.btnAlpha * 100)}%`;
    guides.checked = p.guides;
    if (fd) fd.checked = p.footDiag;
    if (lb) lb.checked = p.labels;
    for (const b of sec.querySelectorAll<HTMLButtonElement>('[data-k="cam"] button')) b.classList.toggle('on', b.dataset.v === p.camStyle);
    for (const b of sec.querySelectorAll<HTMLButtonElement>('[data-k="gait"] button')) b.classList.toggle('on', b.dataset.v === p.gait);
    for (const b of sec.querySelectorAll<HTMLButtonElement>('[data-k="plants"] button')) b.classList.toggle('on', b.dataset.v === p.plants);
  });
}
