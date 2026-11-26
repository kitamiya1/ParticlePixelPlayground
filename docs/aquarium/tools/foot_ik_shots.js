// 第 4 段階：接地 IK の撮影（Playwright。fetch + eval して page を渡す）。O = { host, dir, tag, w, h, touch, places, gaits, diag, frames }
// foot_ik_test.js の場所で、歩き方（cycle = 変更前 / ik）ごとに同じ入力で歩かせ、途中の 4 か所（frames の割合）で撮る（連続の静止画）。
// diag = true で接地の診断（足先・次の足場・届く範囲）も出す。画像は O.dir/<tag>-<場所の番号>-<歩き方>-<n>.jpg
async (page, O = {}) => {
  const host = O.host ?? 'http://localhost:5173';
  const ctx = await page.context().browser().newContext({ viewport: { width: O.w ?? 960, height: O.h ?? 600 }, hasTouch: !!O.touch, isMobile: !!O.touch });
  const p = await ctx.newPage();
  await p.goto(`${host}/aquarium.html?nosave&${Date.now()}`, { timeout: 120000 });
  await p.waitForFunction(() => window.__aqua && window.__aqua.bootMs > 0, null, { timeout: 180000 });
  await p.evaluate(async (h) => {
    window.__aqua.help?.close?.();
    document.getElementById('help')?.classList.remove('show');
    for (const f of ['climb_helpers.js', 'ceiling_test.js', 'foot_ik_test.js']) await fetch(h + '/docs/aquarium/tools/' + f + '?' + Date.now()).then((r) => r.text()).then(eval);
  }, host);
  if (O.diag) await p.evaluate(() => { const cb = document.querySelector('#audio-panel [data-k="footdiag"]'); if (cb && !cb.checked) cb.click(); });
  const tag = O.tag ?? 'pc';
  const names = await p.evaluate(() => Object.keys(__fk.places));
  const out = [];
  for (const idx of O.places ?? [0, 1, 4, 5]) {
    for (const gait of O.gaits ?? ['cycle', 'ik']) {
      // run を 4 つに分けて、区切りごとに撮る（同じ入力の続き）
      const shots = O.frames ?? [0.25, 0.5, 0.75, 1];
      // 区切りごとに、同じ通しを最初から区切りまで回して止めて撮る（同期で回すため 1 回の通しの途中では撮れない）
      for (let s = 0; s < shots.length; s++) {
        await p.evaluate(([name, gait, f]) => {
          const a = window.__aqua;
          const orig = a.step;
          const S = __fk.places[name];
          const total = 40 + S.walk.reduce((s, w) => s + Math.round(w[0] * 60), 0) + 60;
          const stop = Math.round(total * f);
          let n = 0;
          a.step = (k, dt) => { if (n >= stop) return; orig(k, dt); n++; };
          try { __fk.run(name, gait); } finally { a.step = orig; }
          a.freeze = true;
          a.input.touchMove = { x: 0, y: 0 };
        }, [names[idx], gait, shots[s]]);
        await p.waitForTimeout(150);
        await p.screenshot({ path: `${O.dir}/${tag}-${idx}-${gait}-${s + 1}.jpg`, type: 'jpeg', quality: 78 });
      }
      out.push(`${idx} ${names[idx]} ${gait}`);
    }
  }
  await ctx.close();
  return out.join('\n');
}
