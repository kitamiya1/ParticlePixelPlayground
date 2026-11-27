// アプリ版（Tauri の WebView）・ブラウザでの動作試験。CDP でつないで、ゲームの中で検証する。
// 使い方：node docs/app-packaging/tools/smoke.mjs --port 9222 --out <dir> --phase first|restore|state|click [--touch] [--launched <epoch ms>]
//   first   … 起動・WebGL・本物の入力（キー / タッチ）・掘る・盛る・壁・天井・崖・水草・生き物・音・性能・通信先を調べ、
//             最後に分かる状態にして保存する（state.json）
//   restore … アプリを再起動した後に：保存データが戻ったか（first の state.json と比べる）
//   state   … いまの状態（位置・穴の数・保存の状態）だけ
//   click   … --sel のボタンを押す（書き出し・読み込みの試験で使う）
// ゲームの検証は既存の試験道具（docs/aquarium/tools の climb_helpers.js など）をそのままページへ読み込んで使う。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, sleep } from './cdp.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, v, i, all) => {
    if (v.startsWith('--')) acc.push([v.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
    return acc;
  }, []),
);
const port = Number(args.port ?? 9222);
const out = args.out ?? 'out';
const phase = args.phase ?? 'first';
const touch = !!args.touch;
const launched = args.launched ? Number(args.launched) : null;
mkdirSync(out, { recursive: true });
const here = dirname(fileURLToPath(import.meta.url));
const toolsDir = join(here, '..', '..', 'aquarium', 'tools');
const helper = (f) => readFileSync(join(toolsDir, f), 'utf8');

const tConnect0 = Date.now();
const cdp = await connect(port, { match: args.match ?? 'aquarium', timeoutMs: 120000 });
const ev = cdp.evaluate;
const pageErrors = [];
await cdp.send('Runtime.enable');
cdp.on((m) => {
  if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') pageErrors.push('console.error: ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
});
const waitBoot = async () => {
  for (let i = 0; i < 600; i++) {
    try {
      if (await ev('!!(window.__aqua && window.__aqua.bootMs > 0)')) return;
    } catch {
      /* 読み込み直しの途中 */
    }
    await sleep(200);
  }
  throw new Error('boot timeout');
};
await waitBoot();
const tBooted = Date.now();
const shot = async (name) => writeFileSync(join(out, name + '.png'), await cdp.screenshot());
const save = (name, v) => writeFileSync(join(out, name + '.json'), JSON.stringify(v, null, 2));
const res = { phase, url: cdp.target.url, when: new Date().toISOString() };

const STATE = `(() => { const a = window.__aqua, c = a.crab, s = a.save;
  return { x: +c.x.toFixed(3), y: +c.y.toFixed(3), z: +c.z.toFixed(3), prims: a.world.dig.count, fills: a.world.dig.fillCount, sand: +c.sandHeld.toFixed(4),
    loaded: s.loaded?.status ?? null, storeKind: s.store.kind, rev: s.store.knownRev, saveState: s.saver.state, lastSavedAt: s.saver.lastSavedAt,
    marker: localStorage.getItem('ppp-app-test:marker') }; })()`;

if (phase === 'state') {
  res.state = await ev(STATE);
  console.log(JSON.stringify(res));
  process.exit(0);
}
if (phase === 'click') {
  res.clicked = await ev(`(() => { const a = window.__aqua; a.save.menu.toggle(true); const b = document.querySelector(${JSON.stringify(args.sel)}); if (!b) return false; b.click(); return true; })()`);
  console.log(JSON.stringify(res));
  process.exit(0);
}

// ---- 共通：起動の時間・環境
res.boot = await ev(`(() => { const a = window.__aqua;
  const nav = performance.getEntriesByType('navigation')[0];
  return { bootMs: Math.round(a.bootMs), buildMs: Math.round(a.buildMs ?? 0), domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null }; })()`);
res.boot.harnessConnectToBootMs = tBooted - tConnect0;
if (launched) res.boot.launchToBootMs = tBooted - launched;

if (phase === 'restore') {
  res.state = await ev(STATE);
  await shot('restore');
  res.pageErrors = pageErrors;
  save('restore', res);
  console.log(JSON.stringify(res, null, 1));
  cdp.close();
  process.exit(0);
}

