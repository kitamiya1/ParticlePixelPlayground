#!/usr/bin/env python3
"""iOS シミュレーターの起動の試験（ios-sim-run.sh）の結果をまとめる。標準ライブラリだけ（CI の macOS の python3）。

  python3 ios-sim-summary.py <出力のフォルダ>   → <フォルダ>/summary.md・summary.json

- 各回（cold1…・cold1-restart・warm1…・gpu・gpu-restart）：ゲームの記録（.err）から起動の段階・描画の準備・最初のフレーム・
  5 秒ごとのフレーム数・描画の喪失と復旧・画面の大きさと安全領域を拾う
- 系統のログ（*-syslog.txt）：GPU 処理の「応答なし」・終了・起動にかかった秒・ページの描画が遅れた秒
- 画面（*.png）：sips で縮めてから読み、白い画面・読み込み中（暗い地）・ゲーム・画面の下の帯（下 8% が白い）を判定する
- 成功の判定（起動ごと）：ゲームの記録に「boot done … gpu=ready」と、5 秒ごとの記録でフレームが進んでいること、かつ
  最後の画面がゲーム（白でも読み込み中でもない）
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import zlib

OUT = sys.argv[1]


def png_pixels(path):
    """縮めた PNG（8 bit・RGB / RGBA・インターレース無し）を読む → (幅, 高さ, 行ごとの [(r,g,b)])"""
    with tempfile.TemporaryDirectory() as td:
        small = os.path.join(td, 's.png')
        try:
            subprocess.run(['sips', '-Z', '240', '-s', 'format', 'png', path, '--out', small], capture_output=True, check=True)
        except FileNotFoundError:  # macOS 以外（手元での確かめ）：縮めずに読む（遅い）
            small = path
        data = open(small, 'rb').read()
    pos, idat, w = 8, b'', 0
    while pos < len(data):
        ln = int.from_bytes(data[pos:pos + 4], 'big')
        typ = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + ln]
        if typ == b'IHDR':
            w, h, depth, ctype, _, _, inter = int.from_bytes(body[0:4], 'big'), int.from_bytes(body[4:8], 'big'), body[8], body[9], body[10], body[11], body[12]
            if depth != 8 or ctype not in (2, 6) or inter:
                raise ValueError(f'unsupported png depth={depth} type={ctype} interlace={inter}')
            bpp = 3 if ctype == 2 else 4
        elif typ == b'IDAT':
            idat += body
        pos += 12 + ln
    raw = zlib.decompress(idat)
    stride = w * bpp
    rows, prev, i = [], bytearray(stride), 0
    for _ in range(h):
        f = raw[i]
        line = bytearray(raw[i + 1:i + 1 + stride])
        i += 1 + stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0
            b = prev[x]
            c = prev[x - bpp] if x >= bpp else 0
            if f == 1:
                line[x] = (line[x] + a) & 255
            elif f == 2:
                line[x] = (line[x] + b) & 255
            elif f == 3:
                line[x] = (line[x] + (a + b) // 2) & 255
            elif f == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        rows.append([(line[x], line[x + 1], line[x + 2]) for x in range(0, stride, bpp)])
        prev = line
    return w, h, rows


def classify(path):
    try:
        w, h, rows = png_pixels(path)
    except Exception as e:  # noqa: BLE001
        return {'error': str(e)}
    white = lambda p: min(p) >= 235
    dark = lambda p: abs(p[0] - 0x12) <= 10 and abs(p[1] - 0x15) <= 10 and abs(p[2] - 0x1f) <= 12
    # 上の 7%（状態バー）は除く
    body = rows[int(h * 0.07):]
    px = [p for r in body for p in r]
    band = [p for r in rows[int(h * 0.92):int(h * 0.985)] for p in r]
    fw = sum(map(white, px)) / len(px)
    fd = sum(map(dark, px)) / len(px)
    bw = sum(map(white, band)) / max(1, len(band))
    kind = 'white' if fw > 0.9 else 'loading' if fd > 0.8 else 'game'
    return {'kind': kind, 'white': round(fw, 3), 'dark': round(fd, 3), 'bottomWhite': round(bw, 3), 'size': f'{w}x{h}'}


def parse_err(path):
    if not os.path.exists(path):
        return None
    lines = open(path, encoding='utf-8-sig', errors='replace').read().splitlines()
    g = lambda pat: next((l for l in lines if re.search(pat, l)), None)
    beats = [int(m.group(1)) for l in lines for m in [re.search(r'\] frame (\d+) fps=', l)] if m]
    t = lambda l: float(re.search(r'\+([\d.]+)s\]', l).group(1)) if l else None
    boot = g(r'boot done')
    prep = g(r'gpu: prepare \(boot\) (done|LOST)')
    return {
        'lines': len(lines),
        'native': [l for l in lines if l.startswith('[native]')],
        'bootDoneAt': t(boot),
        'bootLine': boot,
        'gpuReadyAtBoot': bool(boot and 'gpu=ready' in boot),
        'build': g(r'build meshes'),
        'renderer': g(r'renderer created'),
        'saveLoaded': g(r'save loaded'),
        'prepare': prep,
        'frame1': g(r'\] frame 1 took'),
        'beats': beats,
        'framesAdvancing': len(beats) >= 2 and beats[-1] > beats[0],
        'gpuEvents': [l for l in lines if re.search(r'gpu: (webglcontext|failed|reload|this page|save flush)', l)],
        'layout': g(r'\] layout '),
        'selftest': [l for l in lines if 'selftest' in l],
        'lastBeat': next((l for l in reversed(lines) if re.search(r'\] frame \d+ fps=', l)), None),
    }


def parse_syslog(path):
    if not os.path.exists(path):
        return None
    txt = open(path, encoding='utf-8-sig', errors='replace').read().splitlines()
    pick = lambda pat: [l[:230] for l in txt if re.search(pat, l)]
    return {
        'unresponsive': pick(r'became unresponsive|DidBecomeUnresponsive'),
        'gpuExited': pick(r'gpuProcessExited|gpuProcessDidExit'),
        'launchTook': pick(r'took [\d.]+ seconds to launch'),
        'commitLate': pick(r'finally received commit'),
        'contextLost': pick(r'(?i)webgl.*(lost|context)|GraphicsContextGL.*(lost|Lost)'),
        'jetsam': pick(r'(?i)jetsam|memory pressure|EXC_RESOURCE'),
    }


names = sorted({f[:-7] for f in os.listdir(OUT) if f.endswith('.launch')}, key=lambda n: (0 if n.startswith('cold') else 1 if n.startswith('ctrl') else 2, n))
runs = {}
for n in names:
    shots = sorted((f for f in os.listdir(OUT) if re.match(re.escape(n) + r'-(\d+s|final)\.png$', f)), key=lambda f: (f.endswith('-final.png'), f))
    sl = parse_syslog(os.path.join(OUT, f'{n}-syslog.txt')) or (parse_syslog(os.path.join(OUT, 'warm-syslog.txt')) if n.startswith('warm') else None)
    # ゲームの記録：アプリの diag.log（第 3 段の 2 回目から）。無ければ標準エラー（1 回目は空だった）
    r = {'err': parse_err(os.path.join(OUT, f'{n}.diag.log')) or parse_err(os.path.join(OUT, f'{n}.err')), 'syslog': sl, 'shots': {s: classify(os.path.join(OUT, s)) for s in shots}}
    last = r['shots'][shots[-1]]['kind'] if shots else None
    e = r['err'] or {}
    r['ok'] = bool(e.get('gpuReadyAtBoot') and e.get('framesAdvancing') and last == 'game')
    if n == 'gpu':
        r['ok'] = None  # GPU を止める試験は別に判定
    runs[n] = r
extra = {s: classify(os.path.join(OUT, s)) for s in sorted(os.listdir(OUT)) if s.startswith('gpu-') and s.endswith('.png') and ('kill' in s)}

launches = [n for n in runs if n != 'gpu' and not n.startswith('ctrl')]
ok = [n for n in launches if runs[n]['ok']]
first = [n for n in launches if re.fullmatch(r'cold\d+', n)]
ctrl = [n for n in runs if n.startswith('ctrl')]
summary = {'launches': len(launches), 'ok': len(ok), 'okNames': ok, 'failed': [n for n in launches if not runs[n]['ok']], 'firstLaunches': len(first), 'firstOk': len([n for n in first if runs[n]['ok']]), 'control': {n: runs[n]['ok'] for n in ctrl}, 'runs': runs, 'gpuKillShots': extra}
json.dump(summary, open(os.path.join(OUT, 'summary.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

md = [f'# iOS シミュレーターの起動の試験のまとめ', '', f'修正後の起動 {len(launches)} 回のうち成功 {len(ok)} 回（うち初回起動 {summary["firstLaunches"]} 回中 {summary["firstOk"]} 回）。GPU を止める試験の起動・対照（ctrl = 描画の準備を飛ばす）は数えない', '', f'対照：' + (', '.join(f'{n}={v}' for n, v in summary['control'].items()) or 'なし'), '']
md.append('| 回 | 成功 | 起動完了（秒） | 描画の準備 | 最後のフレーム記録 | 画面（撮った秒：判定 / 下の帯の白） | 描画の喪失（ゲームの記録） | GPU の応答なし・終了（系統のログ） |')
md.append('| --- | --- | --- | --- | --- | --- | --- | --- |')
for n, r in runs.items():
    e = r['err'] or {}
    sl = r['syslog'] or {}
    prep = re.sub(r'^.*prepare \(boot\) ', '', e.get('prepare') or '-')[:90]
    secs = {s: (lambda m: m.group(1).lstrip('0') + 's' if m else 'final')(re.search(r'-(\d+)s\.png$', s)) for s in r['shots']}
    shots = ' '.join(f"{secs[s]}:{v.get('kind', '?')}/{v.get('bottomWhite', '?')}" for s, v in r['shots'].items())
    lb = re.sub(r'^.*\] ', '', e.get('lastBeat') or '-')[:60]
    md.append(f"| {n} | {r['ok']} | {e.get('bootDoneAt')} | {prep} | {lb} | {shots} | {sum('webglcontextlost' in x for x in e.get('gpuEvents', []))} | {len(sl.get('unresponsive', []))} / {len(sl.get('gpuExited', []))} |")
md += ['', '## GPU 処理を止めた後の画面', '']
md += [f'- {s}: {v}' for s, v in extra.items()]
md += ['', '## 記録の抜粋', '']
for n, r in runs.items():
    e = r['err'] or {}
    md.append(f'### {n}')
    for k in ('native', 'build', 'renderer', 'saveLoaded', 'prepare', 'frame1', 'layout', 'bootLine'):
        v = e.get(k)
        if v:
            md += [f'- {x}' for x in (v if isinstance(v, list) else [v])]
    md += [f'- {x}' for x in e.get('gpuEvents', []) + e.get('selftest', [])]
    sl = r['syslog'] or {}
    for k in ('launchTook', 'commitLate', 'unresponsive', 'gpuExited', 'jetsam'):
        md += [f'- syslog {k}: {x}' for x in sl.get(k, [])[:6]]
    md.append('')
open(os.path.join(OUT, 'summary.md'), 'w', encoding='utf-8').write('\n'.join(md))
print('\n'.join(md[:12 + len(runs)]))
