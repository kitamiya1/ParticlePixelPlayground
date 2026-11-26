// 効果音（Web Audio API でその場で合成する。音の素材ファイルは使わない = すべてこのゲームのための音）。
// - 引っ張っている間：砂のこすれる音（ノイズを帯域フィルターに通す。張力・こすれ・引き出しの速さで大きく・明るく）と、
//   踏ん張る低い唸り（張力が高いほど音程が上がる）。生き物が引き戻した・暴れた瞬間に短い「ぐっ」
// - 抜けた瞬間：「スポン！」（高い音から一気に下がる短い音 + 栓が抜けるような破裂のノイズ + 泡の粒の音）
// - 滑った：きしむ音。挟んだ・離した：小さなカチッ。泡：ぷくっ
// 音量とミュートは localStorage（ppp-aquarium:audio）に覚える。
// iPhone の Safari：AudioContext は利用者の操作（タッチ・クリック・キー）の中でないと音が出ないので、最初の操作で作って
// resume し、無音の短い音を鳴らして鳴る状態にする（unlock）。裏へ回ったら suspend、戻ったら次の操作で resume。
// 本体の消音スイッチ（マナーモード）が入っていると Web Audio は鳴らない端末がある（ゲームからは変えられない）。

export const AUDIO_KEY = 'ppp-aquarium:audio';

export interface AudioPrefs {
  /** 0..1 */
  volume: number;
  muted: boolean;
}

export class AquaAudio {
  ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  /** 砂のこすれ（ループのノイズ → 帯域 → 音量） */
  private scrape: { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode } | null = null;
  /** 踏ん張りの唸り（のこぎり波 → 低域 → 音量） */
  private strain: { osc: OscillatorNode; filter: BiquadFilterNode; gain: GainNode } | null = null;
  prefs: AudioPrefs = { volume: 0.7, muted: false };
  readonly stats = { unlocks: 0, plays: 0, state: 'none' as string, lastError: '' };
  /** 状態が変わったとき（設定の欄の表示） */
  onChange: () => void = () => {};

