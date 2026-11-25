// 壁登り・ガラス越しの巣穴の画面を撮る（Playwright。browser_run_code_unsafe の filename で実行。設定は climb_shots_config.json）。
// { host, dir, w, h, touch?, shots: [{ name, reclimb?: 掘る場所（tunnelReclimb で登り直してから撮る）, lateral?: …, glass?: ガラス際を掘る設定,
//   plans?: mesh_check と同じ掘り方の計画（climb_helpers の digPlans）, crabAt?: 撮る前にカニを置く所, pose?: { pos, target, fov } 決めた視点,
//   sc?: climb_helpers の run のシナリオ（撮る直前まで）, after?: [{ cam: {mode,yaw,pitch,zoom}, steps }], label }] }
// 撮る前に freeze して 1 フレームだけ描く。説明・HUD は隠さない（実際の画面）。
async (page) => {
  const cfgPage = await page.context().newPage();
  await cfgPage.goto('http://localhost:5173/docs/aquarium/tools/climb_shots_config.json?' + Date.now());
  const O = Object.assign(JSON.parse(await cfgPage.evaluate(() => document.body.innerText)), globalThis.__over ?? {});
  // 画像を保存する前に、同じ名前の画像が既に無いか確かめる（out_guard.js。過去の報告の画像を上書きしない）
  const shotPath = (0, eval)(await (await fetch('http://localhost:5173/docs/aquarium/tools/out_guard.js?' + Date.now())).text())(O);
  await cfgPage.close();
  // 保存先は実行する側で決める（設定の dir は null。globalThis.__over = { dir: '…/新しい報告のフォルダ/shots' }）。only = 撮る名前の一覧
  if (!O.dir) throw new Error('dir（画像の保存先）を globalThis.__over で指定する');
  if (O.only) O.shots = O.shots.filter((s) => O.only.includes(s.name));
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
      if (s.plans) info = window.__ct.digPlans(s.plans);
      // crabAt：撮る前にカニを置く所（[x, z]。掘った跡の画面にカニが入らないように）
      if (s.crabAt) { a.freeze = true; a.crab.teleport(s.crabAt[0], s.crabAt[1]); a.freeze = false; a.step(10); a.freeze = true; }
      for (const st of s.after ?? []) {
        if (st.cam) {
          const cam = a.camera;
          if (st.cam.mode) cam.mode = st.cam.mode;
          const o = cam.mode === 'observe' ? cam.observe : cam.adventure;
          for (const k of ['yaw', 'pitch', 'zoom']) if (st.cam[k] !== undefined) o[k] = st.cam[k];
        }
        if (st.steps) info.after = window.__ct.run({ steps: st.steps }).end;
      }
      if (s.pose) {
        // 決めた視点（変更前と後で同じ。カメラの更新は止めて、描画だけ）
        a.freeze = true;
        a.camera.mode = 'adventure';
        a.camera.pose.pos = s.pose.pos; a.camera.pose.target = s.pose.target; a.camera.pose.fov = s.pose.fov ?? 50;
        a.step(1);
      } else { a.freeze = false; a.step(1); a.freeze = true; }
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const c = a.crab;
      return { crab: [c.x, c.y + c.radius, c.z].map((v) => +v.toFixed(2)), state: c.state, cam: a.camera.mode, end: info.end ?? null };
    }, s);
    await p.screenshot({ path: await shotPath(`${O.dir}/${s.name}.jpg`), type: 'jpeg', quality: 85 });
    await p.close();
  }
  await ctx.close();
  return res;
}
