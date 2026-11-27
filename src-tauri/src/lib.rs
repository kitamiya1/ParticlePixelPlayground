// 水槽探検のアプリ版（Tauri 2）。ゲーム本体はブラウザ版と同じ Web のコード（../dist-app）を OS の WebView で動かす。
// ネイティブ側で足すのは、セーブデータのファイル書き出し・読み込み用のダイアログとファイルの読み書きと、次の 2 つだけ：
// - 起動の記録（diag_log）：ゲームの起動の段階・描画の喪失と復旧を標準エラーへ 1 行ずつ出す（iOS シミュレーターの CI が
//   `simctl launch --stderr` で受け取る。Windows・Android では読む人がいないだけで害は無い）
// - iOS の WebView の余白：WKWebView のスクロールビューは既定で安全領域（ホームインジケーター・ノッチ）の分だけ
//   中身を縮めるので、画面の下に WebView の地の色の帯が出る。縮めない（never）にして、ページ側の viewport-fit=cover と
//   env(safe-area-inset-*) でボタンを安全領域の内側へ置く
#[tauri::command]
fn diag_log(line: String) {
  eprintln!("{line}");
}

/// 自動検証の指定（環境変数 AQUA_SELFTEST。iOS シミュレーターでは `SIMCTL_CHILD_AQUA_SELFTEST` で渡す）。ふだんは None
#[tauri::command]
fn diag_selftest() -> Option<String> {
  std::env::var("AQUA_SELFTEST").ok().filter(|s| !s.is_empty())
}

#[cfg(target_os = "ios")]
fn ios_fill_safe_area(app: &tauri::App) {
  use tauri::Manager;
  let Some(win) = app.get_webview_window("main") else { return };
  let _ = win.with_webview(|wv| unsafe {
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
    eprintln!("[native] ios: scrollView.contentInsetAdjustmentBehavior = never");
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
      #[cfg(target_os = "ios")]
      ios_fill_safe_area(app);
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
