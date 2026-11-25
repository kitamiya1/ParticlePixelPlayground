# 外部の生き物モデル（エビ・イカ）の利用可否の調査

調査日：2026-11-25。対象：「なちゃっと水族館」（GitHub Pages `cda-social.github.io`）が配っている「イカ・エビのモデル」キット。
結論：**CC0 1.0 なので、権利の面では本ゲームでそのまま使える**（改変・再配布・商用利用が自由で、クレジット表記もいらない）。
ただし glb や FBX ではなく three.js のコードで形を作り、毎フレーム動かす作りなので、本ゲームの描画（方式 F v2 の独自シェーダー・
減色・輪郭）と寸法（実寸の m 単位）に合わせる作業が要る。まずはレッドビーシュリンプ 1 匹を「比較用の別モード」で試すのがよい（7 章）。

## 1. 調べた場所

| 場所 | 内容 | 確認方法 |
|---|---|---|
| https://cda-social.github.io/aquarium/models-gallery.html#other | イカ・エビのギャラリー（アオリイカ・コウイカ・レッドビーシュリンプ・テナガエビ）。一覧・三角形の数・動き・ライセンスの文は JavaScript で描かれる | ブラウザ（Playwright）で開いて、描かれた文と読み込んだファイルを記録 |
| https://cda-social.github.io/fish/gallery | 魚とイカの旧ギャラリー。「水族館のギャラリーへ移った」との案内と、イカのキット（`fish/kit/squid/`）へのリンク | 取得して読んだ |
| https://cda-social.github.io/aquarium/kit/other/README.md | イカ・エビのキットの README（約 13 KB。下の内容の大半はここから） | 全文を読んだ |
| https://cda-social.github.io/aquarium/kit/other/LICENSE.txt | キットのライセンス | 全文を読んだ |
| https://cda-social.github.io/aquarium/kit/other/shrimp-kit.js | エビの実装（ES module、約 150 KB・5,429 行） | 取得して、import / export・最上位の名前・使っている three.js の部品を数えた（全行は読んでいない） |
| https://cda-social.github.io/fish/kit/squid/README.md、`squid-kit.js`、`LICENSE.txt` | イカのキット（旧ギャラリー側の同じ物） | README と LICENSE は全文、`squid-kit.js` は先頭の約 4 万字 |
| https://cda-social.github.io/aquarium/kit/other-kit.zip（2.7 MB） | まとめてダウンロードする zip | **取得していない**（中身と同じファイルが `kit/other/` で公開されていたので、そちらを読んだ） |
| https://github.com/cda-social | 公開リポジトリは無関係のフォーク 2 つだけ。`cda-social/aquarium` は 404 | 取得 |

作者：GitHub の `cda-social`（表示名 Necoyan）。サイトは VR ゲーム「ガチ釣りシミュレーターVR」の関連ページ。連絡先は見つからなかった。

## 2. 配布ファイルと取得方法

- 取得方法：ギャラリーの「イカ・エビをまとめてダウンロード」→ `https://cda-social.github.io/aquarium/kit/other-kit.zip`（2.7 MB）。
  同じ中身が `https://cda-social.github.io/aquarium/kit/other/` の下に展開された形でも公開されている（README・LICENSE・js を直接読める）。
  git のリポジトリは公開されていない（版の管理・更新の追跡は zip を取り直すしかない）。
- 中身（README の表より）：

| ファイル | 内容 |
|---|---|
| `example.html`, `example.js` | 全種類・全動きの見本ページ（http で開く。three.js は cdn.jsdelivr.net から読む） |
| `squid-kit.js` | イカを作って動かす（ES module、three.js r187） |
| `squid/` | イカの形（`aori.json`・`kouika.json`。写真から測った輪郭）と写真（`_dorsal / _ventral / _side.webp`） |
| `egi/` | イカの動きで使う餌木（エギ） |
| `shrimp-kit.js` | エビを作って動かす（ES module、three.js r187）。**形の寸法はコードの中** |
| `shrimp/` | レッドビーシュリンプの体の写真 2 枚（`body_side.webp`・`body_top.webp`）。全長 26 mm |
| `tenaga/` | テナガエビの体の写真 2 枚（`body_oblique.webp`・`body_top.webp`）。全長 70 mm |