  constructor() {
    this.prefs = readPrefs();
    // 最初の利用者の操作で作る・止まっていれば再開する（iOS は touchend / click の中で resume する必要がある）
    const unlock = () => this.unlock();
    for (const t of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'] as const) window.addEventListener(t, unlock, { capture: true, passive: true });
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.visibilityState === 'hidden') void this.ctx.suspend().catch(() => {});
    });
  }

  /** 利用者の操作の中で呼ぶ：AudioContext を作る・再開する */
  unlock() {
    try {
      if (!this.ctx) {
        const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!C) {
          this.stats.state = 'unsupported';
          return;
        }
        this.ctx = new C();
        this.master = this.ctx.createGain();
        this.master.connect(this.ctx.destination);
        this.applyVolume();
        this.noiseBuf = this.makeNoise(1.5);
        // 無音の短い音（iOS で鳴る状態にする）
        const b = this.ctx.createBuffer(1, 1, 22050);
        const s = this.ctx.createBufferSource();
        s.buffer = b;
        s.connect(this.master);
        s.start(0);
        this.stats.unlocks++;
      }
      if (this.ctx.state !== 'running') void this.ctx.resume().then(() => this.onChange()).catch((e) => (this.stats.lastError = String(e)));
      this.stats.state = this.ctx.state;
    } catch (e) {
      this.stats.lastError = String(e);
    }
  }

  get ready(): boolean {
    return !!this.ctx && this.ctx.state === 'running' && !!this.master;
  }

  setVolume(v: number) {
    this.prefs.volume = Math.max(0, Math.min(1, v));
    this.applyVolume();
    writePrefs(this.prefs);
    this.onChange();
  }

  setMuted(m: boolean) {
    this.prefs.muted = m;
    this.applyVolume();
    writePrefs(this.prefs);
    if (m) this.setTug(null);
    this.onChange();
  }

  private applyVolume() {
    if (!this.master || !this.ctx) return;
    const v = this.prefs.muted ? 0 : this.prefs.volume * this.prefs.volume;
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  private makeNoise(sec: number): AudioBuffer {
    const ctx = this.ctx!;
    const n = Math.floor(ctx.sampleRate * sec);
    const b = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = b.getChannelData(0);
    // 少し低い方へ寄せたノイズ（砂のざらつき）
    let last = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      last = last * 0.55 + w * 0.45;
      d[i] = last;
    }
    return b;
  }

  private canPlay(): boolean {
    return this.ready && !this.prefs.muted && this.prefs.volume > 0.001;
  }

  /**
   * 引っ張っている間の音（毎フレーム）。null で止める。load = 張力 / 握る力（0..1+）、rub = 縁にこすれる強さ、
   * extV = 引き出しの速さ、env = 暴れる強さ（0..1）
   */
  setTug(t: { load: number; rub: number; extV: number; env: number } | null) {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;
    if (!t || !this.canPlay()) {
      if (this.scrape) {
        this.scrape.gain.gain.setTargetAtTime(0, now, 0.06);
        const s = this.scrape;
        this.scrape = null;
        s.src.stop(now + 0.4);
      }
      if (this.strain) {
        this.strain.gain.gain.setTargetAtTime(0, now, 0.06);
        const s = this.strain;
        this.strain = null;
        s.osc.stop(now + 0.4);
      }
      return;
    }
    if (!this.scrape) {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.Q.value = 1.4;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(this.master);
      src.start();
      this.scrape = { src, filter, gain };
    }
    if (!this.strain) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 260;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(filter).connect(gain).connect(this.master);
      osc.start();
      this.strain = { osc, filter, gain };
    }
    const load = Math.max(0, Math.min(1.3, t.load));
    // こすれ：張っているほど・引き出しているほど大きく、張力で明るく（高く）なる
    const sg = Math.min(0.55, 0.04 + load * 0.22 + Math.min(1, t.rub * 0.4) * 0.12 + Math.min(1, t.extV * 6) * 0.25);
    this.scrape.gain.gain.setTargetAtTime(sg, now, 0.05);
    this.scrape.filter.frequency.setTargetAtTime(380 + load * 1500 + t.env * 600, now, 0.05);
    // 踏ん張り：強く張ったときだけ。張力で音程が上がる（ぐぐぐ…）
    const strainG = load > 0.45 ? Math.min(0.12, (load - 0.45) * 0.22) : 0;
    this.strain.gain.gain.setTargetAtTime(strainG, now, 0.08);
    this.strain.osc.frequency.setTargetAtTime(58 + load * 70 + t.env * 25, now, 0.08);
    this.strain.filter.frequency.setTargetAtTime(200 + load * 260, now, 0.08);
  }

  /** 短い「ぐっ」（生き物が引き戻した・暴れた）。level 0..1 */
  grunt(level: number) {
    if (!this.canPlay()) return;
    const ctx = this.ctx!, now = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(150 + level * 60, now);
    o.frequency.exponentialRampToValueAtTime(70, now + 0.14);
    const g = this.env(now, 0.005, 0.16, 0.16 + level * 0.14);
    o.connect(g).connect(this.master!);
    o.start(now);
    o.stop(now + 0.2);
    this.noiseBurst(now, 0.08, 500, 2, 0.05 + level * 0.08);
    this.stats.plays++;
  }

  /** 「スポン！」：抜けた瞬間。power 0..1 */
  pop(power: number) {
    if (!this.canPlay()) return;
    const ctx = this.ctx!, now = ctx.currentTime;
    // 1. 栓が抜ける破裂（短いノイズ・高めの帯域）
    this.noiseBurst(now, 0.06, 2400, 0.9, 0.35 + power * 0.2);
    // 2. 「ポン」：高い音から一気に下がる（音程の滑り）
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(1350 + power * 300, now + 0.005);
    o.frequency.exponentialRampToValueAtTime(170, now + 0.13);
    const g = this.env(now, 0.004, 0.2, 0.5 + power * 0.25);
    o.connect(g).connect(this.master!);
    o.start(now);
    o.stop(now + 0.25);
    // 3. 低い「ドン」（勢い）
    const o2 = ctx.createOscillator();
    o2.type = 'sine';
    o2.frequency.setValueAtTime(110, now);
    o2.frequency.exponentialRampToValueAtTime(48, now + 0.18);
    const g2 = this.env(now, 0.003, 0.22, 0.35 * power + 0.15);
    o2.connect(g2).connect(this.master!);
    o2.start(now);
    o2.stop(now + 0.25);
    // 4. 泡の粒（後から少しずつ）
    for (let i = 0; i < 4; i++) this.bubble(now + 0.12 + i * 0.07 + Math.random() * 0.04, 0.12 + Math.random() * 0.08);
    this.stats.plays++;
  }

  /** 泡：ぷくっ（短く上がる音） */
  bubble(at?: number, vol = 0.14) {
    if (!this.canPlay()) return;
    const ctx = this.ctx!, now = at ?? ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    const f = 520 + Math.random() * 500;
    o.frequency.setValueAtTime(f, now);
    o.frequency.exponentialRampToValueAtTime(f * 2.1, now + 0.06);
    const g = this.env(now, 0.003, 0.07, vol);
    o.connect(g).connect(this.master!);
    o.start(now);
    o.stop(now + 0.1);
  }

  /** 滑った：きしむ音 */
  slip() {
    if (!this.canPlay()) return;
    const ctx = this.ctx!, now = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(980, now);
    o.frequency.exponentialRampToValueAtTime(420, now + 0.16);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 900;
    f.Q.value = 3;
    const g = this.env(now, 0.005, 0.18, 0.12);
    o.connect(f).connect(g).connect(this.master!);
    o.start(now);
    o.stop(now + 0.22);
    this.noiseBurst(now, 0.14, 1600, 1.5, 0.12);
    this.stats.plays++;
  }

  /** 挟んだ・離した：小さなカチッ */
  click(close: boolean) {
    if (!this.canPlay()) return;
    const now = this.ctx!.currentTime;
    this.noiseBurst(now, 0.025, close ? 3200 : 2200, 4, close ? 0.12 : 0.07);
  }

  /** 音量の包絡（立ち上がり a 秒・全体 len 秒、最大 peak） */
  private env(now: number, a: number, len: number, peak: number): GainNode {
    const g = this.ctx!.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), now + a);
    g.gain.exponentialRampToValueAtTime(0.0001, now + len);
    return g;
  }

  /** 短いノイズ（帯域 freq・鋭さ q） */
  private noiseBurst(now: number, len: number, freq: number, q: number, vol: number) {
    const ctx = this.ctx!;
    const s = ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const g = this.env(now, 0.003, len, vol);
    s.connect(f).connect(g).connect(this.master!);
    s.start(now, Math.random() * 0.5);
    s.stop(now + len + 0.02);
  }
}