// ---- first
res.env = await ev(`(() => {
  const cv = document.createElement('canvas'); const gl = cv.getContext('webgl2'); const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
  const r = window.__aqua.view.renderer;
  return { ua: navigator.userAgent, webgl2: !!gl, glRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER), glVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
    maxTex: gl?.getParameter(gl.MAX_TEXTURE_SIZE), threeWebGL2: r?.capabilities?.isWebGL2 ?? null, dpr: devicePixelRatio, inner: [innerWidth, innerHeight],
    touchPoints: navigator.maxTouchPoints, origin: location.origin, isApp: '__TAURI_INTERNALS__' in window, storeKind: window.__aqua.save.store.kind,
    idb: typeof indexedDB !== 'undefined', storagePersist: typeof navigator.storage?.persist === 'function', gamepadApi: typeof navigator.getGamepads === 'function', vibrate: typeof navigator.vibrate === 'function',
    audioCtx: typeof (window.AudioContext ?? window.webkitAudioContext) === 'function' };
})()`);
await ev(`window.__aqua.help?.close?.(); document.getElementById('help')?.classList.remove('show'); true`);
await sleep(800);
await shot('01-boot');

// 描画の中身：WebGL の canvas を 2D へ写して、色の数とばらつきを見る（真っ黒・単色でないか）
res.render = await ev(`(() => { const a = window.__aqua; a.step(1);
  const src = document.getElementById('view'); const w = 160, h = Math.max(1, Math.round(160 * src.height / src.width));
  const c2 = document.createElement('canvas'); c2.width = w; c2.height = h; const g = c2.getContext('2d'); g.drawImage(src, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data; const set = new Set(); let s = 0, s2 = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { const l = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]; s += l; s2 += l * l; n++; set.add((d[i] >> 3) << 10 | (d[i + 1] >> 3) << 5 | (d[i + 2] >> 3)); }
  const mean = s / n; return { canvas: [src.width, src.height], colors: set.size, meanLum: +mean.toFixed(1), stdLum: +Math.sqrt(s2 / n - mean * mean).toFixed(1), tris: a.view.stats.tris }; })()`);
res.render.ok = res.render.colors > 50 && res.render.stdLum > 5;

