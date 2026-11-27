// 動いている場所（ブラウザ／アプリ版＝Tauri の WebView）の違いを吸収する所。ゲーム本体はここ以外でアプリかどうかを見ない。
// - セーブデータの書き出し：ブラウザは <a download>（Blob の URL）でダウンロード。アプリ版の WebView（特に Android・iOS）は
//   Blob のダウンロードを受け付けないので、OS の「保存」ダイアログで場所を選ばせてから Tauri の fs で書く。
// - 読み込み：ブラウザは <input type="file">。アプリ版は OS の「開く」ダイアログ → fs で読む（Android は content:// の URI）。
// - 起動の記録（diag）：アプリ版はネイティブ側の標準エラーへも出す（iOS の CI でページの中の様子を知る唯一の道）。
// - Tauri の JS（@tauri-apps/*）はアプリ版のときだけ動的に読み込む（ブラウザ版の起動には読み込まない）。

/** アプリ版（Tauri）の中で動いているか */
export const IS_APP = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export type SaveFileResult = 'saved' | 'cancelled';

/** テキストをファイルへ書き出す。利用者が保存をやめたら 'cancelled'。書けなかったら例外 */
export async function saveTextFile(text: string, name: string): Promise<SaveFileResult> {
  if (!IS_APP) {
    browserDownload(text, name);
    return 'saved';
  }
  const [{ save }, { writeTextFile }] = await Promise.all([import('@tauri-apps/plugin-dialog'), import('@tauri-apps/plugin-fs')]);
  const path = await save({ defaultPath: name, filters: [{ name: 'セーブデータ（JSON）', extensions: ['json'] }] });
  if (!path) return 'cancelled';
  await writeTextFile(path, text);
  return 'saved';
}

/** アプリ版：ファイルを選ばせて中身を読む（やめたら null）。ブラウザ版では使わない（<input type="file"> を使う） */
export async function openTextFile(maxBytes: number): Promise<{ name: string; text: string } | null> {
  const [{ open }, { readTextFile, stat }] = await Promise.all([import('@tauri-apps/plugin-dialog'), import('@tauri-apps/plugin-fs')]);
  const path = await open({ multiple: false, directory: false, filters: [{ name: 'セーブデータ（JSON）', extensions: ['json'] }] });
  if (!path) return null;
  const size = await stat(path).then((s) => s.size, () => 0);
  if (size > maxBytes) throw new Error('ファイルが大きすぎます');
  const text = await readTextFile(path);
  if (text.length > maxBytes) throw new Error('ファイルが大きすぎます');
  return { name: path.split(/[\\/]/).pop() ?? path, text };
}

/** 起動・描画の喪失と復旧の記録（最近の 300 行。自動検証が __aqua.diagLog で読む） */
export const diagLog: string[] = [];
const T0 = Date.now() - performance.now();

/**
 * 起動の段階・描画の喪失と復旧を 1 行記録する。ブラウザ版は console.info と diagLog だけ。アプリ版は Tauri の diag_log で
 * 標準エラーへも出す（iOS シミュレーターの CI が `simctl launch --stderr` で受け取る：ページの中から外へ出せる唯一の道）。
 * 時刻は端末の時計（UTC）と、ページを開いてからの秒（系統のログと突き合わせるため両方）
 */
export function diag(line: string) {
  const now = performance.now();
  const s = `[aqua ${new Date(T0 + now).toISOString().slice(11, 23)}Z +${(now / 1000).toFixed(2)}s] ${line}`;
  diagLog.push(s);
  if (diagLog.length > 300) diagLog.shift();
  console.info(s);
  if (IS_APP) void import('@tauri-apps/api/core').then(({ invoke }) => invoke('diag_log', { line: s })).catch(() => {});
}

/** 自動検証の指定（アプリ版：環境変数 AQUA_SELFTEST。ブラウザ版：URL の ?selftest=…）。無ければ null */
export async function selftestMode(): Promise<string | null> {
  const q = new URLSearchParams(location.search).get('selftest');
  if (q) return q;
  if (!IS_APP) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return (await invoke<string | null>('diag_selftest')) ?? null;
  } catch {
    return null;
  }
}

function browserDownload(text: string, name: string) {
  const blob = new Blob([text], { type: 'application/json' });
  const a = document.createElement('a');
  a.download = name;
  a.href = URL.createObjectURL(blob);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
