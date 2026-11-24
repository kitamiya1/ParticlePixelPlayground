// 移動（左のスティック）と掘る向き（掘るボタンの照準）が別々に効くかの検証（Playwright。browser_run_code_unsafe で実行）。
// 設定は freedig_config.json（{ host, base }。host = 変更後、base = 変更前のビルド。dig_independence の結果を両方で出す）。
// 岸の斜面の前（-4.6, 8.3）に体の向き +x（カメラは体の後ろ）で置き、ゲームの処理（__aqua.step）で進める：
//   A. 上を掘りながら前へ（照準 y 0.75 + スティック前）
//   B. 右を掘りながら左へ（照準 x 1 + スティック左）
//   C. その場で掘る向きだけ変える（スティックなし、照準を左 → 右へ）
//   D. 掘りながらカメラを回す（照準・スティックなし、視点を 1.5 rad 回す）
//   E. 掘りながらカメラを回し、スティックは前のまま
// それぞれ、動いた向き（カメラ基準：前 = 0、右 = +π/2）・動いた距離・掘る向き（押したときからの方位の変化・仰角）・体の向きの変化を返す。
async (page) => {
  const cfgPage = await page.context().newPage();
  await cfgPage.goto('http://localhost:5180/docs/aquarium/tools/freedig_config.json?' + Date.now());
  const O = JSON.parse(await cfgPage.evaluate(() => document.body.innerText));
  await cfgPage.close();
  const out = {};
  for (const [name, host] of [['after', O.host], ...(O.base ? [['before', O.base]] : [])]) {
    const ctx = await page.context().browser().newContext({ viewport: { width: 640, height: 400 } });
    const p = await ctx.newPage();
    await p.goto(host + '/aquarium.html?' + Date.now());
    await p.waitForFunction(() => window.__aqua, null, { timeout: 180000 });
    out[name] = await p.evaluate(() => {
      const a = window.__aqua, c = a.crab, cam = a.camera, inp = a.input;
      const wrap = (v) => Math.atan2(Math.sin(v), Math.cos(v));
      const place = () => {
        a.freeze = true;
        c.teleport(-4.6, 8.3);
        c.heading = Math.PI / 2;
        cam.adventure.yaw = c.heading + Math.PI;
        cam.adventure.pitch = 0.3;
        a.dig = false;
        a.digAim = null;
        inp.moveAxis = () => ({ x: 0, y: 0 });
        a.freeze = false;
        a.step(40);
        a.freeze = true;
      };
      // sec 秒：aim(t) = 照準、move(t) = スティック（カメラ基準）、yawRate = 視点を回す速さ（rad/s）
      const run = (sec, aim, move, yawRate = 0) => {
        place();
        const x0 = c.x, z0 = c.z, h0 = c.heading, camYaw0 = cam.yaw;
        a.dig = true;
        a.freeze = false;
        let y0 = null, yawMin = 9, yawMax = -9;
        const n = Math.round(sec * 60);
        for (let i = 0; i < n; i++) {
          const t = i / n;
          a.digAim = aim(t);
          const m = move(t);
          inp.moveAxis = () => m;
          cam.adventure.yaw += yawRate / 60;
          a.step(1);
          if (y0 === null) y0 = c.digYaw;
          const dy = wrap(c.digYaw - y0);
          yawMin = Math.min(yawMin, dy);
          yawMax = Math.max(yawMax, dy);
        }
        a.freeze = true;
        const mx = c.x - x0, mz = c.z - z0, moved = Math.hypot(mx, mz);
        // 動いた向きをカメラ（始めの向き）基準に：前 = 0、右 = +π/2
        const fx = -Math.sin(camYaw0), fz = -Math.cos(camYaw0), rx = Math.cos(camYaw0), rz = -Math.sin(camYaw0);
        const rel = moved > 0.05 ? +Math.atan2(mx * rx + mz * rz, mx * fx + mz * fz).toFixed(2) : null;
        const r = { moved: +moved.toFixed(2), moveDirCam: rel, digYawChange: +wrap(c.digYaw - y0).toFixed(2), digYawRange: [+yawMin.toFixed(2), +yawMax.toFixed(2)], digPitch: +c.digPitch.toFixed(2), headingChange: +wrap(c.heading - h0).toFixed(2), state: c.state, prims: a.world.dig.count };
        a.dig = false;
        a.digAim = null;
        return r;
      };
      return {
        A_upForward: run(2, () => ({ x: 0, y: 0.75 }), () => ({ x: 0, y: 1 })),
        B_rightDigLeftMove: run(2, () => ({ x: 1, y: 0 }), () => ({ x: -1, y: 0 })),
        C_aimOnly: run(2, (t) => ({ x: -1 + 2 * t, y: 0 }), () => ({ x: 0, y: 0 })),
        D_cameraTurn: run(2, () => ({ x: 0, y: 0 }), () => ({ x: 0, y: 0 }), 0.75),
        E_cameraTurnStickForward: run(2, () => ({ x: 0, y: 0 }), () => ({ x: 0, y: 1 }), 0.75),
      };
    });
    await ctx.close();
  }
  return out;
}