## 3. 利用許諾（ライセンス）

`LICENSE.txt`（キットの中の文。要約）：キットのモデル・写真・プログラム・スクリプトは CC0 1.0 Universal でパブリックドメインに
提供される。商用を含め、許可もクレジット表記もなく、複製・改変・再配布・利用できる。
（原文の 1 文：「without permission and without credit」）

同じ内容が 3 か所で一致している：ギャラリーの文（「モデル・テクスチャ・動きのプログラム、すべて改変・再配布・商用利用が自由です。
許可もクレジット表記もいりません」）、README、`shrimp-kit.js`・`squid-kit.js` の先頭のコメント（`Shrimp Kit (CC0 1.0)`）。

| 項目 | 結果 |
|---|---|
| モデル（形のデータ・形を作るコード） | CC0 |
| テクスチャ（体の写真 webp） | CC0（LICENSE の「photos」） |
| 動き（コード。アニメーションのクリップは無い） | CC0 |
| コード（`*-kit.js`・`example.*`） | CC0 |
| 商用利用 | 可 |
| 改変 | 可 |
| 再配布 | 可（本リポジトリに入れて GitHub Pages で配ってよい） |
| クレジット表記 | 不要（入れるのは自由。入れる場合は「なちゃっと水族館（cda-social.github.io）の CC0 キットを改変」程度） |
| 個人利用だけ・AI の学習禁止などの条件 | 見当たらない（README・LICENSE・ギャラリー・コードの先頭） |
| 注意 | three.js は CC0 ではない（MIT、© three.js authors）。キットには入っておらず、使う側の three.js を import する。本プロジェクトは既に three.js（MIT）を使っているので新しい義務は増えない |
| その他 | ギャラリーに「生物学的な正しさは保証しない（その生き物『風』のモデル）」とある。CC0 なので保証・責任は無い |

## 4. glb・FBX が無い理由と、実際のデータの作り

README の冒頭に「glb / FBX のモデルは無い。AI エージェントもモデルファイルやアニメーションのクリップを探さないこと」と明記されている。

- **エビ（`shrimp-kit.js`）**：体の輪郭（横から・上からの高さと幅の表 `SIDE` / `TOP`）を寸法としてコードに持ち、読み込むときに
  殻（頭胸甲・腹節 6 つ・尾扇）を 1 つのスキンメッシュとして作る（`shellGeometry`。ボーンは頭胸甲 `B`・腹節 `somites`・尾 `telson`）。
  脚・はさみ・触角・目・腹肢は輪・帯を積んで作る補助関数（`loft`・`article`・`ribbon`・`leaf`・`FlexTube`）で 1 本ずつ作る。
  毎フレーム `update()` が行動（`setMode`）を選び、体を床の上で動かし、腹を曲げ、**脚を 1 本ずつ逆運動学（IK）で踏み出し**、
  触角と腹肢を揺らす。殻の色は写真 2 枚を静止姿勢から投影し（`bakeRest`・`shellMaterial`。面の向きで 2 枚を混ぜるシェーダー）、
  脚や触角は頂点色で縞と透けを塗る（`paintApps`）。細かい部品は `mergeShrimp` で少ない描画呼び出しにまとめ、毎フレーム同期する。
  レッドビーシュリンプ（`Shrimp`、名前に `$1` が付く方）とテナガエビ（`Prawn`）は同じ作りの別の関数。
- **イカ（`squid-kit.js`）**：`squid/<名前>.json`（写真から測った輪郭）と写真 3 枚から、外套・頭・ひれ・腕・触腕の格子メッシュを作り、
  **毎フレーム全頂点の位置と法線を CPU で書き直す**（`Squid.update` の `buildMantle` / `buildFins` / `buildArms` / `buildTentacles`）。
  色変わり（体色の点・白化・雲状の模様・ちらつき・虹色の線）は `MeshStandardMaterial` に `onBeforeCompile` で差し込むシェーダー
  （`SKIN_FRAG`。uniform `uDark`・`uPale`・`uCloud`・`uFlicker` など）。動きは動きごとの小さな状態機械（`SquidBrain`）。
  墨・水しぶき（`SquidFx`）、餌木（`EgiModel`）付き。

