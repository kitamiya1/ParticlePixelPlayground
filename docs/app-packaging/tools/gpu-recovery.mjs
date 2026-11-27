// 描画の喪失と復旧（AquaGpuGuard）をアプリの WebView の中で試す（CDP。Windows の WebView2・Android の WebView）。
//   node gpu-recovery.mjs --port 9222 --out <フォルダ> [--match aquarium]
// 1. 起動の記録（__aqua.diagLog）：描画の準備の時間・最初のフレーム・画面の大きさ
// 2. その場で復旧：掘る → WEBGL_lose_context.loseContext → 1.5 秒 → restoreContext → 状態（穴・砂・掘った形・位置）を比べる
// 3. 復旧が来ない：掘る → loseContext のまま → 8 秒後に保存して読み込み直す → つなぎ直して状態を比べる
// （どちらも WEBGL_lose_context による模擬。GPU 処理が本当に止まるのは iOS の CI で別に試す）
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, sleep } from './cdp.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const port = +arg('port', 9222);
const out = arg('out', 'gpu-recovery-out');
const match = arg('match', 'aquarium');
mkdirSync(out, { recursive: true });

const waitReady = `new Promise((r) => { const t0 = Date.now(); const f = () => (window.__aqua && window.__aqua.gpu && window.__aqua.gpu.state === 'ready') || Date.now() - t0 > 90000 ? r(!!window.__aqua) : setTimeout(f, 200); f(); })`;
const snap = `(() => { const a = window.__aqua; return { holes: a.world.dig.count, sand: +a.crab.sandHeld.toFixed(3), prims: a.world.dig.exportPrims().length, x: +a.crab.x.toFixed(2), z: +a.crab.z.toFixed(2), gpu: a.gpu.state, store: a.save.store.kind, programs: a.view.renderer.info.programs.length }; })()`;
const digSome = `(() => { const a = window.__aqua; a.dig = true; a.digAim = { x: 0, y: -0.55 }; a.step(120); a.dig = false; a.digAim = null; a.step(10); a.save.saver.markImportant(); return true; })()`;

const res = { port };
let c = await connect(port, { match, timeoutMs: 90000 });
await c.evaluate(waitReady);
await sleep(1500);
res.boot = await c.evaluate(`window.__aqua.diagLog.filter((l) => /boot done|prepare \\(boot\\)|frame [123] took|layout|renderer created|save loaded/.test(l))`);
res.bootMs = await c.evaluate('window.__aqua.bootMs');

// 2. その場で復旧
await c.evaluate(digSome);
await sleep(500);
const before1 = await c.evaluate(snap);
await c.evaluate(`(window.__ext = window.__aqua.view.renderer.getContext().getExtension('WEBGL_lose_context'), window.__ext.loseContext(), true)`);
await sleep(400);
const during1 = await c.evaluate(`({ gpu: window.__aqua.gpu.state, overlay: document.getElementById('gpu-overlay').className, msg: document.querySelector('#gpu-overlay .msg').textContent })`);
writeFileSync(join(out, 'inplace-lost.png'), await c.screenshot());
await sleep(1100);
await c.evaluate('window.__ext.restoreContext(), true');
await c.evaluate(waitReady);
await sleep(1500);
const after1 = await c.evaluate(snap);
writeFileSync(join(out, 'inplace-restored.png'), await c.screenshot());
res.inPlace = { before: before1, during: during1, after: after1, same: ['holes', 'sand', 'prims', 'x', 'z'].every((k) => before1[k] === after1[k]) && after1.gpu === 'ready' };
console.log('in-place', JSON.stringify(res.inPlace));

// 3. 復旧が来ない → 保存して読み込み直す
await c.evaluate(`sessionStorage.removeItem('aqua.gpuReloads'), true`);
await c.evaluate(digSome);
await sleep(2500);
const before2 = await c.evaluate(snap);
await c.evaluate(`(window.__aqua.view.renderer.getContext().getExtension('WEBGL_lose_context').loseContext(), true)`);
const tLost = Date.now();
c.close();
// 読み込み直しを待つ（8 秒 + 保存）→ 新しいページへつなぎ直す
await sleep(10000);
c = await connect(port, { match, timeoutMs: 90000 });
await c.evaluate(waitReady);
await sleep(2000);
const after2 = await c.evaluate(snap);
const extra = await c.evaluate(`({ reloadedForGpu: window.__aqua.gpu.stats.reloadedForGpu, toast: document.getElementById('aqua-toast').textContent, log: window.__aqua.diagLog.filter((l) => /gpu:|save loaded/.test(l)) })`);
writeFileSync(join(out, 'reload-after.png'), await c.screenshot());
res.reload = { before: before2, after: after2, ...extra, secondsUntilReady: (Date.now() - tLost) / 1000, same: ['holes', 'sand', 'prims'].every((k) => before2[k] === after2[k]) && Math.abs(before2.x - after2.x) < 0.05 && Math.abs(before2.z - after2.z) < 0.05 && after2.gpu === 'ready' };
console.log('reload', JSON.stringify({ same: res.reload.same, before: before2, after: after2 }));
c.close();
writeFileSync(join(out, 'gpu-recovery.json'), JSON.stringify(res, null, 1));