function readPrefs(): AudioPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(AUDIO_KEY) ?? 'null');
    if (v && typeof v.volume === 'number' && typeof v.muted === 'boolean') return { volume: Math.max(0, Math.min(1, v.volume)), muted: v.muted };
  } catch {
    /* 読めなければ既定 */
  }
  return { volume: 0.7, muted: false };
}

function writePrefs(p: AudioPrefs) {
  try {
    localStorage.setItem(AUDIO_KEY, JSON.stringify(p));
  } catch {
    /* 覚えられない環境では、このページの間だけ */
  }
}

/**
 * 右上のメニューの「音」ボタンと設定の欄（ミュート・音量・試し聞き）。欄の上の指はゲームに渡さない
 */
export class AudioMenu {
  readonly button: HTMLButtonElement;
  readonly panel: HTMLElement;

  constructor(menu: HTMLElement, private readonly audio: AquaAudio) {
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'menu-btn audio-btn';
    this.button.setAttribute('aria-label', '音の設定');
    this.button.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.button.addEventListener('click', () => this.toggle());
    menu.appendChild(this.button);

    const p = document.createElement('div');
    p.id = 'audio-panel';
    p.setAttribute('role', 'dialog');
    p.setAttribute('aria-label', '音の設定');
    p.innerHTML = `<div class="head"><b>音</b><button type="button" class="close" aria-label="閉じる">×</button></div>
      <label class="row"><input type="checkbox" data-k="mute"> 消音（ミュート）</label>
      <label class="row">音量 <input type="range" min="0" max="100" step="5" data-k="vol"><span data-k="v"></span></label>
      <div class="row"><button type="button" data-k="test">試しに鳴らす（スポン）</button></div>
      <div class="sub" data-k="st"></div>`;
    document.body.appendChild(p);
    this.panel = p;
    for (const t of ['pointerdown', 'pointerup', 'touchstart', 'wheel', 'contextmenu'] as const) p.addEventListener(t, (e) => e.stopPropagation());
    p.querySelector('.close')!.addEventListener('click', () => this.toggle(false));
    const mute = p.querySelector<HTMLInputElement>('[data-k="mute"]')!;
    const vol = p.querySelector<HTMLInputElement>('[data-k="vol"]')!;
    mute.addEventListener('change', () => audio.setMuted(mute.checked));
    vol.addEventListener('input', () => audio.setVolume(Number(vol.value) / 100));
    p.querySelector('[data-k="test"]')!.addEventListener('click', () => {
      audio.unlock();
      setTimeout(() => audio.pop(0.8), 30);
    });
    audio.onChange = () => this.render();
    this.render();
  }

  toggle(on = !this.panel.classList.contains('show')) {
    this.panel.classList.toggle('show', on);
    this.button.classList.toggle('on', on);
    this.render();
  }

  render() {
    const a = this.audio, P = a.prefs;
    this.button.textContent = P.muted || P.volume <= 0.001 ? '🔇' : '🔊';
    this.button.title = P.muted ? '音：消音中' : `音：${Math.round(P.volume * 100)}`;
    const p = this.panel;
    p.querySelector<HTMLInputElement>('[data-k="mute"]')!.checked = P.muted;
    p.querySelector<HTMLInputElement>('[data-k="vol"]')!.value = String(Math.round(P.volume * 100));
    p.querySelector('[data-k="v"]')!.textContent = `${Math.round(P.volume * 100)}`;
    const st = !a.ctx ? '画面に触れると音が出せるようになります' : a.ctx.state === 'running' ? '音を出せます（端末の消音スイッチが入っていると鳴らないことがあります）' : `音の準備中（${a.ctx.state}）：画面に触れてください`;
    p.querySelector('[data-k="st"]')!.textContent = st;
  }
}
