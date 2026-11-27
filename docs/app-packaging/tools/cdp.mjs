// 最小の Chrome DevTools Protocol（CDP）クライアント。Node 22 以降の組み込み WebSocket / fetch だけを使う（追加の依存なし）。
// つなぐ先：WebView2（Windows のアプリ版。WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=N で起動）、
// Android の WebView（adb forward tcp:N localabstract:webview_devtools_remote_<pid>）、Edge / Chrome（--remote-debugging-port）。

export async function listTargets(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`);
  return r.json();
}

/** ページ（url に match を含むもの）が出るまで待ってつなぐ */
export async function connect(port, { match = 'aquarium', timeoutMs = 60000 } = {}) {
  const t0 = Date.now();
  let target = null;
  while (!target) {
    try {
      const list = await listTargets(port);
      target = list.find((x) => x.type === 'page' && x.url.includes(match)) ?? null;
    } catch {
      /* まだ開いていない */
    }
    if (!target) {
      if (Date.now() - t0 > timeoutMs) throw new Error(`CDP: page "${match}" not found on port ${port}`);
      await sleep(300);
    }
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl.replace('localhost', '127.0.0.1'));
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = (e) => rej(new Error('CDP websocket error ' + (e.message ?? '')));
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      const { res, rej } = pending.get(d.id);
      pending.delete(d.id);
      if (d.error) rej(new Error(`${d.error.message} ${d.error.data ?? ''}`));
      else res(d.result);
    } else for (const f of listeners) f(d);
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  /** ページの中で式を評価して値を返す（Promise は待つ。利用者の操作の中として扱う） */
  const evaluate = async (expression, { timeout = 600000 } = {}) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true, timeout });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const screenshot = async () => Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
  return { target, send, evaluate, screenshot, on: (f) => listeners.add(f), close: () => ws.close() };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
