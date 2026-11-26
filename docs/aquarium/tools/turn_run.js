async (page) => {
  await page.goto('http://localhost:5173/aquarium.html?nosave&' + Date.now());
  await page.waitForFunction(() => window.__aqua && window.__aqua.bootMs > 0, null, { timeout: 180000 });
  const modes = globalThis.__modes ?? ['B', 'C'];
  const r = await page.evaluate(async (modes) => {
    window.__aqua.help?.close?.();
    document.getElementById('help')?.classList.remove('show');
    for (const f of ['climb_helpers.js', 'turn_test.js']) await fetch('/docs/aquarium/tools/' + f + '?' + Date.now()).then((r) => r.text()).then(eval);
    const out = await __tn.all(modes);
    return 'scene|mode|slipMax|slipSum|slipF|steps|fast|swingMs|stretch|overF|yawMax|yawTot|turnT|speed|side|skips|ms|msMax\n' + out.map((o) => [o.scene, o.mode, o.slipMax, o.slipSum, o.slipF, o.steps, o.fast, o.swingMs, o.stretch, o.overF, o.yawMax, o.yawTot, o.turnT, o.speed, JSON.stringify(o.side), o.skips, o.ms, o.msMax, o.error ?? ''].join('|')).join('\n');
  }, modes);
  return r;
}
