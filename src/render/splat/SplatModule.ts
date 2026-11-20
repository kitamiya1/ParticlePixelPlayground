// 方式 B（Gaussian Splats）の入口。Spark と、それにだけ必要なコード（スプラット変換・SDF 生成）をまとめ、
// SceneRenderer から動的 import で読み込む。方式 A だけを使う間はこのモジュール（と Spark）は読み込まれない。
// ※ このファイル以外から Spark 関連のモジュールを値として import しないこと（初期バンドルに混ざるため）。

export { SplatRenderer } from './SplatRenderer';
export { mergeAndShuffle, pointSetFromBuilder, pointSetFromGeometry } from './SplatData';
export { buildSdfCharacter, buildSdfObjects, characterSourceFromGeometry } from '../../visual/sdf/sdfObjects';
