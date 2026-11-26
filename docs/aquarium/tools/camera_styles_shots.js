// 第 2 段階：カメラの方式の撮影（Playwright。fetch + eval して page を渡す）。O = { host, dir, w, h, places?, styles? }
// 場所ごと・方式ごとに camera_styles_test.js の run で同じ入力を与え、最後の姿勢で撮る（classic = 変更前の動き）。
// 自由追従は、地面の下（見下ろす角度を負に）・岩の中・倒木の中からの撮影も足す。画像は O.dir/cam-<場所>-<方式>.jpg
async (page, O = {}) => {
  const host = O.host ?? 'http://localhost:5173';
  const ctx = await page.context().browser().newContext({ viewport: { width: O.w ?? 960, height: O.h ?? 600 }, hasTouch: !!O.touch, isMobile: !!O.touch });
  const p = await ctx.newPage();
  await p.goto(`${host}/aquarium.html?nosave&${Date.now()}`);
  await p.waitForFunction(() => window.__aqua && window.__aqua.bootMs > 0, null, { timeout: 180000 });
  await p.evaluate(async (h) => {
    window.__aqua.help?.close?.();
    document.getElementById('help')?.classList.remove('show');
    for (const f of ['climb_helpers.js', 'ceiling_test.js', 'camera_styles_test.js']) await fetch(h + '/docs/aquarium/tools/' + f + '?' + Date.now()).then((r) => r.text()).then(eval);
    __cs.prep();
  }, host);
  const tag = O.tag ?? 'pc';
  const shot = async (name) => {
    await p.evaluate(() => { window.__aqua.freeze = true; });
    await p.waitForTimeout(120);
    await p.screenshot({ path: `${O.dir}/${tag}-${name}.jpg`, type: 'jpeg', quality: 80 });
  };
  const names = ['sand', 'cave', 'log', 'tunnel', 'cliff'];
  const places = O.places ?? [0, 1, 2, 3, 4];
  const styles = O.styles ?? ['classic', 'tps', 'close', 'free'];
  const out = [];
  for (const i of places) for (const s of styles) {
    const r = await p.evaluate(([i, s]) => __cs.runStats(i, s), [i, s]);
    out.push(`${names[i]}/${s}: vis ${r.visible} dist ${r.dist} jump ${r.jump}`);
    await shot(`${names[i]}-${s}`);
  }
  // 自由追従：地面の下から・岩の中から・倒木の中から（カメラとカニの間だけ抜け、裏面は断面の色）
  if (styles.includes('free')) {
    for (const [name, i, pitch, zoom, yawAdd] of [['under-sand', 0, -0.55, 2.6, 0], ['in-rock', 1, 0.1, 3.4, Math.PI / 2], ['in-log', 2, -0.1, 2.4, Math.PI / 2]]) {
      await p.evaluate(([i, pitch, zoom, yawAdd]) => {
        const a = window.__aqua;
        __cs.run(i, 'free');
        a.freeze = false;
        a.camera.adventure.pitch = pitch;
        a.camera.adventure.zoom = zoom;
        a.camera.adventure.yaw += yawAdd;
        a.step(60);
      }, [i, pitch, zoom, yawAdd]);
      const st = await p.evaluate(() => { const a = window.__aqua, P = a.camera.pose.pos; return { inSolid: a.world.cameraSolid(P[0], P[1], P[2], a.crab.region) < 0, cutOn: +a.camera.cut.on.toFixed(2), sand: +a.camera.cut.sand.toFixed(2) }; });
      out.push(`free-${name}: ${JSON.stringify(st)}`);
      await shot(`free-${name}`);
    }
  }
  await p.evaluate(() => window.__aqua.camera.setStyle('tps'));
  await ctx.close();
  return out.join('\n');
}
