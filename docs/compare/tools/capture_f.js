async (page) => {
  // 方式 F 画質改善の比較撮影（tools/capture.js を基に、撮影条件をこのスクリプトの中で固定したもの）。
  // - 既定値：起動直後（localStorage 空）の設定を window.__defaults に 1 回だけ記録して使う（無ければここで記録する）。
  // - キャラクター：起動直後の位置（スポーン）を window.__charInit に記録。撮影ごとに sh.char.x / z で置き場所を変えられる
  //   （y は地形の高さ）。姿勢 state = idle / walk / run、歩幅の位相 phase。
  // - 時刻：ゲーム時間 5、リグの時間 0、風 0。window.__ppp.freeze = true でゲームの更新を止め dt = 0 で描く
  //   （止めないと、キャラの状態が速度 0 から idle に戻り、カメラの注視点がキャラへ寄っていく）。
  // 撮影一覧は window.__shots（[{ name, method, set, cam, char }]）、出力先は window.__outDir。
  // window.__jobs（[{ dir, shots }]）があれば、それを順に全部撮る（撮り終えたら空にする）。
  await page.evaluate(() => {
    const p = window.__ppp;
    p.freeze = true;
    // 操作説明（タッチ判定の環境では 9 秒後に消える）は撮影の最初だけ写るので隠す
    const help = document.getElementById('help');
    if (help) help.style.display = 'none';
    if (!window.__defaults) window.__defaults = JSON.parse(JSON.stringify(p.settings));
    if (!window.__charInit) {
      const ch = p.game.character;
      window.__charInit = { x: ch.x, y: ch.y, z: ch.z, heading: ch.heading };
    }
  });
  const jobs = await page.evaluate(() => {
    const j = window.__jobs && window.__jobs.length ? window.__jobs : [{ dir: window.__outDir, shots: window.__shots }];
    window.__jobs = [];
    return j;
  });
  const log = [];
  for (const { dir: outDir, shots } of jobs) for (const sh of shots) {
    await page.evaluate(async (sh) => {
      const p = window.__ppp;
      const def = window.__defaults;
      Object.assign(p.settings, def, { wind: 0 }, sh.set || {});
      p.settings.renderMethod = sh.method || p.settings.renderMethod;
      const c = p.game.camera;
      const cam = Object.assign({ yaw: 0.75, pitch: 0.6, zoom: 15 }, sh.cam || {});
      c.yaw = cam.yaw; c.pitch = cam.pitch; c.zoom = cam.zoom;
      const ch = p.game.character;
      const ci = window.__charInit;
      const cx = sh.char?.x ?? ci.x, cz = sh.char?.z ?? ci.z;
      ch.x = cx; ch.z = cz;
      ch.y = sh.char?.x !== undefined || sh.char?.z !== undefined ? p.game.layout.terrain.heightAt(cx, cz) : ci.y;
      ch.heading = sh.char?.heading ?? ci.heading;
      ch.state = sh.char?.state ?? 'idle';
      ch.stridePhase = sh.char?.phase ?? 0;
      const rig = p.view.rig;
      rig.walkW = ch.state === 'walk' ? 1 : 0;
      rig.runW = ch.state === 'run' ? 1 : 0;
      rig.t = 0;
      p.game.time = 5;
      c.target = { x: ch.x + (cam.dx || 0), y: ch.y + 0.6 + (cam.dy || 0), z: ch.z + (cam.dz || 0) };
      for (let i = 0; i < 400; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        const busy = p.view.splatStatus === 'loading' || (sh.method === 'splats' && (!p.view.splat || p.view.splat.busy));
        if (i > (sh.frames || 30) && !busy) break;
      }
    }, sh);
    await page.locator('#view').screenshot({ path: `${outDir}/${sh.name}.png` });
    log.push(sh.name);
  }
  return log;
}
