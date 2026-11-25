# 水槽探検：セーブの方式と保存データの仕様

コード：`src/aquarium/AquaSave.ts`（形式・検証・保存先）、`src/aquarium/AquaSaveUi.ts`（自動保存・メニュー）、
`src/aquarium/main.ts`（集める `gather`・起動時の復元）、`DigField.exportPrims / restore`（`AquariumDig.ts`）、
`AquariumDigFx.flushAllAsync`。

## 1. 保存先

| 優先 | 保存先 | 使う条件 | 中身 |
| ---: | --- | --- | --- |
| 1 | IndexedDB（DB `ppp-aquarium`、ストア `saves`） | ふつうのブラウザ（スマホ含む） | 下の `SaveData` を構造化複製のまま（空洞は `Float64Array`） |
| 2 | localStorage（鍵 `ppp-aquarium:<鍵>`） | IndexedDB が開けない（古いブラウザのプライベートモード等） | 書き出しファイルと同じ JSON 文字列 |
| 3 | メモリ | どちらも使えない | 閉じると消える（メニューに「保存できません」と出す） |

IndexedDB を選んだ理由：掘った空洞は最大 6000 個 × 7 個の数（倍精度で 336 KB）。JSON 化せずに型付き配列のまま入れられ、
書き込みは非同期で画面を止めない（2955 個・166 KB で書き込み 1.6 ms、集める処理 0.8 ms）。localStorage は 5 MB 程度の上限と
同期の書き込み（画面が止まる）があるので予備にだけ使う。

### 鍵

| 鍵 | 意味 |
| --- | --- |
| `current` | いまの進捗 |
| `backup` | 1 つ前の正常なデータ。`current` が正常と分かっているとき（読めた・自分で書いた）だけ、書く前に `current` をここへ写す（1 つのトランザクション） |
| `corrupt-<時刻>` | 読めなかったデータの隔離（最大 3 個。古い順に消す） |

## 2. 読み込みの流れ（起動時）

1. 重い生成（地形・植物）と並行して保存先を開く。
2. `current` を読む。無ければ初期状態（`empty`）。
3. `validateSave` を通れば使う（`ok`）。知らない場所・仲間の id は捨てて警告にする。
4. 通らなければ `current` を `corrupt-*` へ隔離し（`current` 自体は消さない）、`backup` を検証する。通れば `backup` から再開（`recovered`）。
5. どちらも読めなければ初期状態で始める（`corrupt`）。どちらの場合もメニューに理由を出し、短い知らせを出す。
6. 復元：`DigField.restore(prims)`（掘ったときと同じ `add` を通す）→ `AquariumDigFx.flushAllAsync`（全区画を作り直してから
   1 回で差し替え、同じ瞬間に当たり判定へ入れる）→ 訪れた場所 → プレイヤー（保存した位置が固体の中ならスタート地点）→ 仲間。
   これらは最初のフレームより前に済む。掘った区画が多いときは読み込み画面に「掘った穴を復元しています… n / 全体 区画」と出る。

`recovered` / `corrupt` のあとは `current` を正常と見なさないので、最初の自動保存は `backup` を上書きしない。

## 3. 書き込み（自動保存）

| きっかけ | いつ書くか |
| --- | --- |
| 掘った（かき出しの回数が変わった）・初めての場所・仲間の状態 | 最初の変化から 2 秒後、かつ前の保存から 4 秒以上（掘っている間に何度も書かない） |
| 動いただけ（0.5 以上） | 15 秒ごと |
| ページが隠れる・閉じる（`visibilitychange` / `pagehide`） | すぐ |
| メニューの「今すぐ保存」 | すぐ（書いている途中なら、終わってからもう一度） |

## 4. 形式（version 1）

