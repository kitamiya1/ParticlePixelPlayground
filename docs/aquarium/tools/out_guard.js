// 検証の道具が画像を保存する前の確認（各道具が fetch + eval で読み込む。Playwright の browser_run_code_unsafe の中で使う）。
// 過去の報告の比較画像を上書きしないよう、保存先に同じ名前のファイルが既にあれば止める（設定の overwrite: true のときだけ上書き）。
// 有無は開発サーバー（5173。プロジェクトの直下を配る）から同じ場所を読んで調べる。docs/ の外の保存先は調べない。
// 使い方：const shotPath = (0, eval)(await (await fetch('http://localhost:5173/docs/aquarium/tools/out_guard.js')).text())(O);
//         await p.screenshot({ path: await shotPath(`${O.dir}/a.jpg`) });
(O) => async (path) => {
  const p = String(path).replace(/\\/g, '/');
  const i = p.indexOf('/docs/');
  if (O.overwrite || i < 0) return path;
  const r = await fetch('http://localhost:5173' + encodeURI(p.slice(i)) + '?' + Date.now(), { method: 'HEAD' });
  // 無いファイルは開発サーバーが index.html（text/html）を返す
  if (r.ok && !(r.headers.get('content-type') ?? '').startsWith('text/html')) {
    throw new Error(`既にある画像は上書きしない（新しい保存先を dir / shotDir に指定するか、overwrite: true）：${path}`);
  }
  return path;
}