// ---- 本物の入力（キーボード / タッチ）：実時間で動かして、カニが動く・掘れるか
await ev(`(() => { const a = window.__aqua; a.goto('spawn'); a.freeze = false; return true; })()`);
await sleep(600);
const p0 = await ev(STATE);
if (!touch) {
  // クリック（利用者の操作 → 音の解禁）→ W を 1.2 秒 → F（掘る）を 1.5 秒
  const [w, h] = res.env.inner;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: w / 2, y: h / 2, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: w / 2, y: h / 2, button: 'left', clickCount: 1 });
  const key = async (code, key, ms) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) });
    await sleep(ms);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) });
  };
  await key('KeyW', 'w', 1200);
  await sleep(300);
  const p1 = await ev(STATE);
  await key('KeyF', 'f', 1500);
  await sleep(500);
  const p2 = await ev(STATE);
  res.realInput = { kind: 'keyboard+mouse', moved: +Math.hypot(p1.x - p0.x, p1.z - p0.z).toFixed(3), digPrimsAdded: p2.prims - p1.prims };
} else {
  const rect = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2, r.width, r.height]; })()`);
  const tp = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 })) });
  // まず 1 回タップ（音の解禁）
  const [w, h] = res.env.inner;
  await tp('touchStart', [[w * 0.6, h * 0.4]]);
  await tp('touchEnd', []);
  const st = await rect('#touch-ui .stick');
  res.touchStick = st;
  if (st) {
    await tp('touchStart', [[st[0], st[1]]]);
    for (let i = 1; i <= 6; i++) {
      await tp('touchMove', [[st[0], st[1] - (st[3] * 0.4 * i) / 6]]);
      await sleep(30);
    }
    await sleep(1200);
    await tp('touchEnd', []);
  }
  await sleep(300);
  const p1 = await ev(STATE);
  const dg = await rect('#touch-ui .dig');
  res.touchDig = dg;
  if (dg) {
    await tp('touchStart', [[dg[0], dg[1]]]);
    await sleep(1500);
    await tp('touchEnd', []);
  }
  await sleep(500);
  const p2 = await ev(STATE);
  res.realInput = { kind: 'touch', moved: +Math.hypot(p1.x - p0.x, p1.z - p0.z).toFixed(3), digPrimsAdded: p2.prims - p1.prims };
}
res.realInput.ok = res.realInput.moved > 0.3 && res.realInput.digPrimsAdded > 0;
await shot('02-after-real-input');

// ---- 音（本物の操作の後）：AudioContext が動いている・効果音が例外なく鳴る・時間が進む
res.audio = await ev(`(async () => { const A = window.__aqua.audio; const r = { ctxState: A.ctx ? A.ctx.state : null };
  if (!A.ctx || A.ctx.state !== 'running') { A.unlock(); await new Promise((r) => setTimeout(r, 300)); r.ctxStateAfterUnlock = A.ctx ? A.ctx.state : null; }
  const p0 = A.stats.plays; let err = null; const t0 = A.ctx?.currentTime ?? 0;
  try { A.grunt(0.8); A.pop(1); A.bubble(); A.slip(); A.click(true); } catch (e) { err = String(e); }
  await new Promise((r) => setTimeout(r, 400));
  return { ...r, err, plays: A.stats.plays - p0, advanced: +(((A.ctx?.currentTime ?? 0) - t0)).toFixed(3), sampleRate: A.ctx?.sampleRate, muted: A.prefs.muted, volume: A.prefs.volume }; })()`);
res.audio.ok = !res.audio.err && res.audio.plays > 0 && res.audio.advanced > 0.2;

// ---- ゲームの検証（既存の試験道具）。止めた時間で a.step を進める
for (const f of ['climb_helpers.js', 'grab_helpers.js', 'sand_fill_test.js', 'ceiling_test.js', 'cliff_sweep_test.js', 'ledge_test.js', 'plant_part_test.js', 'catch_test.js']) {
  try {
    await ev(helper(f) + '\n;true');
  } catch (e) {
    res['load:' + f] = String(e);
  }
}
const g = async (name, expr) => {
  const t0 = Date.now();
  try {
    res[name] = await ev(expr);
  } catch (e) {
    res[name] = { error: String(e) };
  }
  res[name] = { ...(typeof res[name] === 'object' && res[name] ? res[name] : { value: res[name] }), _ms: Date.now() - t0 };
};
await g('dig', `(() => { window.__aqua.freeze = true; const r = __sf.crater(2); return { ...r, ok: r.gained > 0 && Math.abs(r.hole) > 0.01 }; })()`);
await g('fill', `(() => { const a = window.__aqua; const f0 = a.world.dig.fillCount, h0 = a.crab.sandHeld; const r = __sf.refill(); return { fillsAdded: a.world.dig.fillCount - f0, sandUsed: +(h0 - a.crab.sandHeld).toFixed(3), r: JSON.stringify(r).slice(0, 300), ok: a.world.dig.fillCount > f0 && h0 - a.crab.sandHeld > 0 }; })()`);
// 壁：climb_config.json の「岩の垂直面（WASD）」と同じ場面（キーボードの経路 input.keys で押す）
const climbCfg = JSON.parse(helper('climb_config.json'));
await g('wall', `(() => { const sc = ${JSON.stringify(climbCfg.scenes['岩の垂直面（WASD）'])};
  const r = __ct.run(sc); const ys = r.trace.map((e) => e.p[1]); const cl = r.trace.filter((e) => e.cl).length;
  return { startY: ys[0], maxY: Math.max(...ys), climbSamples: cl, samples: r.trace.length, grabs: r.stats.grabs ?? null, mats: [...new Set(r.trace.filter((e) => e.cl).map((e) => e.mat))], end: r.end, state: r.state, ok: (r.stats.grabs ?? 0) >= 1 && cl >= 4 }; })()`);
// （この場面は岩の垂直面に張り付いて上下左右へ動く。壁を登って天井へ移るのは ceiling で見る）
await g('ceiling', `(() => { const S = __ceil.sites()[1]; const r = __ceil.site(S); const s = JSON.stringify(r); return { name: S.name, summary: s.slice(0, 600), ok: /"reached":\\s*true|"onCeiling":\\s*true|"ceil[^"]*":\\s*true/.test(s) || (r.reachT != null && r.reachT >= 0) }; })()`);
await g('cliff', `(() => { const r = __lg.run('高い崖（陸の段々の岩）', 'lead'); const tr = r.track ?? []; const y0 = tr[0]?.[1], y1 = tr[tr.length - 1]?.[1]; return { y0, y1, ledge: r.ledge, ok: y0 - y1 > 1.5 }; })()`);
await g('plants', `(() => { const r = __pp.walk('dyn', 'forest', 2); return { ...r, ok: r.touchedMax > 0 }; })()`);
await g('plantGrab', `(() => { const r = __ct5.plant(0, false, 1.5); const s = JSON.stringify(r); return { summary: s.slice(0, 500), ok: /"grabbed":\\s*true|"held":\\s*true|"caught":\\s*true/.test(s) || (r.tensionMax ?? r.tension ?? 0) > 0 }; })()`);
await g('creature', `(() => { const r = __ct5.life('shrimp', 2); return { summary: JSON.stringify(r).slice(0, 500), caught: r.caught, ok: (r.caught ?? 0) > 0 }; })()`);

// ---- 性能：凍結を解いて実時間で 5 秒歩かせ、フレームの間隔と JS のメモリ
await g('perf', `(async () => { const a = window.__aqua; a.goto('spawn'); a.freeze = false; a.input.touchMove = { x: 1, y: 0.2 };
  const ts = []; await new Promise((res) => { let last = performance.now(); const f = (now) => { ts.push(now - last); last = now; if (ts.length < 300) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); setTimeout(res, 20000); });
  if (ts.length < 30) return { error: 'requestAnimationFrame が止まっている（画面が隠れている）', frames: ts.length, visibility: document.visibilityState };
  a.input.touchMove = { x: 0, y: 0 }; ts.shift(); const s = [...ts].sort((x, y) => x - y); const avg = ts.reduce((p, v) => p + v, 0) / ts.length;
  const m = performance.memory; return { frames: ts.length, avgMs: +avg.toFixed(2), fps: +(1000 / avg).toFixed(1), p95Ms: +s[Math.floor(s.length * 0.95)].toFixed(2), maxMs: +s[s.length - 1].toFixed(1),
    jsHeapMB: m ? +(m.usedJSHeapSize / 1048576).toFixed(1) : null, jsHeapLimitMB: m ? +(m.jsHeapSizeLimit / 1048576).toFixed(0) : null, tris: a.view.stats.tris }; })()`);
await shot('03-after-tests');

// ---- 通信先：起動から読み込んだ資源の URL（外部へ出ていないか）
res.network = await ev(`(() => { const all = performance.getEntriesByType('resource').map((e) => e.name).concat(location.href);
  const origins = [...new Set(all.map((u) => { try { return new URL(u).origin; } catch { return u.slice(0, 40); } }))]; return { count: all.length, origins }; })()`);

// ---- 最後に分かる状態にして保存（再起動後に比べる）
res.saveFirst = await ev(`(async () => { const a = window.__aqua, c = a.crab; a.freeze = true; c.teleport(-2.0, 3.0); a.freeze = false; a.step(30);
  a.dig = true; a.step(45); a.dig = false; a.step(20);
  localStorage.setItem('ppp-app-test:marker', 'm' + Date.now());
  const ok = await a.save.saver.flush(); return { flushed: ok, persisted: await navigator.storage?.persisted?.().catch(() => null) ?? null }; })()`);
res.state = await ev(STATE);
save('state', res.state);
await shot('04-saved');
res.pageErrors = pageErrors;
save('first', res);
const summary = Object.fromEntries(Object.entries(res).filter(([, v]) => v && typeof v === 'object' && 'ok' in v).map(([k, v]) => [k, v.ok]));
console.log(JSON.stringify({ summary, boot: res.boot, perf: res.perf, env: res.env, errors: pageErrors.length }, null, 1));
cdp.close();
process.exit(0);
