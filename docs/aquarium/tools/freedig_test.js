// 自由方向の穴掘り・地下カメラの検証（Playwright。browser_run_code_unsafe で実行）。
// 設定は freedig_config.json（{ host, base, dir, w, h }。host = 変更後、base = 変更前のビルド）。
// 掘った形は元に戻せないので、シナリオごとに新しいページを開く。ページの中では freedig_helpers.js（window.__fd）を使う。
// - exit：照準を上へずらして地下から地表へ抜ける（照準 0.5 / 0.75 / 1.0）
// - curve：照準を左右へ少しずつずらして曲がったトンネルを掘る
// - cam：地下カメラの方式ごと（変更後の 'orbit' / 'shoulder' / 'near'、変更前のビルド）に、地上から歩いて入る → 中で 1 周 →
//   歩いて出る。カメラの跳ね・壁までの距離・見通し・カニが画面に占める割合と、中の 3 方向の画面を撮る
async (page) => {
  const cfgPage = await page.context().newPage();
  await cfgPage.goto('http://localhost:5173/docs/aquarium/tools/freedig_config.json?' + Date.now());
  const O = Object.assign(JSON.parse(await cfgPage.evaluate(() => document.body.innerText)), globalThis.__over ?? {});
  // 画像を保存する前に、同じ名前の画像が既に無いか確かめる（out_guard.js。過去の報告の画像を上書きしない）
  const shotPath = (0, eval)(await (await fetch('http://localhost:5173/docs/aquarium/tools/out_guard.js?' + Date.now())).text())(O);
  await cfgPage.close();
  const errors = [];
  const open = async (host) => {
    const ctx = await page.context().browser().newContext({ viewport: { width: O.w ?? 960, height: O.h ?? 600 }, deviceScaleFactor: 1 });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(host + ': ' + String(e)));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(host + ': ' + m.text()); });
    await p.goto(host + '/aquarium.html?' + Date.now());
    await p.waitForFunction(() => window.__aqua, null, { timeout: 180000 });
    await p.evaluate(() => document.getElementById('help')?.classList.add('fade'));
    // 補助は変更後のサーバーから読む（変更前のビルドでも同じ手順で測る）
    await p.evaluate(async (src) => { const t = await fetch(src).then((r) => r.text()); (0, eval)(t); }, 'http://localhost:5173/docs/aquarium/tools/freedig_helpers.js?' + Date.now());
    return { ctx, p };
  };
  const out = { exit: {}, curve: null, cam: {} };
  const only = O.only ?? ['exit', 'curve', 'cam'];
  if (only.includes('exit')) {
    for (const y of [0.5, 0.75, 1.0]) {
      const { ctx, p } = await open(O.host);
      out.exit[y] = await p.evaluate((y) => { const r = window.__fd.exitTest(y, y === 0.5 ? 12 : 9); r.climbs = window.__aqua.crab.climbs; return r; }, y);
      if (O.dir) {
        // 出口を地上から見る（カニの後ろ上から）
        await p.evaluate(() => { const a = window.__aqua, cam = a.camera; cam.adventure.pitch = 0.75; cam.adventure.zoom = 4.5; a.freeze = false; a.step(90); a.freeze = true; });
        await p.screenshot({ path: await shotPath(`${O.dir}/exit-${y}.jpg`), type: 'jpeg', quality: 82 });
      }
      await ctx.close();
    }
  }
  if (only.includes('curve')) {
    const { ctx, p } = await open(O.host);
    out.curve = await p.evaluate(() => window.__fd.curveTest(0.8, 6));
    if (O.dir) {
      // 曲がったトンネルを箱庭カメラのように真上近くから（地形を透かさないので、掘った穴の口と曲がった先を地下の視点で）
      await p.screenshot({ path: await shotPath(`${O.dir}/curve-inside.jpg`), type: 'jpeg', quality: 82 });
    }
    await ctx.close();
  }
  if (only.includes('cam')) {
    const variants = [...(O.methods ?? ['orbit', 'shoulder', 'near']).map((m) => ({ host: O.host, m })), ...(O.base ? [{ host: O.base, m: 'base' }] : [])];
    for (const v of variants) {
      const { ctx, p } = await open(v.host);
      const r = await p.evaluate((m) => { if (m !== 'base') window.__aqua.camera.tunnelCam = m; return window.__fd.entryTest(); }, v.m);
      // 中の画面：穴の奥を向く（後ろから）・横の壁・入口の方を向く・見上げる
      if (O.dir) {
        await p.evaluate((q) => { const a = window.__aqua; a.freeze = true; a.crab.teleport(q[0], q[2], q[1] + 0.02); }, r.inside.pos);
        for (const [name, dyaw, pitch] of [['back', 0, 0.3], ['side', Math.PI / 2, 0.3], ['entrance', Math.PI, 0.3], ['up', 0, -0.6]]) {
          await p.evaluate(([dyaw, pitch]) => { const a = window.__aqua, c = a.crab, cam = a.camera; c.heading = Math.PI / 2; cam.adventure.yaw = c.heading + Math.PI + dyaw; cam.adventure.pitch = pitch; a.freeze = false; a.step(120); a.freeze = true; }, [dyaw, pitch]);
          await p.screenshot({ path: await shotPath(`${O.dir}/cam-${v.m}-${name}.jpg`), type: 'jpeg', quality: 82 });
        }
        r.shotStats = await p.evaluate(() => window.__fd.camStats());
      }
      out.cam[v.m] = r;
      await ctx.close();
    }
  }
  out.errors = errors;
  return out;
}
