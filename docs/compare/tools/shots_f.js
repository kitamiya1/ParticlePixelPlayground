async (page) => {
  // 方式 F 画質改善の撮影視点（capture_f.js の前に 1 回実行する）。
  // カメラの注視点はキャラクター + (dx, 0.6 + dy, dz)。キャラクターの既定位置はスポーン (-1, 1.5)。
  // window.__mk(prefix, set, views?) で撮影一覧を作り、window.__shots に入れてから capture_f.js を実行する。
  return page.evaluate(() => {
    window.__views = [
      { v: 'std', cam: {} },
      { v: 'near', cam: { zoom: 7.5 } },
      { v: 'far', cam: { zoom: 33 } },
      { v: 'low', cam: { pitch: 0.3 } },
      { v: 'road', cam: { zoom: 6, dx: -10, dz: 2.5, dy: -0.3 } },
      { v: 'road-low', cam: { zoom: 6, pitch: 0.32, dx: -10, dz: 2.5, dy: -0.3 } },
      { v: 'road-yaw', cam: { zoom: 6, yaw: 2.2, dx: 5, dz: -3.5, dy: -0.2 } },
      { v: 'rock', cam: { zoom: 5, dx: -4.1, dz: -1.7, dy: -0.2 } },
      { v: 'tree', cam: { zoom: 6, pitch: 0.45, dx: -3.5, dz: 6.1, dy: 0.2 } },
      { v: 'flower', cam: { zoom: 5, dx: 0.7, dz: -4.4, dy: -0.2 } },
      { v: 'char-idle', cam: { zoom: 3.2, dy: -0.2 }, char: { x: 3, z: 5 } },
      { v: 'char-walk', cam: { zoom: 3.2, dy: -0.2 }, char: { x: 3, z: 5, state: 'walk', phase: 0.8, heading: 0.9 } },
      { v: 'char-run', cam: { zoom: 3.2, dy: -0.2 }, char: { x: 3, z: 5, state: 'run', phase: 1.6, heading: 0.9 } },
      { v: 'char-road', cam: { zoom: 3.2, dy: -0.2 }, char: { state: 'walk', phase: 0.8, heading: 0.9 } },
    ];
    window.__mk = (prefix, set, views, method) =>
      (views || window.__views.map((x) => x.v)).map((v) => {
        const w = window.__views.find((x) => x.v === v);
        return { name: prefix + v, method: method || 'hybrid', set, cam: w.cam, char: w.char };
      });
    return window.__views.length;
  });
}