```ts
interface SaveData {
  format: 'ppp-aquarium-save';
  version: 1;
  created: number;            // 最初に作った時刻（ms）
  savedAt: number;            // 最後に保存した時刻（ms）
  playTime: number;           // 遊んだ秒数
  player: { tank: 'home'; x; y; z; heading; camera: 'adventure' | 'observe' | 'diorama' };
  progress: {
    visited: string[];        // 訪れた場所の id（AquariumSpots）
    flags: Record<string, boolean>; // イベントの進み（例：'burrow.examined'）
  };
  tanks: {                    // 水槽ごと（将来の隣の水槽は別の鍵）
    home: { dig: { prims: Float64Array } };  // 空洞 1 個 = [ax, ay, az, bx, by, bz, r]。掘った順
  };
  buddies: {
    id: string; species: string;
    found: boolean;           // 引っこ抜いて仲間になった
    mode: 'free' | 'follow';
    tank: 'home'; x; y; z;
    home: [x, z];             // 自由生活の住みか
    traits: Record<string, number | string>; // 個体の特徴（将来の繁殖・レア）
  }[];
}
```

### 検証（`validateSave`）

- 形：`format` が違う・`version` が新しい / 古い / 範囲外 → 拒否（新しい版は「ページを更新してください」）。
- 数：有限でない値（NaN・Infinity）→ 拒否。
- 範囲：プレイヤーは部屋の中、空洞の両端と仲間は水槽の外接箱 + 1.5 の中、空洞の太さは 0.01〜`DIG.rMax`、
  空洞の数は `DIG.maxPrims` 以下 → 外れたら拒否。
- id：知らない場所・仲間・水槽は捨てて警告。同じ仲間が 2 つ → 拒否。
- 拒否したデータはゲームへ一切渡さない（部分的に読み込まない）。

### 書き出しファイル（JSON）

`SaveData` と同じ形で、空洞だけ `{ "f64": "<base64>" }`（倍精度・リトルエンディアン）にする。読み込むときは同じ検証を通し、
通ったら `current` に書いて（いまの `current` は `backup` へ）ページを読み込み直す（起動時と同じ復元の道を通す）。
検証を通らないファイルでは保存データに触れない。ファイル名は `aquarium-save-YYYYMMDD-HHMM.json`。

### 版を上げるとき

`migrate()` に「前の版 → 新しい版」の変換を足し、`SAVE_VERSION` を上げる。追加予定の場所：

| 追加するもの | 置き場所 |
| --- | --- |
| 盛った砂（M2） | `tanks[id].sand`（盛った形の並び。空洞と同じく区画の作り直しで復元） |
| 植物（M3） | `tanks[id].plants` |
| 生き物の個体・繁殖（M4） | `buddies[].traits`、または `tanks[id].creatures` |
| 隣の水槽（M5） | `tanks` の別の鍵、`player.tank` |

## 5. 初期状態に戻す

メニューの「初期状態に戻す…」→ 説明を読んで「本当に戻す」の 2 段。`current` を `backup` へ写してから消し、読み込み直す。
次の起動は初期状態（`empty`。`backup` からは戻さない）。1 つ前のデータは `backup` に 1 回分だけ残る。

## 6. 確認したこと（2026-11-25、開発サーバー、`docs/aquarium/tools/save_helpers.js`）

| 項目 | 結果 |
| --- | --- |
| 岸辺のトンネル + 左・奥のガラス際の巣穴（空洞 34・区画 49）を保存 → 読み込み直し | 空洞の値・区画ごとの三角形の数と頂点・当たり判定の値・隠した植物/小石・カニの位置・訪れた場所がすべて一致 |
| 大量の掘削（空洞 2955・区画 610、水槽の 85%） | 保存 166 KB・書き込み 1.6 ms。読み込み直しで完全に一致。復元の作り直しは約 5.5 秒（読み込み画面に進み具合） |
| 壊れたデータ（文字列・NaN・版 99・水槽の外の空洞・current と backup の両方） | どれも起動でき、隔離した上で backup から再開 / 初期状態。正常な backup は残る |
| 書き出し → 読み込みの往復 | 空洞の値が一致。壊れたファイル（途中で切れた JSON・版 0・base64 の破損）は拒否、知らない場所は警告だけ |
| 初期状態に戻す（画面のボタン） | 確認のあと読み込み直して初期状態。`backup` に前のデータが残る |
