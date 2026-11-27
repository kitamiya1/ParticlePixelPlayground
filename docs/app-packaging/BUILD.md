# アプリ版（Tauri 2）のビルドと検証の手順

対象：水槽探検（`aquarium.html`）。ブラウザ版と同じ Web のコードを、Windows・Android・iOS の OS の WebView で動かす。
実証試験の結果：`report.md`。ブラウザ版の手順（`npm run dev` / `npm run build` / GitHub Pages）は変わらない。

## 1. 構成

| 場所 | 中身 |
| --- | --- |
| `src-tauri/` | Tauri 2 のプロジェクト（`tauri.conf.json`・`capabilities/default.json`・`src/lib.rs`）。識別子 `io.github.kitamiya1.aquariumexplore`（**仮**：公開前に決める） |
| `src-tauri/gen/android/` | Android の Gradle プロジェクト（リポジトリに入っている。`tauri android init` は要らない） |
| `src-tauri/gen/apple/` | Xcode プロジェクト（同上。Team は空 = 署名なし） |
| `src/aquarium/AquaPlatform.ts` | ブラウザ版とアプリ版の違い（ファイルの書き出し・読み込み・起動の記録）は、ここだけに置く |
| `npm run build:app` | `vite build --mode app` → `dist-app/`（ゲームのページだけ）。Tauri のビルドが自動で実行する |

## 2. CI（GitHub Actions）— main と PR で同じ手順を再現する

| ワークフロー | ランナー | 作る物（Artifacts） | 検証 |
| --- | --- | --- | --- |
| `.github/workflows/app-build.yml` の `windows` | windows-latest | NSIS `.exe`・`.msi`（署名なし）、SHA-256 | ビルドが通る（型の確認を含む） |
| `.github/workflows/app-build.yml` の `android` | ubuntu-latest（JDK 21・NDK 28.2） | universal release APK（未署名、4 ABI）、SHA-256、権限の一覧 | ビルドが通る・release の APK に `INTERNET` の権限が無い |
| `.github/workflows/app-ios.yml` | macos-15 | シミュレーター用 `.app`（署名なし）、Xcode プロジェクト、起動の試験の画面・記録・まとめ | シミュレーターで初回起動 × 3・対照 × 2・再起動・続けて起動 × 3・GPU 処理を止めた後の復旧（`tools/ios-sim-run.sh`、約 50 分）。実機用（`aarch64`）のビルドは署名が無いので失敗する（想定どおり。`continue-on-error`） |

どれも `src/**`・`src-tauri/**`・`aquarium.html`・`package*.json`・`vite.config.ts` が変わった push（main）と PR、または手動（workflow_dispatch）で動く。
iOS の試験用ビルドは機能 `selftest` 付き（環境変数 `AQUA_SELFTEST` で自動検証を動かす）。配布するビルドには付けない（2.1）。

### 2.1 試験用の機能（配布するビルドでは無効）

| 機能 | 有効になる条件 | 中身 |
| --- | --- | --- |
| 自動検証（`AQUA_SELFTEST=gpu` / `noprepare`） | アプリ：debug ビルド、または `--features selftest` のビルド。ブラウザ：開発サーバー（`npm run dev`）の `?selftest=` | `gpu` は起動の 4 秒後にその場で掘って保存する。配布版で外から進捗を変えさせないため、通常のリリース版・公開のブラウザ版では読まない |
| WebView の DevTools | アプリ：debug ビルド（Android の debug APK）。Windows は WebView2 の環境変数 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` でリリース版でもつながる（WebView2 の仕様。その PC の利用者の環境変数を書き換えられる人にしか使えない） | 試験道具（`tools/smoke.mjs` など）が CDP でつなぐ |
| 起動の記録（`diag.log`） | いつも | アプリの記録のフォルダ（Windows：`%LOCALAPPDATA%\io.github.kitamiya1.aquariumexplore\logs\`）。時刻・段階・数・GPU の名前・User-Agent だけ。1 行 2000 文字まで・256 KB で 1 世代 |

## 3. 手元でビルドする

### 3.1 共通

- Node.js 24（CI と同じ）、`npm ci`。
- Rust（stable。開発機は 1.100、`rust-version` は 1.90 以上）。rustup で入れた場合、新しいシェルでは
  `$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"` が要ることがある。

### 3.2 Windows

```powershell
npm run app:win
```

出力：`src-tauri/target/release/bundle/nsis/Aquarium Explore_<版>_x64-setup.exe`・`bundle/msi/…_x64_en-US.msi`。初回は NSIS・WiX・WebView2 のブートストラッパーを自動で取得する。
黙ってインストール：`& ".\Aquarium Explore_0.1.0_x64-setup.exe" /S`（`%LOCALAPPDATA%\Aquarium Explore`）。

### 3.3 Android

