// 第 8 段階：接地主導の壁登り・天井への移りの撮影（Playwright。fetch + eval して page を渡す）。
// O = { hosts: [{ tag, host }], tools, dir, w, h, touch, shots: { 場所の番号: [歩き始めてからのフレーム…] }, gait, diag }
// climb_lead_test.js の場所で、ホスト（変更前 = main の版 / 変更後 = この版）ごとに同じ入力で動かし、指定のフレームで止めて撮る
// （毎回最初から同じ入力で進めるので、連続の静止画になる）。画像は O.dir/<tag>-<場所の番号>-<n>.jpg。
// 道具（climb_lead_test.js など）は O.tools（既定 http://localhost:5173）から読む（変更前の版のページでも同じ道具で動かす）
async (page, O = {}) => {
  const tools = O.tools ?? 'http://localhost:5173';
  const out = [];
  for (const { tag, host } of O.hosts ?? [{ tag: 'after', host: tools }]) {
    const ctx = await page.context().browser().newContext({ viewport: { width: O.w ?? 960, height: O.h ?? 600 }, hasTouch: !!O.touch, isMobile: !!O.touch });
    const p = await ctx.newPage();
    await p.goto(`${host}/aquarium.html?nosave&${Date.now()}`, { timeout: 120000 });
    await p.waitForFunction(() => window.__aqua && window.__aqua.bootMs > 0, null, { timeout: 180000 });
    await p.evaluate(async (h) => {
      window.__aqua.help?.close?.();
      document.getElementById('help')?.classList.remove('show');
      for (const f of ['climb_helpers.js', 'ceiling_test.js', 'climb_lead_test.js']) await fetch(h + '/docs/aquarium/tools/' + f + '?' + Date.now()).then((r) => r.text()).then(eval);
    }, tools);
    if (O.diag !== false) await p.evaluate(() => { const cb = document.querySelector('#audio-panel [data-k="footdiag"]'); if (cb && !cb.checked) cb.click(); document.getElementById('audio-panel')?.classList.remove('open'); });
    const names = await p.evaluate(() => __cl.names());
    for (const [idx, frames] of Object.entries(O.shots ?? { 0: [20, 45, 60, 75, 110] })) {
      for (let s = 0; s < frames.length; s++) {
        await p.evaluate(([name, gait, f]) => {
          const a = window.__aqua;
          const orig = a.step;
          // 準備（と掘ったトンネル）の後、歩き始めてから f フレームで止める
          let n = 0, go = false;
          a.step = (k, dt) => { if (go && n >= f) return; orig(k, dt); if (go) n++; };
          const h0 = window.__clStartHook;
          window.__clStartHook = () => { go = true; };
          try { __cl.run(name, gait); } finally { a.step = orig; window.__clStartHook = h0; }
          a.freeze = true;
          a.input.touchMove = { x: 0, y: 0 };
        }, [names[+idx], O.gait ?? 'lead', frames[s]]);
        await p.waitForTimeout(160);
        await p.screenshot({ path: `${O.dir}/${tag}-${idx}-${s + 1}.jpg`, type: 'jpeg', quality: 78 });
      }
      out.push(`${tag} ${idx} ${names[+idx]}`);
    }
    await ctx.close();
  }
  return out.join('\n');
}
