// 地上 ↔ トンネルの出入りのカメラの検証（Playwright。browser_run_code_unsafe で実行。設定は cam_entry_config.json）。
// { hosts: { 名前: URL }, dir: 画面の保存先（null なら撮らない）, views: [{ name, dyaw, pitch }] }
// 岸の斜面へ水平に 5 秒掘った穴（区画は作り直して当たり判定に入れる）へ、地上から歩いて入り（4 秒）、後ろへ歩いて出て（4 秒）、
// もう一度入る（4 秒）。
// 視点の向き（カニの後ろ + dyaw、pitch）ごとに、毎フレームのカメラの位置の動き（jump）・カメラとカニの距離・地下の度合い・
// 壁までの距離を記録して、最大の動き・それが起きた時刻・距離の変化の速さ（1 秒あたり）を返す。
// 入る途中の 4 つの時刻の画面を撮る（`${dir}/entry-${host}-${view}-${t}.jpg`）。
// 補助（freedig_helpers.js）は各ホストから読む。
async (page) => {
  const cfgPage = await page.context().newPage();
  await cfgPage.goto('http://localhost:5173/docs/aquarium/tools/cam_entry_config.json?' + Date.now());
  const O = JSON.parse(await cfgPage.evaluate(() => document.body.innerText));
  await cfgPage.close();
  const out = {};
  const errors = [];
  for (const [hn, host] of Object.entries(O.hosts)) {
    out[hn] = {};
    for (const v of O.views) {
      const ctx = await page.context().browser().newContext({ viewport: { width: O.w ?? 960, height: O.h ?? 600 }, deviceScaleFactor: 1 });
      const p = await ctx.newPage();
      p.on('pageerror', (e) => errors.push(hn + ': ' + String(e)));
      await p.goto(host + '/aquarium.html?' + Date.now());
      await p.waitForFunction(() => window.__aqua, null, { timeout: 180000 });
      await p.evaluate(() => document.getElementById('help')?.classList.add('fade'));
      await p.evaluate(async (src) => { const t = await fetch(src).then((r) => r.text()); (0, eval)(t); }, host + '/docs/aquarium/tools/freedig_helpers.js?' + Date.now());
      // 穴を掘って、入口の手前へ戻る
      await p.evaluate((v) => {
        const a = window.__aqua, fd = window.__fd;
        fd.setup(-4.6, 8.3, Math.PI / 2);
        fd.run(5, true, { x: 0, y: 0 }, { x: 0, y: 1 });
        a.view.digFx.flushAll();
        fd.setup(-5.8, 8.3, Math.PI / 2);
        a.camera.adventure.yaw = Math.PI / 2 + Math.PI + v.dyaw;
        a.camera.adventure.pitch = v.pitch;
        a.freeze = false; a.step(90); a.freeze = true;
      }, v);
      const trace = async (sec, move, shots) => {
        const n = Math.round(sec * 60);
        const rec = [];
        let i = 0;
        const shotAt = new Set((shots ?? []).map((t) => Math.round(t * 60)));
        while (i < n) {
          const k = Math.min(n, [...shotAt].filter((s) => s > i).sort((a, b) => a - b)[0] ?? n);
          const part = await p.evaluate(([cnt, move]) => {
            const a = window.__aqua, c = a.crab, cam = a.camera, w = a.world;
            const inp = a.input;
            // move = 世界の向きの移動（+x = トンネルの奥へ）。視点の向きによらず同じ道を歩くよう、毎フレームカメラ基準の入力に直す
            inp.moveAxis = () => {
              const yaw = cam.yaw, fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
              return { x: move.x * rx + move.z * rz, y: move.x * fx + move.z * fz };
            };
            a.freeze = false;
            const r = [];
            for (let j = 0; j < cnt; j++) {
              const prev = [...cam.pose.pos];
              a.step(1);
              const P = cam.pose.pos;
              const jump = Math.hypot(P[0] - prev[0], P[1] - prev[1], P[2] - prev[2]);
              const dc = Math.hypot(P[0] - c.x, P[1] - (c.y + c.radius), P[2] - c.z);
              r.push([+jump.toFixed(4), +dc.toFixed(3), +cam.tunnel.toFixed(3), +w.cameraSolid(P[0], P[1], P[2], cam.region).toFixed(3), +(w.groundAt(c.x, c.z) - c.y - c.radius).toFixed(2)]);
            }
            a.freeze = true;
            return r;
          }, [k - i, move]);
          rec.push(...part);
          i = k;
          if (shotAt.has(i) && O.dir) await p.screenshot({ path: `${O.dir}/entry-${hn}-${v.name}-${(i / 60).toFixed(1)}.jpg`, type: 'jpeg', quality: 80 });
        }
        let jmax = 0, at = 0, dcRate = 0, minClear = 9;
        for (let j = 0; j < rec.length; j++) {
          if (rec[j][0] > jmax) { jmax = rec[j][0]; at = j; }
          if (j > 0) dcRate = Math.max(dcRate, Math.abs(rec[j][1] - rec[j - 1][1]) * 60);
          minClear = Math.min(minClear, rec[j][3]);
        }
        const every = rec.filter((_, j) => j % 15 === 0).map((r) => `${r[1]}/${r[2]}/${r[4]}`);
        return { maxJump: jmax, atSec: +(at / 60).toFixed(2), maxDistRate: +dcRate.toFixed(2), minClear, distTunnelDepth: every.join(' ') };
      };
      const walkIn = await trace(4, { x: 1, z: 0 }, O.dir ? [0.5, 1.0, 1.4, 1.8, 3.5] : []);
      const walkOut = await trace(4, { x: -1, z: 0 }, []);
      // 再進入（出た所からもう一度入る）
      const walkIn2 = await trace(4, { x: 1, z: 0 }, []);
      out[hn][v.name] = { walkIn, walkOut, walkIn2 };
      await ctx.close();
    }
  }
  out.errors = errors;
  return out;
}
