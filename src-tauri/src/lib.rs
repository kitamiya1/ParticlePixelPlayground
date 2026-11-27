// 水槽探検のアプリ版（Tauri 2）。ゲーム本体はブラウザ版と同じ Web のコード（../dist-app）を OS の WebView で動かす。
// ネイティブ側で足すのは、セーブデータのファイル書き出し・読み込み用のダイアログとファイルの読み書きと、次の 2 つだけ：
// - 起動の記録（diag_log）：ゲームの起動の段階・描画の喪失と復旧を 1 行ずつ、標準エラーとアプリの記録のフォルダの diag.log へ
//   書く（iOS シミュレーターの CI がアプリのデータの入れ物から読む。256 KB で 1 世代だけ回す。中身は時刻・段階・数だけ）
// - iOS の WebView の余白：WKWebView のスクロールビューは既定で安全領域（ホームインジケーター・ノッチ）の分だけ
//   中身を縮めるので、画面の下に WebView の地の色の帯が出る。縮めない（never）にして、ページ側の viewport-fit=cover と
//   env(safe-area-inset-*) でボタンを安全領域の内側へ置く
/// ページから書ける 1 行の長さの上限（文字）。これを超える分は切る（記録のファイルを大きくしない）
const DIAG_LINE_MAX: usize = 2000;

#[tauri::command]
fn diag_log(app: tauri::AppHandle, line: String) {
  // 改行を含めさせない（1 回の呼び出しで記録の行を偽らない）
  let line: String = line.chars().take(DIAG_LINE_MAX).map(|c| if c.is_control() { ' ' } else { c }).collect();
  diag_write(&app, &line);
}

/// 記録を標準エラーと、アプリの記録のフォルダの diag.log（256 KB を超えたら diag.1.log へ回す）へ書く。
/// iOS のリリース版では標準エラーが `simctl launch --stderr` へ届かなかった（第 3 段の CI）ので、ファイルにも残す。
/// CI は `simctl get_app_container … data` の Library/Logs から読む
fn diag_write(app: &tauri::AppHandle, line: &str) {
  use std::io::Write;
  use tauri::Manager;
  eprintln!("{line}");
  let Ok(dir) = app.path().app_log_dir() else { return };
  if std::fs::create_dir_all(&dir).is_err() {
    return;
  }
  let path = dir.join("diag.log");
  if std::fs::metadata(&path).map(|m| m.len() > 256 * 1024).unwrap_or(false) {
    let _ = std::fs::rename(&path, dir.join("diag.1.log"));
  }
  if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
    let _ = writeln!(f, "{line}");
  }
}

/// 自動検証の指定（環境変数 AQUA_SELFTEST。iOS シミュレーターでは `SIMCTL_CHILD_AQUA_SELFTEST` で渡す）。ふだんは None。
/// 読むのは debug ビルドと、機能 selftest を付けたビルド（CI）だけ。配布するリリース版は環境変数を見ない
/// （自動検証の gpu はその場で掘って保存するので、外から利用者の進捗を変えさせない）
#[tauri::command]
fn diag_selftest() -> Option<String> {
  selftest_env()
}

fn selftest_env() -> Option<String> {
  if !cfg!(any(debug_assertions, feature = "selftest")) {
    return None;
  }
  std::env::var("AQUA_SELFTEST").ok().filter(|s| !s.is_empty())
}

#[cfg(target_os = "ios")]
fn ios_fill_safe_area(app: &tauri::App) {
  use tauri::Manager;
  let Some(win) = app.get_webview_window("main") else {
    diag_write(app.handle(), "[native] ios: main window not found (safe area not changed)");
    return;
  };
  let handle = app.handle().clone();
  let _ = win.with_webview(move |wv| unsafe {
    use objc2::runtime::AnyObject;
    let wk = wv.inner() as *mut AnyObject;
    if wk.is_null() {
      return;
    }
    let scroll: *mut AnyObject = objc2::msg_send![wk, scrollView];
    if scroll.is_null() {
      return;
    }
    // UIScrollViewContentInsetAdjustmentBehavior.never = 2
    let _: () = objc2::msg_send![scroll, setContentInsetAdjustmentBehavior: 2isize];
    diag_write(&handle, "[native] ios: scrollView.contentInsetAdjustmentBehavior = never");
  });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .invoke_handler(tauri::generate_handler![diag_log, diag_selftest])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      diag_write(
        app.handle(),
        &format!("[native] start {} selftest={:?}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0), selftest_env()),
      );
      #[cfg(target_os = "ios")]
      ios_fill_safe_area(app);
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
