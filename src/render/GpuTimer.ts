// GPU の処理時間計測（EXT_disjoint_timer_query_webgl2）。FPS は画面のリフレッシュレートで頭打ちになるため、
// 描画方式の負荷の違いは GPU 時間で比べる。拡張が無い端末（多くのスマホ）では null を返す。

export class GpuTimer {
  private readonly gl: WebGL2RenderingContext;
  private readonly ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  private readonly pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  /** 直近の計測値（ms） */
  last: number | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  }

  get supported() {
    return this.ext !== null;
  }

  begin() {
    if (!this.ext || this.active || this.pending.length > 4) return;
    const q = this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }

  end() {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  /** 結果が出ているクエリを回収する。新しい値が得られたらその値（ms）を返す */
  poll(): number | null {
    if (!this.ext) return null;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    let got: number | null = null;
    while (this.pending.length) {
      const q = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
      this.pending.shift();
      gl.deleteQuery(q);
      if (!disjoint) got = ns / 1e6;
    }
    if (got !== null) this.last = got;
    return got;
  }
}
