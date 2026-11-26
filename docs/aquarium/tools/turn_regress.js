// 第 9 段階：回帰の確認。壁・天井（climb_lead_test：__cl）と、地形への接地（foot_ik_test：__fk）を、旋回 B（step）と C（pivot）で同じ入力で測る
async (page) => {
  await page.goto('http://localhost:5173/aquarium.html?nosave&' + Date.now());
  await page.waitForFunction(() => window.__aqua && window.__aqua.bootMs > 0, null, { timeout: 180000 });
  return await page.evaluate(async () => {
    window.__aqua.help?.close?.();
    document.getElementById('help')?.classList.remove('show');
    for (const f of ['climb_helpers.js', 'ceiling_test.js', 'climb_lead_test.js', 'foot_ik_test.js']) await fetch('/docs/aquarium/tools/' + f + '?' + Date.now()).then((r) => r.text()).then(eval);
    const rig = __aqua.rig, lines = [];
    const fmtCl = (o) => [o.place ?? o.name, 'planted', JSON.stringify(o.planted), 'foot', JSON.stringify(o.foot), 'stretch', o.stretch, 'steps', JSON.stringify(o.steps), 'surf', JSON.stringify(o.surf), 'rot', o.rot, 'body', JSON.stringify(o.body), 'stuck', o.stuck, 'reach', JSON.stringify(o.reach)].join(' ');
    for (const name of __cl.names()) {
      for (const turn of ['step', 'pivot', 'step']) {
        rig.turnStyle = turn;
        try { lines.push(turn + ' CL ' + fmtCl(__cl.run(name, 'lead'))); } catch (e) { lines.push(turn + ' CL ' + name + ' ERR ' + e); }
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    for (const name of Object.keys(__fk.places)) {
      for (const turn of ['step', 'pivot']) {
        rig.turnStyle = turn;
        try { const o = __fk.run(name, 'lead'); lines.push(turn + ' FK ' + name + ' ' + JSON.stringify({ speed: o.speed, slide: o.slide, stretch: o.stretch, plantedMin: o.plantedMin, allLost: o.allLost, steps: o.steps, emergency: o.emergency, invalid: o.invalid, onSurface: o.onSurface, ms: o.ms, floating: o.floating, climb: o.climb })); } catch (e) { lines.push(turn + ' FK ' + name + ' ERR ' + e); }
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    rig.turnStyle = 'step';
    return lines.join('\n');
  });
}