- Android Studio の JDK（`JAVA_HOME` = `…\Android Studio\jbr`）、SDK（Platform 37・Build-Tools 36）、NDK 28.2（`NDK_HOME`）、
  Rust のターゲット `aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`。

```powershell
npm run app:android
```

- 出力：`src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk`（4 ABI。初回 約 18 分）。
  エミュレーターだけなら `npx tauri android build --apk --target x86_64` が速い。
- 試験用 debug APK（DevTools・通信の権限あり）：`npx tauri android build --apk --debug --target x86_64`。
- 未署名の APK は入らない。試験では使い捨ての鍵で署名する（鍵はリポジトリに入れない。`.gitignore` 済み）：

```powershell
keytool -genkeypair -keystore $env:TEMP\ppp-test.jks -alias test -keyalg RSA -keysize 2048 -validity 30 -storepass <使い捨て> -dname "CN=test"
& "$env:LOCALAPPDATA\Android\Sdk\build-tools\36.0.0\apksigner.bat" sign --ks $env:TEMP\ppp-test.jks --out app-test.apk app-universal-release-unsigned.apk
```

- 通信の権限（`INTERNET`）は debug ビルドだけ（`gen/android/app/src/debug/AndroidManifest.xml`）。ゲームは外へ通信しない。

### 3.4 iOS（macOS だけ）

Mac が無い場合は CI（`app-ios.yml`）で作る。手元の Mac では Xcode・`rustup target add aarch64-apple-ios aarch64-apple-ios-sim` のあと：

```bash
npx tauri ios build --target aarch64-sim          # シミュレーター用（署名なし）
npx tauri ios build --target aarch64-sim --features selftest   # 自動検証つき（CI と同じ）
```

`xcodebuild` を直接呼ぶと Rust を作る手順が動かない（Tauri の CLI が動いている間だけ動く）。実機用（`--target aarch64`）には Apple の Team・証明書・
プロビジョニングが要る（`report.md` の iPhone の章）。

## 4. 検証

### 4.1 ブラウザ版の回帰（開発サーバー）

`npm run dev`（`.claude/launch.json` の `dev`、5173）を起動し、Playwright で `docs/aquarium/tools/*_test.js` を実行する（各ファイルの先頭に使い方）。
保存まわりは `save_conflict_test.js`（複数タブ・控え・失敗）と `save_fallback_test.js`（localStorage から IndexedDB への引き継ぎ）。
どちらも場面ごとに新しいブラウザの文脈を作るので、開発用のブラウザの保存データには触れない。

### 4.2 アプリの中での動作（Windows・Android）

1. Windows：`$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"` を設定して、インストールしたアプリを起動。
   Android：debug APK を入れて起動し、`docs/app-packaging/tools/android-ui.ps1 -Forward 9333`。
2. `node docs/app-packaging/tools/smoke.mjs --port 9222 --out <フォルダ> --phase first`（Android はタッチの `--touch`）。
3. アプリを閉じて起動し直し、`--phase restore` で保存から戻ったかを比べる。
4. 描画の喪失と復旧：`node docs/app-packaging/tools/gpu-recovery.mjs --port 9222 --out <フォルダ>`。
5. 試験の前後でアプリのデータ（Windows：`%LOCALAPPDATA%\io.github.kitamiya1.aquariumexplore\EBWebView`）を退避・戻すと、利用者の進捗に触れない。

Android の CDP の画面写真には WebGL が写らない。画面は `adb exec-out screencap -p`（PowerShell の `>` は画像を壊すので `adb shell screencap` + `adb pull`）で撮る。

### 4.3 セキュリティの設定（変えたら確かめる）

| 設定 | 場所 | いまの値 |
| --- | --- | --- |
| CSP | `tauri.conf.json` の `app.security.csp` | `default-src 'self'`・`script-src 'self'`・`style-src 'self'`・`img-src 'self' data: blob:`・`connect-src ipc: http://ipc.localhost`・`object-src / frame-src / worker-src 'none'`・`base-uri / form-action 'none'`。外部の通信・外部の資源は読めない。Tauri が自分のスクリプトのハッシュを足す |
| 権限 | `capabilities/default.json` | `dialog:allow-save / allow-open`、`fs:allow-write-text-file / allow-read-text-file / allow-stat`。fs の道は、ダイアログで利用者が選んだファイルだけが実行時に許される（`core:default` は入れない） |
| アプリのコマンド | `src/lib.rs` | `diag_log`（1 行 2000 文字まで・制御文字は空白へ）、`diag_selftest`（2.1） |
| Android の権限 | `gen/android/app/src/main/AndroidManifest.xml` | 権限なし（`INTERNET` は debug だけ）。`usesCleartextTraffic` は release で false |

機能を足して外部の通信・新しい OS の機能が要るときは、CSP と capabilities に必要なものだけを足す（`report.md` 8 章）。
