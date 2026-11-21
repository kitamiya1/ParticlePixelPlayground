async (page) => {
  // 比較撮影：時刻を固定（dt = 0）し、同じカメラ・同じ描画解像度で各方式を描いてキャンバスだけを保存する。
  // 撮影一覧は window.__shots（[{ name, method, set, cam, char }]）、出力先は window.__outDir。
  const shots = await page.evaluate(() => window.__shots);
  const outDir = await page.evaluate(() => window.__outDir);
  const log = [];
  for (const sh of shots) {
    await page.evaluate(async (sh) => {
      const p = window.__ppp;
      // 既定値から毎回組み直す（前の撮影の設定を持ち越さない）
      const def = window.__defaults;
      Object.assign(p.settings, def, { wind: 0 }, sh.set || {});
      p.settings.renderMethod = sh.method || p.settings.renderMethod;
      const c = p.game.camera;
      const cam = Object.assign({ yaw: 0.75, pitch: 0.6, zoom: 15 }, sh.cam || {});
      c.yaw = cam.yaw; c.pitch = cam.pitch; c.zoom = cam.zoom;
      const ch = p.game.character;
      const ci = window.__charInit;
      ch.x = ci.x; ch.y = ci.y; ch.z = ci.z; ch.heading = sh.char?.heading ?? ci.heading;
      ch.state = sh.char?.state ?? 'idle';
      ch.stridePhase = sh.char?.phase ?? 0;
      const rig = p.view.rig;
      rig.walkW = ch.state === 'walk' ? 1 : 0;
      rig.runW = ch.state === 'run' ? 1 : 0;
      rig.t = 0;
      p.game.time = 5;
      c.target = { x: ch.x + (cam.dx || 0), y: ch.y + 0.6 + (cam.dy || 0), z: ch.z + (cam.dz || 0) };
      // 描画が落ち着くまで待つ（B の読み込み・並べ替え、D・E の生成を含む）
      const t0 = performance.now();
      for (let i = 0; i < 400; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        const busy = p.view.splatStatus === 'loading' || (sh.method === 'splats' && (!p.view.splat || p.view.splat.busy));
        if (i > (sh.frames || 30) && !busy) break;
      }
      window.__lastWait = performance.now() - t0;
    }, sh);
    await page.locator('#view').screenshot({ path: `${outDir}/${sh.name}.png` });
    log.push(sh.name);
  }
  return log;
}