## 5. three.js 用コードの構成・依存・本プロジェクト（three r187）との互換性

| 項目 | エビ | イカ |
|---|---|---|
| 形式 | ES module。`import * as THREE from "three"` だけ | ES module。`three` と `three/addons/utils/BufferGeometryUtils.js`（`mergeGeometries`） |
| 想定の three.js | r187（README の import map が `three@0.187.0`） | r187 |
| 書き出し | `createShrimp`, `ShrimpActor`, `SHRIMP_LIST`, `SHRIMP_MOTIONS` | `loadSquids`, `createSquid`, `SQUID_LIST`, `SQUID_MOTIONS` |
| 使う部品 | `SkinnedMesh`・`Bone`、`MeshStandardMaterial` / `MeshPhysicalMaterial`、`onBeforeCompile`、`CanvasTexture`、影 | `MeshStandardMaterial` + `onBeforeCompile`、CanvasTexture |
| 単位・向き | 実寸の m（中は mm を 0.001 倍）。頭が +X（`heading` = 0）。床は `floorY`、凹凸は `groundAt(x, z)` | 実寸の m。`home` のまわりを泳ぐ。腕が +Z |
| 読み込み | 写真 2 枚（`createShrimp(id, { folder })` が Promise を返す） | JSON 2 つ + 写真 6 枚 + 餌木 |

本プロジェクトは `three@^0.187.0`（`package.json`）で、版は一致する。Vite の ES module として `import` でき、`three/addons/...` も解決できる。
TypeScript の型は無い（js のまま読み込むか、`// @ts-nocheck` の .js として置き、使う所だけ型を書く）。
注意：コードは「注釈の無い、読める JavaScript」（README）なので、本プロジェクトの命名・注釈の流儀（日本語の注釈）とは揃わない。
手を入れるなら、別のフォルダ（例：`src/aquarium/vendor/cda-shrimp/`）に元のまま置き、出所と CC0 を書いた README を添える。

## 6. 本ゲームの作りとの違い（カニ・エビ・スナモグリ）

| | 本ゲームのカニ | 本ゲームのエビ（10 匹） | 本ゲームのスナモグリ | 外部キットのエビ |
|---|---|---|---|---|
| 形の作り方 | 距離関数（SDF）を Surface Nets で三角形にする（`buildCrabMesh`）。起動時に 1 回 | 同じ（`buildShrimpMesh`：カプセル 6 つ + 尾扇 + 額角 + 脚 6 本を滑らかにつなぐ） | 同じ（`buildBuddyMesh`） | 寸法の表からコードで殻・脚・触角を 1 つずつ作る |
| 三角形の数 | 28,292 | 2,320（× 10 匹を InstancedMesh で 1 回の描画） | 5,952 | レッドビー 20,984（軽い形 11,960）、テナガエビ 23,008（軽い形 17,264）、イカ 11,012（ギャラリーの表示） |
| 色 | 頂点色（減色前のパレットに合う色） | 頂点色（節の縞） | 頂点色 | 写真の投影 + 頂点色 + PBR のマテリアル |
| 動き | ボーン（剛体の部品）を CrabRig が IK で動かす（GPU で変形） | 頂点シェーダーで尾を打つ・脚を揺らす（`aMisc.y` の重み）。体は 1 つの剛体 | 同じ + 触角の揺れ（`aMisc.x`） | スキンメッシュ + 脚を 1 本ずつ IK。毎フレーム部品の同期（CPU） |
| 光・水中の色 | `LIGHTING_CHUNK`（方式 A〜F と共通の段階の光）+ 水中の霞・揺らぎ（`WATER_CHUNK`） | 同じ | 同じ | three.js の標準の PBR（ライト・環境マップが要る）。本ゲームの段階の光・水中の霞は掛からない |
| 後処理 | 低解像度に描き、輪郭・ディザ・減色・拡大を 1 回（PixelPipeline） | 同じ | 同じ | 同じ低解像度ターゲットに描けば、後処理（輪郭・減色・ディザ）は自動で掛かる |
| 大きさ | 水槽の単位（カニの半径 0.24）。本ゲームのエビは全長約 0.46 | | | 実寸の m（26 mm）。本ゲームに合わせるには約 18 倍 |
| 行動（AI） | プレイヤー | `AquaLife.updateShrimp`（待機・歩く・カニから逃げて跳ぶ `dart`、住みかの範囲） | `AquaBuddy`（巣穴・引っこ抜き・同行・自由生活） | `setMotion`：`auto`・`graze`（食べる）・`walk`・`swim`・`flip`（跳ねて後ろへ） |

