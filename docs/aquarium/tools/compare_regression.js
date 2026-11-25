// 描画比較ページ（index.html）の回帰：基準のビルドと修正後のビルドで、方式 A〜F を同じ条件で撮って画素を比べる。
// （Playwright。browser_run_code_unsafe で実行。設定は compare_config.json { hosts: [基準, 修正後], dir }）
// 時刻を固定（debug.freeze = true → dt = 0）、風 0、同じカメラ・同じキャラクターの位置で、各方式が落ち着くまで待って
// キャンバスの画素を読み、2 つのビルドの差（違う画素の数・最大の差）を数える。比較画像は dir に保存する。
async (page) => {
  const cfgPage = await page.context().newPage();
  await cfgPage.goto('http://localhost:5173/docs/aquarium/tools/compare_config.json?' + Date.now());
  const O = Object.assign(JSON.parse(await cfgPage.evaluate(() => document.body.innerText)), globalThis.__over ?? {});
  // 画像を保存する前に、同じ名前の画像が既に無いか確かめる（out_guard.js。過去の報告の画像を上書きしない）
  const shotPath = (0, eval)(await (await fetch('http://localhost:5173/docs/aquarium/tools/out_guard.js?' + Date.now())).text())(O);
  await cfgPage.close();
  const methods = ['points', 'splats', 'surfels', 'voxels', 'pixelmesh', 'hybrid'];
  const shots = {};
  for (const host of O.hosts) {
    const ctx = await page.context().browser().newContext({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 1 });
    const p = await ctx.newPage();
    await p.goto(host + '/index.html?' + Date.now());
    await p.waitForFunction(() => window.__ppp, null, { timeout: 180000 });
    await p.evaluate(() => {
      const p = window.__ppp;
      window.__defaults = { ...p.settings };
      const ch = p.game.character;
      window.__charInit = { x: ch.x, y: ch.y, z: ch.z, heading: ch.heading };
      p.freeze = true;
      document.body.classList.add('panel-hidden');
    });
    shots[host] = {};
    for (const m of methods) {
      const data = await p.evaluate(async (m) => {
        const p = window.__ppp;
        Object.assign(p.settings, window.__defaults, { wind: 0 });
        p.settings.renderMethod = m;
        const c = p.game.camera;
        c.yaw = 0.75; c.pitch = 0.6; c.zoom = 15;
        const ch = p.game.character, ci = window.__charInit;
        ch.x = ci.x; ch.y = ci.y; ch.z = ci.z; ch.heading = ci.heading; ch.state = 'idle'; ch.stridePhase = 0;
        const rig = p.view.rig;
        rig.walkW = 0; rig.runW = 0; rig.t = 0;
        p.game.time = 5;
        c.target = { x: ch.x, y: ch.y + 0.6, z: ch.z };
        for (let i = 0; i < 400; i++) {
          await new Promise((r) => requestAnimationFrame(r));
          const busy = p.view.splatStatus === 'loading' || (m === 'splats' && (!p.view.splat || p.view.splat.busy));
          if (i > 40 && !busy) break;
        }
        // キャンバスを縮小せずに読む（WebGL の描画バッファは残っていないことがあるので、表示を 2D に写して読む）
        const cv = document.getElementById('view');
        const t = document.createElement('canvas');
        t.width = cv.width; t.height = cv.height;
        const g = t.getContext('2d');
        g.drawImage(cv, 0, 0);
        const px = g.getImageData(0, 0, t.width, t.height).data;
        let h = 0;
        for (let i = 0; i < px.length; i += 4) h = (h * 31 + px[i] * 7 + px[i + 1] * 13 + px[i + 2]) >>> 0;
        return { w: t.width, h: t.height, hash: h, url: t.toDataURL('image/png') };
      }, m);
      shots[host][m] = data;
      if (O.dir) {
        const tag = host === O.hosts[0] ? 'base' : 'fix';
        await p.locator('#view').screenshot({ path: await shotPath(`${O.dir}/compare-${tag}-${m}.png`) });
      }
    }
    await ctx.close();
  }
  // 2 つのビルドの画素の差（新しいページで両方の画像を読み込んで比べる）
  const cmp = await page.context().newPage();
  const result = {};
  for (const m of methods) {
    const a = shots[O.hosts[0]][m], b = shots[O.hosts[1]][m];
    result[m] = await cmp.evaluate(async ({ a, b }) => {
      const load = (u) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = u; });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      const c = document.createElement('canvas');
      c.width = ia.width; c.height = ia.height;
      const g = c.getContext('2d');
      g.drawImage(ia, 0, 0);
      const da = g.getImageData(0, 0, c.width, c.height).data;
      g.clearRect(0, 0, c.width, c.height);
      g.drawImage(ib, 0, 0);
      const db = g.getImageData(0, 0, c.width, c.height).data;
      let diff = 0, max = 0;
      for (let i = 0; i < da.length; i += 4) {
        const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
        if (d > 0) diff++;
        max = Math.max(max, d);
      }
      return { size: `${c.width}x${c.height}`, diffPixels: diff, maxDiff: max };
    }, { a: a.url, b: b.url });
  }
  await cmp.close();
  return result;
}
