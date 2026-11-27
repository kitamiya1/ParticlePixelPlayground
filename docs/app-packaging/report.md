# アプリ化の実証試験（Windows・Android・iOS）— Tauri 2

日付：2026-11-27　ブランチ：`feat/app-packaging-poc`（main `ad88fa9` から）　対象：水槽探検（`aquarium.html`）

## 0. 結論（区分）

| 対象 | 区分 | 根拠（要約） |
| --- | --- | --- |
| Windows（NSIS .exe） | **1. 実機インストール・動作確認済み** | 開発機（Windows 11・RTX 2060 SUPER）へ黙ってインストール（/S）・上書き更新・起動。掘る / 盛る / 壁 / 天井 / 崖 / 水草 / 生き物 / 音 / 保存→再起動→復元 / ファイルの書き出し・読み込み（OS のダイアログ）まで、アプリの中で確認 |
| Windows（.msi） | **2. ビルド成功・実機未検証** | 生成できた（3.8 MB）。管理者権限の要るインストールは試していない |
| Android（APK） | **2. ビルド成功・実機未検証**（エミュレーターでは全項目確認） | 4 ABI の universal release APK（19.8 MB）をビルドし、試験用の鍵で署名してエミュレーター（Android 15・x86_64）へインストール・起動・タッチで歩く / 掘るを確認。全項目の試験は debug APK（同じコード）で、本物のタッチのイベントで実施。**実機の Android 端末では未確認** |
| iOS（シミュレーター用 .app） | **2. ビルド成功・実機未検証** | GitHub Actions の macOS で Xcode プロジェクトを生成し、署名なしでシミュレーター用にビルド・起動・描画を確認（画面写真）。初回起動で WebKit の GPU 処理が「応答なし」で落ちた（5.3 節） |
| iOS（実機用 .ipa） | **5. 環境不足で検証不能**（ビルドは署名で失敗・原因判明） | `Signing for "app_iOS" requires a development team`。Apple Developer Program（有料）の Team・証明書・プロビジョニングが要る。契約・登録はしていない |

ゲーム本体の作り直しは **不要**。アプリ側の設定と、小さな修正（セーブの書き出し・読み込みの入口を OS のダイアログへ / IndexedDB の打ち切りの数え方）で動いた。
Electron・Capacitor への切り替えが要るほどの互換性の問題は見つからなかった（6 章）。

## 1. 現行構成の調査

| 項目 | 実装 | アプリ内 WebView での注意 |
| --- | --- | --- |
| ビルド | Vite 8、`base: './'`、2 ページ（`index.html` = 描画方式の比較・`aquarium.html` = ゲーム） | アプリには `aquarium.html` だけを入れる（`vite build --mode app` → `dist-app/`、1.0 MB。比較ページの Spark 2.8 MB は入れない） |
| 描画 | Three.js 0.187・WebGL2・独自シェーダー。約 59 万三角形 | Android の WebView・iOS の WKWebView・WebView2 とも WebGL2 が動いた。**WebGL のコンテキストが失われたときの処理が無い**（5.3 節） |
| 音 | Web Audio（`AquaAudio`）。最初の利用者の操作で AudioContext を作る | 3 つとも、本物のクリック / タッチの後で `running`・時間が進む・効果音が例外なく鳴る。iOS は未確認 |
| 保存 | IndexedDB（`ppp-aquarium`）→ localStorage → メモリ。隠れる・閉じる直前は localStorage へ同期の控え。BroadcastChannel でタブ間の競合 | 保存先の起点（origin）がブラウザ版と別（Windows・Android = `http://tauri.localhost`、iOS = `tauri://localhost`）。**ブラウザ版の進捗はアプリへ自動では移らない**（ファイルの書き出し・読み込みで移す） |
| 書き出し・読み込み | `<a download>`（Blob の URL）・`<input type="file">` | **Android・iOS の WebView は Blob のダウンロードを受け付けない**。→ アプリ版では OS の保存 / 開くダイアログ + Tauri の fs で行う（`AquaPlatform.ts`） |
| 入力 | キーボード・マウス・タッチ（仮想スティック・ボタン）・Gamepad API・`navigator.vibrate` | タッチ・キーは 3 つとも動いた。Gamepad / vibrate は API があることだけ確認（実機のパッド・振動は未確認） |
| その他 | `navigator.storage.persist`、`navigator.clipboard`、`location.reload()`、`?nosave` などの URL の引数、`visibilitychange` / `pagehide` | Android は裏へ回すと `visibilitychange: hidden` が出る（確認済み）。Windows は窓を閉じると `beforeunload → visibilitychange → pagehide` が出て、控えから復元された（確認済み） |
| 外部への通信 | 無し（すべて同じ起点の資源） | 起動から読み込んだ資源の起点は `http://tauri.localhost` だけ（Windows・Android とも）。ネット無しで動く |

