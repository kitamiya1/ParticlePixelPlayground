// 各段階の性能の簡単な比較（Playwright。fetch + eval して page を渡す）。O = { hosts: [{tag, host, style?, gait?}], places, w, h, touch }
// （style = カメラの方式、gait = 歩き方。開発版で方式どうしを比べるとき）
// 各ホストを交互に開き（機械の負荷の揺れを打ち消す）、場所ごとに
//   cpu：__aqua.step(1) の平均 ms（ゲームの更新 + 描画の命令。GPU の終わりは待たない）を 120 回
//   frame：凍結を解いて 3 秒、requestAnimationFrame の間隔の平均と 95 パーセンタイル（GPU を含む実際のフレーム時間）
// を測る。カニはその場で右へ歩かせる（歩き・接地・水草の処理を含める）。
async (page, O = {}) => {
  const hosts = O.hosts ?? [{ tag: 'dev', host: 'http://localhost:5173' }];
  const places = O.places ?? ['spawn', 'burrow', 'log'];
  const rounds = O.rounds ?? 2;
  const res = {};
  const ctx = await page.context().browser().newContext({ viewport: { width: O.w ?? 1280, height: O.h ?? 800 }, hasTouch: !!O.touch, isMobile: !!O.touch });
  const p = await ctx.newPage();
  for (let r = 0; r < rounds; r++) {
    for (const { tag, host, style, gait, plants } of hosts) {
      await p.goto(`${host}/aquarium.html?nosave&${Date.now()}`);
      await p.waitForFunction(() => window.__aqua && window.__aqua.bootMs > 0, null, { timeout: 180000 });
      await p.evaluate(([style, gait, plants]) => { window.__aqua.help?.close?.(); document.getElementById('help')?.classList.remove('show'); if (style) window.__aqua.camera.setStyle(style); if (gait) { window.__aqua.rig.gait = gait; window.__aqua.rig.feet?.reset(); } if (plants && window.__aqua.plantField) window.__aqua.plantField.setMode(plants); }, [style, gait, plants]);
      for (const pl of places) {
        const m = await p.evaluate(async (pl) => {
          const A = window.__aqua;
          A.goto(pl);
          A.freeze = false;
          A.step(30);
          // 右へ歩かせる（キーの代わりに入力の値を直接）
          const inp = A.input;
          inp.touchMove = { x: 1, y: 0.2 };
          A.freeze = true;
          const t0 = performance.now();
          for (let i = 0; i < 120; i++) { A.freeze = false; A.step(1); A.freeze = true; }
          const cpu = (performance.now() - t0) / 120;
          A.goto(pl);
          A.freeze = false;
          const ts = [];
          await new Promise((res) => { let last = performance.now(); const f = (now) => { ts.push(now - last); last = now; if (ts.length < 180) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
          inp.touchMove = { x: 0, y: 0 };
          ts.shift();
          ts.sort((a, b) => a - b);
          return { cpu, avg: ts.reduce((s, v) => s + v, 0) / ts.length, p95: ts[Math.floor(ts.length * 0.95)] };
        }, pl);
        const k = `${tag}:${pl}`;
        res[k] = res[k] ?? [];
        res[k].push(m);
      }
    }
  }
  await ctx.close();
  const out = {};
  for (const [k, v] of Object.entries(res)) {
    const avg = (f) => +(v.reduce((s, x) => s + x[f], 0) / v.length).toFixed(2);
    out[k] = { cpuMs: avg('cpu'), frameMs: avg('avg'), p95Ms: avg('p95') };
  }
  return JSON.stringify(out);
}
