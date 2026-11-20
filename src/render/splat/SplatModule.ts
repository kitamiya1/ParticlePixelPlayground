// 方式 B（Gaussian Splats）の入口。Spark に依存するコードだけをまとめ、SceneRenderer から動的 import で読み込む。
// 方式 A・C だけを使う間はこのモジュール（と Spark）は読み込まれない。
// ※ このファイル以外から Spark 関連のモジュールを値として import しないこと（初期バンドルに混ざるため）。
// 形状データ（点群・SDF 生成）は Spark に依存しないので、A・B・C 共通の shared/PointSet.ts と visual/sdf にある。

export { SplatRenderer } from './SplatRenderer';