## 2. 作ったもの（試作の構成）

- `src-tauri/`：Tauri 2.12 のプロジェクト。起動ページ `aquarium.html`、識別子 `io.github.kitamiya1.aquariumexplore`（**仮**。公開前に決める）、
  プラグイン dialog / fs（権限は保存・開くダイアログとテキストの読み書きだけ：`capabilities/default.json`）。
  Windows は NSIS / MSI、WebView2 は「ブートストラッパーを同梱」（入っていない PC でも入る）。
- `src-tauri/gen/android/`：Android の Gradle プロジェクト（`tauri android init`）。minSdk 24・targetSdk 37。
- `src-tauri/gen/apple/`：Xcode プロジェクト（CI の macOS で `tauri ios init` して取り込んだ。Team は空）。
- `.github/workflows/app-ios.yml`：macOS で Xcode プロジェクトを作り、シミュレーター用にビルド → 起動 → 画面を撮る（署名なし）。
- ゲームのコードの変更（3 か所）：
  1. `src/aquarium/AquaPlatform.ts`（新規）：アプリ版かどうかの判定と、ファイルの保存・開く（アプリ版は OS のダイアログ。Tauri の JS はアプリ版のときだけ動的に読み込む）。
  2. `AquaSaveUi.ts`：書き出し・読み込みを AquaPlatform 経由に。保存先の表示「ブラウザ / アプリ内」。
  3. `AquaSave.ts`：IndexedDB を開く打ち切り（4 秒）を主スレッドが空いていた時間で数える（5.1 節）。
- ブラウザ版はそのまま：`npm run build`（`dist/`、2 ページ）と GitHub Pages の流れは変えていない。

ビルドの手順：`npm run app:win`（= `tauri build`）、`npm run app:android`（= `tauri android build --apk`）、`npm run app:ios`（macOS だけ）。

## 3. 生成できたアプリのファイル

リポジトリには入れていない（大きい・署名の扱い）。開発機の `app-builds-poc/`（.gitignore 済み）にある。iOS は Actions の Artifacts。

