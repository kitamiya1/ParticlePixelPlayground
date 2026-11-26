// 第 7 段階：接地主導の移動（崖・段差を降りる）の撮影（Playwright。fetch + eval して page を渡す）。
// O = { host, dir, tag, w, h, touch, shots: { 場所の番号: [歩き始めてからのフレーム…] }, gaits, diag }
// ledge_test.js の場所で、歩き方（ik = 従来の移動 / lead = 接地主導）ごとに同じ入力で歩かせ、指定のフレームで止めて撮る
// （毎回最初から同じ入力で進めるので、連続の静止画になる）。画像は O.dir/<tag>-<場所の番号>-<歩き方>-<n>.jpg
async (page, O = {}) => {
  const host = O.host ?? 'http://localhost:5173';
  const ctx = await page.context().browser().newContext({ viewport: { width: O.w ?? 960, height: O.h ?? 600 }, hasTouch: !!O.touch, isMobile: !!O.touch });
  const p = await ctx.newPage();
  await p.goto(`${host}/aquarium.html?nosave&${Date.now()}`, { timeout: 120000 });
  await p.waitForFunction(() => window.__aqua && window.__aqua.bootMs > 0, null, { timeout: 180000 });
  await p.evaluate(async (h) => {
    window.__aqua.help?.close?.();
    document.getElementById('help')?.classList.remove('show');
    for (const f of ['climb_helpers.js', 'ceiling_test.js', 'ledge_test.js']) await fetch(h + '/docs/aquarium/tools/' + f + '?' + Date.now()).then((r) => r.text()).then(eval);
  }, host);
  if (O.diag !== false) await p.evaluate(() => { const cb = document.querySelector('#audio-panel [data-k="footdiag"]'); if (cb && !cb.checked) cb.click(); document.getElementById('audio-panel')?.classList.remove('open'); });
  const tag = O.tag ?? 'pc';
  const names = await p.evaluate(() => Object.keys(__lg.places));
  const out = [];
  for (const [idx, frames] of Object.entries(O.shots ?? { 0: [20, 40, 60, 80, 110] })) {
    for (const gait of O.gaits ?? ['ik', 'lead']) {
      for (let s = 0; s < frames.length; s++) {
        await p.evaluate(([name, gait, f]) => {
          const a = window.__aqua;
          const orig = a.step;
          // 準備の 40 フレーム（と砂山・トンネルの準備）の後、歩き始めてから f フレームで止める
          let n = 0, go = false;
          const mark = a.crab.ledgeStats;
          a.step = (k, dt) => { if (go && n >= f) return; orig(k, dt); if (go) n++; };
          const run0 = window.__lgStartHook;
          window.__lgStartHook = () => { go = true; };
          try { __lg.run(name, gait); } finally { a.step = orig; window.__lgStartHook = run0; }
          a.freeze = true;
          a.input.touchMove = { x: 0, y: 0 };
          void mark;
        }, [names[+idx], gait, frames[s]]);
        await p.waitForTimeout(160);
        await p.screenshot({ path: `${O.dir}/${tag}-${idx}-${gait}-${s + 1}.jpg`, type: 'jpeg', quality: 78 });
      }
      out.push(`${idx} ${names[+idx]} ${gait}`);
    }
  }
  await ctx.close();
  return out.join('\n');
}
