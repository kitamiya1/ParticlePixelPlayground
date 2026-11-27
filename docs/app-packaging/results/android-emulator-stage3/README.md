# Android エミュレーター：第 3 段の変更の影響（2026-11-27）

- AVD `ppp_api35`（Android 15・x86_64・`-gpu host`）、WebView Chrome 124、debug APK（x86_64）を上書きインストール
- 以前の試験の WebView のデータを退避して空から（試験の後で元に戻した）
- `first.json`：11 項目すべて ok（CDP のタッチ操作）、ページの例外 0、60 FPS、JS 45 MB。bootMs 6882（第 2 段 8764）
- 終了（force-stop）→ 起動：`restore.json` 掘った形 74・盛った所 48・砂 6.5871・位置が保存どおり
- 起動の記録：描画の準備 シェーダー 26 個 650 ms、最初のフレーム 115 ms・2 枚目 38 ms・3 枚目 30 ms（シェーダーは増えない）。
  `layout inner=412x915 safe(t,r,b,l)=52,0,0,0 lowestControl=tb:908 limit=915`
- 描画の喪失と復旧（`gpu-recovery/gpu-recovery.json`、WEBGL_lose_context による模擬）
  - その場で復旧：穴 82・砂 7.446・掘った形 656・位置が同じ
  - 復旧が来ない → 保存して読み込み直す：穴 83・砂 7.42・掘った形 664・位置が同じ
  - 読み込み直した後の画面（`adb-screencap-after-reload-recovery.png`：CDP の画面写真は WebGL を写さないので adb で撮る）
