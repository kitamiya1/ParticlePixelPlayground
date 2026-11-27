// 水槽探検のアプリ版（Tauri 2）。ゲーム本体はブラウザ版と同じ Web のコード（../dist-app）を OS の WebView で動かす。
// ネイティブ側で足すのは、セーブデータのファイル書き出し・読み込み用のダイアログとファイルの読み書きだけ。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
