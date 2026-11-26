// 第 3 段階：水草のかき分けの撮影（Playwright。fetch + eval して page を渡す）。O = { host, dir, tag, w, h, touch }
// 森（forest）・有茎草の茂み（stems）・森の小部屋（room）で、方式 off（曲げない = 変更前）/ gpu / dyn-body（ばねだけ）/ dyn（ばね + 見通し）
// ごとに同じ入力で 1.5 秒歩いて撮る。dyn は止まって 1 秒後（分かれたまま）も撮る。画像は O.dir/<tag>-<場所>-<方式>.jpg
async (page, O = {}) => {
  const host = O.host ?? 'http://localhost:5173';
  const ctx = await page.context().browser().newContext({ viewport: { width: O.w ?? 960, height: O.h ?? 600 }, hasTouch: !!O.touch, isMobile: !!O.touch });
  const p = await ctx.newPage();
  await p.goto(`${host}/aquarium.html?nosave&${Date.now()}`, { timeout: 120000 });
  await p.waitForFunction(() => window.__aqua && window.__aqua.bootMs > 0, null, { timeout: 180000 });
  await p.evaluate(async (h) => {
    window.__aqua.help?.close?.();
    document.getElementById('help')?.classList.remove('show');
    for (const f of ['climb_helpers.js', 'grab_helpers.js', 'plant_part_test.js']) await fetch(h + '/docs/aquarium/tools/' + f + '?' + Date.now()).then((r) => r.text()).then(eval);
  }, host);
  const tag = O.tag ?? 'pc';
  const out = [];
  const shot = async (name) => {
    await p.evaluate(() => (window.__aqua.freeze = true));
    await p.waitForTimeout(150);
    await p.screenshot({ path: `${O.dir}/${tag}-${name}.jpg`, type: 'jpeg', quality: 80 });
  };
  for (const place of O.places ?? ['forest', 'stems', 'room']) {
    for (const mode of O.modes ?? ['off', 'gpu', 'dyn']) {
      const r = await p.evaluate(([mode, place]) => {
        const a = window.__aqua;
        a.freeze = false;
        const w = __pp.walk(mode, place, 1.5);
        return w;
      }, [mode, place]);
      out.push(`${place}/${mode}: blocked ${r.blocked}`);
      await shot(`${place}-${mode}`);
      if (mode === 'dyn' && place === 'forest') {
        await p.evaluate(() => { const a = window.__aqua; a.freeze = false; a.input.touchMove = { x: 0, y: 0 }; a.step(60); });
        await shot(`${place}-dyn-stopped`);
      }
    }
  }
  await ctx.close();
  return out.join('\n');
}
