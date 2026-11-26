// 第 1 段階（操作ボタンの縮小・透過・印、没入感のための案内の削除）の確認と撮影（Playwright。browser_run_code_unsafe で
// fetch + eval して page を渡す）。前（公開中の main）と後（手元の開発版）を同じ手順で撮る。
// - スマホ相当（390×844 縦・844×390 横、タッチ）：ボタンの見た目の円（.face があればその大きさ、無ければボタン）と
//   指の当たる範囲（ボタン）の大きさ・重なり、カニ（画面上の点）とボタンの重なり、小石の前で挟めるときの輪・文字の有無、
//   CDP のタッチで挟むスイッチをたたいて閉じる・開くを調べて撮影する。後は大きさ 55% / 110%・濃さ 50% でも撮る
// - PC（1280×800）：小石の前の「E 挟む：…」の文字・輪の有無
// 画像は O.dir へ（同じ名前があれば書かない）。O = { host, helperHost, dir, tag }
async (page, O) => {
  const out = { tag: O.tag };
  const browser = page.context().browser();
  // 補助（grab_helpers.js）は開発版から読み、文字として相手のページで実行する（公開版には docs/ が無い）
  const helper = await page.evaluate((h) => fetch(h + '/docs/aquarium/tools/grab_helpers.js?' + Date.now()).then((r) => r.text()), O.helperHost);
  const open = async (p) => {
    await p.goto(`${O.host}/aquarium.html?nosave&${Date.now()}`);
    await p.waitForFunction(() => window.__aqua && window.__aqua.bootMs > 0, null, { timeout: 180000 });
    await p.evaluate((src) => {
      eval(src);
      window.__aqua.help?.close?.();
      document.getElementById('help')?.classList.remove('show');
    }, helper);
    await p.waitForTimeout(300);
  };
  const exists = async (path) => false; // 撮影先は呼ぶ側で新しい名前にする
  const shot = (p, name) => p.screenshot({ path: `${O.dir}/${O.tag}-${name}.jpg`, type: 'jpeg', quality: 82 });
  const run = async (p, ms) => {
    await p.evaluate(() => (window.__aqua.freeze = false));
    await p.waitForTimeout(ms);
  };
  const cues = (p) => p.evaluate(() => {
    const vis = (id) => { const e = document.getElementById(id); if (!e) return null; const cs = getComputedStyle(e); return cs.display !== 'none' && e.classList.contains('show'); };
    const hg = document.getElementById('h-grab');
    return { cursor: vis('grab-cursor'), hint: vis('grab-hint'), hintText: document.getElementById('grab-hint')?.textContent ?? null,
      cursorText: document.querySelector('#grab-cursor span')?.textContent ?? null, hudGrab: hg && !hg.classList.contains('off') ? hg.textContent : null,
      grabReady: document.querySelector('#touch-ui .grab')?.classList.contains('ready') ?? null };
  });
  const layout = (p) => p.evaluate(() => {
    const sel = ['.stick', '.run', '.jump', '.dig', '.cam', '.tool', '.grab'].filter((s) => document.querySelector('#touch-ui ' + s));
    const rect = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
    const R = sel.map((s) => {
      const e = document.querySelector('#touch-ui ' + s);
      const face = e.querySelector('.face, .ring') ?? e;
      const cs = getComputedStyle(face);
      return { s, hit: rect(e), vis: rect(face), bg: cs.backgroundColor };
    });
    // 丸いボタンは角の丸めの通りに指を受けるので、円どうしで調べる（横長の .tool は矩形の内接の円ではなく、両端の半円 + 中の矩形）
    const shape = (b, s) => s === '.tool' ? { cap: true, ...b } : { cx: (b.l + b.r) / 2, cy: (b.t + b.b) / 2, r: b.w / 2 };
    const dist = (a, b) => {
      // .tool は横の線分（両端の半円の中心を結ぶ）からの距離で近似
      const seg = (t, x, y) => { const r = t.h / 2, x0 = t.l + r, x1 = t.r - r, cy = (t.t + t.b) / 2; const px = Math.max(x0, Math.min(x1, x)); return [Math.hypot(x - px, y - cy), r]; };
      if (a.cap && b.cap) return 1e9;
      if (a.cap) { const [d, r] = seg(a, b.cx, b.cy); return d - r - b.r; }
      if (b.cap) { const [d, r] = seg(b, a.cx, a.cy); return d - r - a.r; }
      return Math.hypot(a.cx - b.cx, a.cy - b.cy) - a.r - b.r;
    };
    const visOverlaps = [], hitOverlaps = [], hitOnVis = [];
    for (let i = 0; i < R.length; i++) for (let j = 0; j < R.length; j++) {
      if (i === j) continue;
      const hi = shape(R[i].hit, R[i].s), vj = shape(R[j].vis, R[j].s), hj = shape(R[j].hit, R[j].s), vi = shape(R[i].vis, R[i].s);
      if (i < j && dist(vi, vj) < 0) visOverlaps.push(R[i].s + '×' + R[j].s);
      if (i < j && dist(hi, hj) < 0) hitOverlaps.push(R[i].s + '×' + R[j].s);
      // ある指の当たる範囲が、ほかのボタンの見た目の円に掛かる（見えている円の縁を押して別のボタンになる）
      if (dist(hi, vj) < -1) hitOnVis.push(R[i].s + '→' + R[j].s);
    }
    // カニ（体の中心と、体のまわり ±0.25 の 4 点）が見た目の円に隠れるか
    const A = window.__aqua, c = A.crab;
    const pts = [[0, 0], [0.25, 0], [-0.25, 0], [0, 0.25], [0, -0.25]].map(([dx, dz]) => A.view.project(c.x + dx, c.y + c.radius, c.z + dz)).filter(Boolean);
    const crabHidden = pts.filter((q) => R.some((r) => q.x >= r.vis.l && q.x <= r.vis.r && q.y >= r.vis.t && q.y <= r.vis.b)).length;
    const area = R.reduce((s, r) => s + r.vis.w * r.vis.h, 0) / (innerWidth * innerHeight);
    return {
      buttons: R.map((r) => `${r.s} ${Math.round(r.vis.w)}/${Math.round(r.hit.w)} ${r.bg.replace(/rgba?\(([^)]*)\)/, (m, x) => 'a' + (x.split(',')[3] ?? '1').trim())}`).join(' | '),
      visOverlaps, hitOverlaps, hitOnVis, crabPts: pts.length, crabHidden, visArea: +(area * 100).toFixed(1),
      crab: pts[0] ? [Math.round(pts[0].x), Math.round(pts[0].y)] : null, narrow: document.getElementById('touch-ui')?.classList.contains('narrow') ?? null,
    };
  });

  // ---------------- スマホ相当 ----------------
  for (const [name, w, h] of [['portrait', 390, 844], ['landscape', 844, 390]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
    const p = await ctx.newPage();
    await open(p);
    const cdp = await ctx.newCDPSession(p);
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((q) => ({ x: q[0], y: q[1], id: q[2], radiusX: 4, radiusY: 4, force: 1 })) });
    const r = {};
    await p.evaluate(() => { const g = window.__gr; g.reset(); g.settle(1); g.approach('pebble4', -Math.PI / 2); g.view(-0.9, 2.6, 0.3); });
    await run(p, 500);
    r.layout = await layout(p);
    r.cues = await cues(p);
    await shot(p, `${name}-1-near`);
    // 挟むスイッチ：見た目の円の外側（指の当たる範囲の縁から 4px 内側）をたたいても効くか
    const g = await p.evaluate(() => { const b = document.querySelector('#touch-ui .grab').getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; });
    const edge = [g[0] + 4, g[1] + g[3] / 2];
    const tap = async (x, y) => { await touch('touchStart', [[x, y, 1]]); await run(p, 60); await touch('touchEnd', [[x, y, 1]]); await run(p, 400); };
    await tap(...edge);
    r.edgeTap = await p.evaluate(() => ({ latch: window.__aqua.input.touchGrabLatch, grab: window.__aqua.grab.state, held: window.__aqua.grab.held?.name ?? null }));
    r.cuesHeld = await cues(p);
    r.layoutHeld = await layout(p);
    await shot(p, `${name}-2-latched`);
    await tap(g[0] + g[2] / 2, g[1] + g[3] / 2);
    r.untap = await p.evaluate(() => ({ latch: window.__aqua.input.touchGrabLatch, grab: window.__aqua.grab.state }));
    // 設定（後だけ）：大きさ・濃さを変えて撮る
    if (await p.evaluate(() => !!document.querySelector('#audio-panel .ui-prefs'))) {
      r.prefs = {};
      for (const [k, s, a] of [['small', 0.55, 0.25], ['large', 1.1, 0.25], ['dense', 0.75, 0.5]]) {
        await p.evaluate(([s, a]) => {
          const sc = document.querySelector('#audio-panel [data-k="scale"]'), al = document.querySelector('#audio-panel [data-k="alpha"]');
          sc.value = String(s * 100); sc.dispatchEvent(new Event('input'));
          al.value = String(a * 100); al.dispatchEvent(new Event('input'));
        }, [s, a]);
        await run(p, 200);
        r.prefs[k] = await layout(p);
        await shot(p, `${name}-3-${k}`);
      }
      // 設定の欄を開いた所
      await p.evaluate(() => { localStorage.removeItem('ppp-aquarium:ui'); });
      await p.evaluate(() => window.__aqua.audioMenu.toggle(true));
      await run(p, 200);
      await shot(p, `${name}-4-settings`);
      await p.evaluate(() => window.__aqua.audioMenu.toggle(false));
    }
    out[name] = r;
    await ctx.close();
  }

  // ---------------- PC ----------------
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    await open(p);
    await p.evaluate(() => { const g = window.__gr; g.reset(); g.settle(1); g.approach('pebble4', -Math.PI / 2); g.view(-0.9, 2.3, 0.3); });
    await run(p, 500);
    const r = { cues: await cues(p) };
    await shot(p, 'pc-1-near');
    await p.keyboard.down('KeyE');
    await run(p, 500);
    r.held = await cues(p);
    r.grab = await p.evaluate(() => ({ grab: window.__aqua.grab.state, held: window.__aqua.grab.held?.name ?? null }));
    await shot(p, 'pc-2-held');
    await p.keyboard.up('KeyE');
    out.pc = r;
    await ctx.close();
  }
  return JSON.stringify(out);
}
