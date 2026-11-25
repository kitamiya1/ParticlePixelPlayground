// 壁登り・ガラス越しの巣穴の画面を撮る（Playwright。browser_run_code_unsafe の filename で実行。設定は climb_shots_config.json）。
// { host, dir, w, h, touch?, shots: [{ name, reclimb?: 掘る場所（tunnelReclimb で登り直してから撮る）, lateral?: …, glass?: ガラス際を掘る設定,
//   sc?: climb_helpers の run のシナリオ（撮る直前まで）, after?: [{ cam: {mode,yaw,pitch,zoom}, steps }], label }] }
// 撮る前に freeze して 1 フレームだけ描く。説明・HUD は隠さない（実際の画面）。
async (page) => {
  const cfgPage = await page.context().newPage();
  await cfgPage.goto('http://localhost:5173/docs/aquarium/tools/climb_shots_config.json?' + Date.now());
  const O = JSON.parse(await cfgPage.evaluate(() => document.body.innerText));
  await cfgPage.close();
  const ctx = await page.context().browser().newContext({ viewport: { width: O.w ?? 960, height: O.h ?? 600 }, deviceScaleFactor: 1, hasTouch: !!O.touch, isMobile: !!O.touch });
  const res = {};
  for (const s of O.shots) {
    if (O.only && !O.only.includes(s.name)) continue;
    const p = await ctx.newPage();
    await p.goto((s.host ?? O.host) + '/aquarium.html?' + Date.now());
    await p.waitForFunction(() => window.__aqua, null, { timeout: 180000 });
    res[s.name] = await p.evaluate(async (s) => {
      await fetch('http://localhost:5173/docs/aquarium/tools/climb_helpers.js?' + Date.now()).then((r) => r.text()).then(eval);
      const a = window.__aqua;
      const help = document.getElementById('help');
      if (help) help.style.display = 'none';
      let info = {};
      if (s.glass) info = window.__ct.digGlass(s.glass);
      if (s.reclimb) info = window.__ct.tunnelReclimb(s.reclimb);
      if (s.sc) info = window.__ct.run(s.sc);
      for (const st of s.after ?? []) {
        if (st.cam) {
          const cam = a.camera;
          if (st.cam.mode) cam.mode = st.cam.mode;
          const o = cam.mode === 'observe' ? cam.observe : cam.adventure;
          for (const k of ['yaw', 'pitch', 'zoom']) if (st.cam[k] !== undefined) o[k] = st.cam[k];
        }
        if (st.steps) info.after = window.__ct.run({ steps: st.steps }).end;
      }
      a.freeze = false; a.step(1); a.freeze = true;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const c = a.crab;
      return { crab: [c.x, c.y + c.radius, c.z].map((v) => +v.toFixed(2)), state: c.state, cam: a.camera.mode, end: info.end ?? null };
    }, s);
    await p.screenshot({ path: `${O.dir}/${s.name}.jpg`, type: 'jpeg', quality: 85 });
    await p.close();
  }
  await ctx.close();
  return res;
}