## 7. 既存のドット絵風描画へ入れる方法（案）と難易度

難易度の目安：**試験表示（1 匹）は中、本採用（10 匹・水中の色まで揃える）は中〜高**。

1. **そのまま入れる（最小・比較用）**：`createShrimp('redbee')` の `object` を、カニと同じ低解像度ターゲットに描く 1 つの three.js の
   オブジェクトとして足す。大きさは 18 倍程度（`object.scale` は使わず親の Group で拡大するか、`createShrimp` の世界座標（m）を
   水槽の単位で割った場所に置く。README は「object を拡大しない」とあるので、親の Group を介すか、コードの 0.001 を書き換える）。
   後処理（輪郭・ディザ・減色）は自動で掛かる。足りない物：ライト（PBR 用の平行光・環境光をこの物だけに）、水中の霞（本ゲームの
   `WATER_CHUNK` が掛からないので、周りより鮮やかに浮く）、影の受け方。見た目が合うかを比べるにはこれで十分。
2. **マテリアルだけ差し替える（推奨の本採用）**：形と IK の動きはキットのまま使い、殻・脚のマテリアルを本ゲームの部品
   （`LIGHTING_CHUNK` + `WATER_CHUNK` の ShaderMaterial、スキン対応）に差し替える。写真の投影は 1 回だけ頂点色へ焼き付ける
   （README の移植案「bake the projection into UVs once」と同じ考え）。これで段階の光・水中の色・パレットが周りと揃う。
3. **形だけ借りて焼く**：キットの静止姿勢の形（殻 + 脚）を頂点色付きの三角形として書き出し、本ゲームの `buildShrimpMesh` と同じ
   InstancedMesh + 頂点シェーダーの揺れで動かす。一番軽いが、キットの良さ（脚 1 本ずつの IK）を捨てる。

**推奨**：まず 1 で 1 匹を別の比較モード（例：`aquarium.html?nosave&kitshrimp`）に出して、既存のエビと並べて見た目・動き・性能を比べる。
採用するなら 2 へ進める。

### 試験表示（レッドビーシュリンプ 1 匹）の実装方針

- 置き場所：`src/aquarium/vendor/cda-shrimp/`（`shrimp-kit.js` と `shrimp/` の写真 2 枚、出所・CC0・取得日を書いた README）。
  写真は Vite の `public/` 側に置くか、`createShrimp(id, { folder: (name) => new URL(...) })` の関数で URL を渡す。
- 表示：URL に `kitshrimp` があるときだけ動的 import（`await import('./vendor/cda-shrimp/shrimp-kit.js')`。初期の読み込みは増やさない。
  Spark と同じ考え）。既存のエビの住みかの 1 つの隣に置き、`groundAt(x, z)` に `world.contactSurfaceBelow` を渡して底床の凹凸に合わせる。
- 大きさ：本ゲームのエビ（全長約 0.46）と同じに見えるよう、親の Group で約 18 倍。`range` も同じ倍率で割る。
- 比較：同じカメラ位置で、既存のエビと並べた静止画・動き（`walk`・`graze`・`flip`）の連続画像、FPS・描画呼び出し数・三角形の数・
  `update` にかかる時間（performance.now で計る）を、iPhone の縦の大きさ（390×844・処理を 4 倍遅くした模擬）で記録する。
- 判定の目安：iPhone で FPS が 5% 以上落ちない、水中の色の中で浮いて見えない、ドット化したときに脚・触角が潰れない（26 mm の脚は
  画素 2〜3 倍の低解像度では 1 画素未満になりやすい。拡大すれば残る）。

## 8. iPhone でのポリゴン数・描画負荷・メモリ（見積もり）

