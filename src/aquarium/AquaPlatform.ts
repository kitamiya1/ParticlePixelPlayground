// 動いている場所（ブラウザ／アプリ版＝Tauri の WebView）の違いを吸収する所。ゲーム本体はここ以外でアプリかどうかを見ない。
// - セーブデータの書き出し：ブラウザは <a download>（Blob の URL）でダウンロード。アプリ版の WebView（特に Android・iOS）は
//   Blob のダウンロードを受け付けないので、OS の「保存」ダイアログで場所を選ばせてから Tauri の fs で書く。
// - 読み込み：ブラウザは <input type="file">。アプリ版は OS の「開く」ダイアログ → fs で読む（Android は content:// の URI）。
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