| ファイル | 大きさ | SHA-256（先頭） | 区分 |
| --- | ---: | --- | --- |
| `AquariumExplore_0.1.0_x64-setup.exe`（NSIS） | 3.1 MB | `82B4939ACC3DB32D` | インストール・動作確認済み |
| `AquariumExplore_0.1.0_x64_en-US.msi` | 3.8 MB | `21BE3AF281585091` | ビルドのみ |
| `AquariumExplore_0.1.0_universal-release-unsigned.apk`（arm64-v8a / armeabi-v7a / x86 / x86_64） | 19.8 MB | `5A9DD1852F54842A` | ビルド成功 |
| `AquariumExplore_0.1.0_universal-release-TESTSIGNED.apk`（上を試験用の自己署名の鍵で署名） | 19.9 MB | `03AC09037ACC448A` | エミュレーターで起動・操作確認。**配布には使わない** |
| `AquariumExplore_0.1.0_x86_64-debug.apk`（DevTools を使う試験用） | 137.9 MB | `8AEEE0A79B3896E6` | エミュレーターで全項目 |
| iOS シミュレーター用 `Aquarium Explore.app`（7.7 MB、zip 2.3 MB） | — | — | [Actions run 45957746240](https://github.com/kitamiya1/ParticlePixelPlayground/actions/runs/45957746240) の Artifacts `ios-poc-3` |

ビルドの時間（開発機・初回）：Windows 4 分 43 秒（2 回目以降 3 分）、Android release 4 ABI 17 分 52 秒（2 回目 6 分）、debug x86_64 4 分 31 秒、iOS（CI）約 11 分。
ログ：`docs/app-packaging/logs/`。

## 4. 動作検証

### 4.1 方法

- **アプリの中で検証する**：Windows は WebView2 の DevTools（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port`）、
  Android は debug ビルドの WebView の DevTools（`adb forward … webview_devtools_remote_<pid>`）へ CDP でつなぎ（`tools/cdp.mjs`。Node の組み込みだけ）、
  `tools/smoke.mjs` が既存の試験道具（`docs/aquarium/tools` の `climb_helpers.js`・`sand_fill_test.js`・`ceiling_test.js`・`ledge_test.js`・
  `plant_part_test.js`・`catch_test.js` など）をそのまま読み込んで動かす。
- **本物の入力**：Windows は CDP のキー / マウスのイベント（W で歩く・F で掘る）、Android は CDP のタッチのイベント（仮想スティック・掘るボタン）、
  release APK は `adb shell input`（OS のタッチ）。
- **OS のダイアログ**：Windows は UI Automation + キー入力（`tools/win-file-dialog.ps1`）、Android は uiautomator（`tools/android-ui.ps1`）で操作。
- **比較の基準**：同じ試験を Edge（ブラウザ、`dist-app` を `vite preview`）でも実行（`results/browser-edge/`）。

### 4.2 結果

凡例：✅ 確認 / ⚠ 一部・条件付き / ― 未確認。「エミュ」= Android エミュレーター、「シミュ」= iOS シミュレーター（CI）。

| 項目 | Windows（実機・インストール版） | Android（エミュ・debug APK） | Android（エミュ・release APK） | iOS（シミュ・CI） | ブラウザ（Edge） |
| --- | --- | --- | --- | --- | --- |
| 起動 | ✅ | ✅ | ✅ | ⚠ 2 回目は描画、初回は 40 秒で白画面（5.3） | ✅ |
| WebGL2 の描画 | ✅ ANGLE / D3D11、色 395・明るさのばらつき 42.6 | ✅ エミュの GL 変換（`adb screencap` で確認） | ✅ 画面写真 | ✅（2 回目の起動の画面写真） | ✅ |
| カニの操作（本物の入力） | ✅ キー W で 1.71 歩く・F で 3 個掘る | ✅ タッチで 2.24 歩く・3 個掘る | ✅ OS のタッチで歩く・掘る（砂 0→25、穴が見える） | ― | ✅ |
| 掘る | ✅ 12.5 の砂・穴の体積 −12.5 | ✅ 同じ | ✅（上） | ― | ✅ |
| 盛り土 | ✅ 砂山 41 個・砂 4.6 使用 | ✅ 54 個・4.4 | ― | ― | ✅ |
| 壁 | ✅ 岩の垂直面に張り付き（grabs 2） | ✅（grabs 1） | ― | ― | ✅（grabs 1） |
| 天井 | ✅ 1.6 秒で洞窟の天井へ・前後左右に移動・跳んで離れる | ✅ | ― | ― | ✅ |
| 崖 | ✅ 高い崖（9.83 → 6.87）を接地主導で降りる・落下 0 | ✅（9.83 → 6.74） | ― | ― | ✅ |
| 水草 | ✅ 森で 23 本をかき分け・葉を挟んで張力 6.87 | ✅ 同じ | ― | ― | ✅ |
| 生き物 | ✅ エビを 2 回中 2 回挟む | ✅ 同じ | ― | ― | ✅ |
| 音 | ✅ クリック後 `running`・3 音・0.42 秒進む | ✅ タップ後 `running`・3 音 | ― | ― | ✅ |
| 保存 → 再起動 → 復元 | ✅（修正後）穴 67・砂山 41・砂・位置が一致、`loaded: ok` | ✅ force-stop → 起動で穴 80・砂山 54・位置が一致 | ― | ― | ― |
| 閉じる・裏へ回したときの控え | ✅ 窓を閉じる → 次の起動で控えから復元（`fromJournal: true`） | ✅ ホームで `visibilitychange: hidden`・戻ると `visible` | ― | ― | ― |
| ファイルへ書き出す | ✅ OS の「名前を付けて保存」→ 935 B の JSON | ✅ システムのファイル選択（Downloads）→ 7.5 KB | ― | ― | （既存の動作） |
| ファイルから読み込む | ✅ 「開く」→ 穴 8 → 4・位置が書き出した時へ | ✅ 位置が書き出した時へ・`loaded: ok` | ― | ― | （既存の動作） |
| ネット無し | ⚠ 資源は `http://tauri.localhost` だけ（exe に同梱）。回線を切っての起動は未実施 | ✅ 機内モード（ping 不通）で冷えた起動 → 復元・描画 | ― | ― | ― |
| FPS | 75（画面の更新に一致。平均 13.3 ms・95% 13.4 ms） | 60（16.7 ms） | gfxinfo：50% 16 ms・90% 23 ms・99% 44 ms | ― | 68 |
| メモリ | JS 66 MB。プロセス合計 作業セット 581 MB・プライベート 448 MB（WebView2 の 8 プロセス） | JS 58 MB・PSS 157 MB（debug） | PSS 96 MB | ― | JS 47 MB |
| 起動の時間 | 起動 → ゲーム開始 10.4 秒（初回。WebView2 の準備込み）・2 回目 6.2 秒。生成 4.8 秒 | 12.7 秒（初回）・10.9 秒。生成 8.7 秒 | 画面が出るまで 0.8 秒 | 初回は 20 秒で読み込み中 | 9.1 秒（新しいプロファイル） |
| ページの例外 | 0 | 0 | logcat の重大なエラー 0 | GPU 処理が「応答なし」で再起動（5.3） | 0 |

注意：
- 性能の数字は、別の Rust のビルドが走っている間に測ったものがある（CPU を取り合っている）。エミュレーターは x86_64 で GPU は PC の GPU の変換なので、スマホの性能の目安にはならない。
- Android の CDP の画面写真は WebGL の層が写らず黒い（`results/android-emulator/0*.png`）。実際の画面は `adb screencap`（`adb-screencap-debug.png`）で確認した。描画の判定は canvas の画素で行っている。
- 結果の生データ：`docs/app-packaging/results/`（`first.json`・`restore.json`・画面写真）。

## 5. 見つかった問題

### 5.1 初回起動で保存先が localStorage へ落ち、次の起動で進捗が消えたように見える（**ゲームの既存の不具合。修正済み**）

- 症状：アプリの初回起動で保存先が `localStorage` になり、進捗（穴 60 個）を保存 → 再起動すると IndexedDB が開け、空の IndexedDB を読んで初期状態から始まった。
- 原因：`IdbBackend.open` の打ち切り `setTimeout(…, 4000)` と、並行して走る世界の生成（同期で 4.5〜5 秒）。生成が主スレッドを止めている間に
  打ち切りの時刻が過ぎ、開けた知らせより先に打ち切りが動く。IndexedDB 自体は 18 ms で開ける。
- ブラウザでも起きる：Edge の新しいプロファイルで同じく `localStorage` へ落ちた（`results/browser-edge/first.json`、生成 4.7 秒）。生成が遅い端末ほど起きやすい。
- 修正：打ち切りまでの時間を「主スレッドが空いていた時間」で数える（1 回の刻みで数えるのは最大 0.5 秒）。修正後は Edge の新しいプロファイル・アプリ版の初回とも `indexeddb`、
  再起動で復元された。
- 残ること：本当に 4 秒以上開けなかった起動のあと、次の起動で IndexedDB が開けると、localStorage に保存した分は読まれない（保存先を起動ごとに選び直し、互いを見ない）。
  移す処理（IndexedDB が空で localStorage に current があれば取り込む）を足すかは別に決める。

### 5.2 セーブの書き出し・読み込みが WebView では動かない（アプリ側の小さな修正で解決）

Android・iOS の WebView は `<a download>` の Blob の URL を保存しない。アプリ版だけ OS のダイアログ + fs に替えた（AquaPlatform）。Windows・Android で書き出し・読み込みを確認済み。
iOS の保存ダイアログ（ファイル App）での書き出し・読み込みは未確認。

### 5.3 iOS シミュレーターの初回起動で WebKit の GPU 処理が落ち、白画面になった（原因の候補あり・未解決）

- ログ：起動から約 24 秒で `GPUProcessProxy::didBecomeUnresponsive … terminating it`・`gpuProcessExited: reason=Unresponsive`。その後の画面は真っ白（`sim-40s.png`）。
  終了させてもう一度起動すると 15 秒で描画された（`sim-relaunch-15s.png`）。
- 見立て：CI の macOS は仮想マシンで GPU が遅く、初回のシェーダーの準備などで GPU 処理が応答しない時間が長くなり、WebKit の見張りに止められた。
  実機の iPhone で起きるかは分からない（ブラウザ版は iPhone の Safari で動いている：`docs/aquarium/feel-iphone` など）。
- どちらにしても、ゲームは **WebGL のコンテキストが失われたとき（`webglcontextlost`）の処理が無い**。失われると白（黒）画面のまま戻らない。
  アプリでは OS の都合で GPU 処理が止められることがあるので、失われたら作り直す・読み込み直すを足すのが安全（ゲーム側の小さな追加）。

### 5.4 iOS で画面の下に白い帯が出る（未解決・設定か CSS の小さな修正の見込み）

シミュレーターの画面で、ホームのバーの辺りの高さ（約 11%）が白い。WebView の中身が安全領域の下まで伸びていない。
`viewport-fit=cover` は付いているので、WKWebView の内側の余白の自動調整（contentInsetAdjustmentBehavior）か、`100vh` / `100dvh` の扱いの違いが候補。実機で確かめてから直す。

### 5.5 そのほか（小さなこと）

- 実行ファイルの名前が `app.exe` だった → `mainBinaryName: aquarium-explore` にした（上書き更新で入れ替わることを確認）。
- Android の DevTools の画面写真に WebGL が写らない（試験道具の制約。ゲームの問題ではない）。
- Android の `navigator.onLine` は機内モードでも `true` だった（エミュレーター。ゲームは使っていない）。
- CSP は無効（`"csp": null`）のまま。外部への通信が無いので試作では問題ないが、公開前に `default-src 'self'` などを入れる。

## 6. 代替手段の比較（Electron・Capacitor）

Tauri で重大な互換性の問題は出なかったので、乗り換えの試作はしていない。比べた点だけ書く。

| | Tauri 2（今回） | Electron（Windows） | Capacitor（iOS・Android） |
| --- | --- | --- | --- |
| 描画エンジン | OS の WebView（Windows = WebView2 / Chromium、Android = System WebView / Chromium、iOS = WKWebView / WebKit） | Chromium を同梱（どの PC でも同じ） | OS の WebView（Tauri と同じ） |
| 大きさ | インストーラー 3.1 MB | 80〜100 MB 程度 | APK は Tauri と同程度か小さい（Rust が無い） |
| 3 つを 1 つで | ○（同じ `src-tauri`・同じ Web のコード） | Windows だけ | iOS・Android だけ（Windows は別） |
| 今回の問題への効き | 5.3・5.4 は WKWebView 自体の性質なので、Capacitor でも同じく起きる | — | 同上 |

- Tauri の弱いところは Rust のビルドの重さ（Android 4 ABI で約 18 分）と、モバイル対応の歴史の浅さ（今回は大きな問題なし）。
- 乗り換えが必要になったとしても、ゲームの Web のコードはそのまま使える（Electron / Capacitor も中身は同じ HTML・JS）。違うのは今回の AquaPlatform に当たる「ファイルの保存」の入口だけ。
- 判断：**ゲーム本体の作り直しは不要。どの方式でもアプリ側の設定と小さな修正の範囲**。

## 7. プラットフォームごとの判断

### Windows

- 将来アプリ化できると判断する根拠：インストーラー（NSIS）で入れた本物のアプリの中で、全項目（描画・操作・掘る / 盛る・壁 / 天井 / 崖・水草・生き物・音・保存と復元・ファイルの書き出し / 読み込み・閉じたときの控え）が動いた。
  WebView2 は Edge と同じ Chromium で、ブラウザでの結果と同じだった。上書き更新もできた。
- まだ保証できないこと：コード署名（無いと SmartScreen の警告が出る。証明書は有料）、Microsoft Store への出し方、MSI のインストール、WebView2 が入っていない PC・古い Windows 10・
  内蔵 GPU / 弱い GPU での性能、ネットを切った状態での起動（資源は同梱で外へ出ないことは確認）、アンインストール、高 DPI・複数モニター、ゲームパッド。

### Android

- 根拠：4 ABI の release APK がビルドでき、エミュレーター（Android 15）でインストール・起動・OS のタッチで歩く / 掘るができた。debug APK（同じコード）で全項目
  （保存と復元・機内モードでの起動・システムのファイル選択での書き出し / 読み込み・裏へ回したときの知らせ）を確認した。
- まだ保証できないこと：**実機**（GPU は Adreno / Mali など。WebGL の性能・メモリ・発熱）、古い / 低価格の端末、System WebView の版の違い（エミュの WebView は Chrome 124）、
  Google Play への出し方（AAB・署名の鍵の管理・Play の審査・targetSdk の要件）、画面の回転と切り欠き、戻るボタンの動き、OS にアプリを止められたときの控え、振動・ゲームパッド。

### iOS

- 根拠：Tauri で Xcode プロジェクトが生成でき、署名なしでシミュレーター用にビルドでき、WKWebView の中でゲームが描画された（2 回目の起動）。Web のコードは同じ。
- まだ保証できないこと：**実機でのビルド・インストール・動作すべて**（Apple Developer Program の Team・証明書・プロビジョニングが要る）、初回起動の GPU 処理の停止（5.3）、
  画面の下の白い帯（5.4）、音・タッチ・保存と復元・ファイルの書き出し / 読み込み（ファイル App）・裏へ回したとき、App Store の審査（Web をそのまま包んだだけのアプリは
  ガイドライン 4.2「最低限の機能」で断られることがある）、メモリの上限（WKWebView は使いすぎると中身が落ちる）。

## 8. 今後ゲームに機能を足すときの互換性の注意

1. **アプリかどうかの違いは `AquaPlatform.ts` に閉じ込める**。ゲームの中で `__TAURI_INTERNALS__` を見ない。ファイル・共有・振動・外部リンクなど OS に触る機能は、ここに入口を作る。
2. **ダウンロード（`<a download>`・Blob の URL）・`window.open`・別のページへの移動・`alert / confirm / prompt` を新しく使わない**。WebView では動かない / 違う動きになる。
3. **外部のサーバー・CDN から読み込まない**（フォント・モデル・音も同梱）。オフラインと CSP のため。外部の通信が要る機能はアプリ版の権限（capabilities）と CSP を足す。
4. **保存の起点がブラウザ版とアプリ版で別**。保存の形式（`save-format.md`）を変えるときは、ファイルの書き出し・読み込みで行き来できることを保つ。
5. **重い同期の処理と時間の打ち切りを組み合わせない**（5.1 のように壁時計の打ち切りが誤って動く）。起動時の重い生成を分けるときも同じ。
6. **WebGL のコンテキストが失われる前提で作る**（アプリは OS に GPU を止められることがある。5.3）。新しいシェーダー・大きなテクスチャはモバイルの上限（エミュは MAX_TEXTURE_SIZE 4096）を見る。
7. **画面の安全領域**（切り欠き・ホームのバー・Android の edge-to-edge）を `env(safe-area-inset-*)` で扱う。`100vh` に頼らない（5.4）。
8. **音は利用者の操作の中で始める**（今の作りを保つ）。
9. **裏へ回す・閉じるで止められる前提**：大事な変化は `visibilitychange` で控えを書く今の作りを保つ（Android・Windows で動くことを確認）。
10. **試験**：`docs/app-packaging/tools/smoke.mjs` はブラウザ（Edge / Chrome の `--remote-debugging-port`）でもアプリでも同じに動く。機能を足したら、ここへ項目を足すと 3 つで同じ確認ができる。

## 9. 作業で導入・取得したもの（この PC）

- Rust 1.100（rustup、ユーザーのプロファイルだけ）と Android の 4 つのターゲット。
- npm：`@tauri-apps/cli`・`api`・`plugin-dialog`・`plugin-fs`。Rust のクレートと Gradle の依存（キャッシュ）。
- Android：エミュレーターのイメージ（API 35・x86_64）と AVD `ppp_api35`。**ビルドの途中で自動で取得されたもの**：Gradle 9.6.1、Build-Tools 36.0.0、SDK Platform 37。
- Tauri のビルドが自動で取得したもの：NSIS、**WiX 3.14**（MSI 用、GitHub）、**WebView2 のブートストラッパー**（Microsoft）。（依頼の時に挙げた一覧に WiX と WebView2 のブートストラッパー、Gradle・Platform 37 は入っていなかった）
- 試験用に：Windows へ本アプリ（`%LOCALAPPDATA%\Aquarium Explore`、アンインストールは「アプリ」の一覧から）。試験の最初の保存データは
  `%LOCALAPPDATA%\io.github.kitamiya1.aquariumexplore.poc-run1-*` へ名前を変えて残した（消してよい）。Android の試験用の署名の鍵は作業用の一時フォルダー（リポジトリの外）。

## 10. ドキュメントとコードの食い違い

1. `docs/aquarium/save-format.md` の保存先の表は「localStorage は IndexedDB が開けないとき（古いブラウザのプライベートモード等）」としていたが、コードは 4 秒で打ち切っても
   localStorage へ落ち、ふつうの Edge・アプリ版の初回起動で実際に落ちていた（5.1）。表を直し、保存先が起動ごとに選び直されることを書き足した。
2. `AquaSave.ts` 冒頭の説明（「IndexedDB が使えない環境（古いブラウザのプライベートモード等）は localStorage」）も同じ食い違い（コードの修正で実態に近づいた。説明の文は変えていない）。
3. `aquarium.html` の `<meta viewport>` は `viewport-fit=cover` だが、iOS のアプリでは下の安全領域まで中身が届いていない（5.4。ブラウザ版の Safari では未確認）。