| 項目 | 見積もり | 根拠 |
|---|---|---|
| 三角形 | 1 匹 21k（軽い形 12k）。いまの場面は約 550k 三角形 + 169k 円盤 | ギャラリーの表示、`__aqua.view.stats` |
| 描画呼び出し | 部品をまとめても数回 / 匹（`mergeShrimp`）。影を落とすなら影の分も | コード（`castShadow` 18 か所） |
| CPU | 毎フレーム：脚 10 本前後の IK・部品の行列の同期・スキニング。1 匹なら小さいが、10 匹（いまの数）では iPhone で数 ms 単位になりうる | 構造からの見積もり（実機では未計測） |
| メモリ | 写真 2 枚（webp 約 5〜55 KB をテクスチャにすると数 MB 以下）+ 頂点・ボーン。1 匹で数 MB 以下 | ファイルの大きさ（HEAD） |
| 読み込み | `shrimp-kit.js` 約 150 KB（gzip で 1/4 程度） | 取得した大きさ |

ギャラリー自体は手元の PC の Chromium で 70 FPS 前後（1 匹を全画面で表示）。iPhone の実測は試験表示で行う。
本ゲームのエビ 10 匹を全部置き換えるなら、軽い形（12k × 10 = 12 万三角形）と、遠い個体の更新を間引く工夫が要る。

## 9. 既存のエビの AI との連携

- いまのエビ（`AquaLife.updateShrimp`）は、位置・向き・状態（`idle` / `walk` / `dart`）・住みか（`home` と `range`）を持ち、
  カニが近いと `dart` で逃げる。描画は位置と向きを行列にするだけ。
- キットのエビは自分で行動を選び、自分で動く（`auto`）。連携は 2 通り：
  1. **本ゲームの AI が主**：毎フレーム、キットの `body` の位置・`heading` を本ゲームの値に合わせ、状態で `setMotion` を切り替える
     （`walk` ↔ `walk`、`idle` ↔ `graze`、`dart` ↔ `flip`）。脚の IK はキットのまま。体の移動をキットが自分でしないよう、
     `update` の移動の部分を止める改変が要る（コードを読んで確かめる）。
  2. **キットの AI が主**：住みかの範囲（`home`・`range`）と床（`groundAt`）だけ渡し、カニが近いときだけ `setMotion('flip')` を
     呼ぶ。改変は少ないが、ガラス・岩・掘った穴との当たり判定は無い（`groundAt` は高さだけ）。
  試験表示は 2、本採用は 1 を勧める（掘った穴・ガラスの扱いを本ゲームの判定に揃えるため）。

## 10. 個体ごとの色・模様

- エビ：色の多くは写真の投影なので、写真を差し替える・投影の後に色を掛ける（シェーダーの uniform を足す）・脚の頂点色の表
  （`RED`・`WHITE`・`GLASS`・`LEGRED`・`CREAM` などの定数）を個体ごとに変えれば変えられる。キットの API には個体ごとの色の引数は無い。
  レッドビーシュリンプの赤白の帯の幅・位置を個体で変えるには、写真の投影をやめて帯を手続きで塗る改変が要る。
- イカ：`SQUIDS` の色の値（`base`・`belly_`・`spot`・`shine`・`pattern`）と skin の uniform（`uDark`・`uPale`・`uCloud` など）で変えられる。
  `createSquid` は呼ぶたびに新しい個体を作るので、個体ごとに値を変えやすい。
- 本ゲームの描画に入れると最後に減色（パレット `aquarium55`）が掛かるので、細かい色の差はパレットの色に丸められる。

## 11. 分からなかったこと・確かめていないこと

- zip（`other-kit.zip`）の中身は取得していない（展開済みの公開ファイルで代わりに確認。zip と同じかは未確認）。
- `shrimp-kit.js` の全行は読んでいない（構成・部品の数・関数名を調べた）。本ゲームの AI が主の連携（9 章の 1）でキット側の移動を
  止められるかは、試験表示のときにコードを読んで確かめる。
- iPhone での実測（FPS・メモリ・`update` の時間）はしていない。
- 公開ファイルの一部（`kit/other/shrimp/body_top.webp` など）に HEAD で 404 / 503 が返った。ギャラリーが実際に読むのは
  `aquarium/shrimp/` と `aquarium/tenaga/` の写真で、こちらは読めた。取り込むときは zip から取るのが確実。
- キットに版番号・更新履歴は無い。取り込んだ日と取得元の URL を記録しておく。
