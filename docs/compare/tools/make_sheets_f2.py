# 方式 F 画質改善（v2）の比較画像（docs/compare/f2/**/*.png）から、ラベル付きのコンタクトシートを作る。
# 使い方: python docs/compare/tools/make_sheets_f2.py
# 撮影は tools/shots_f.js → tools/capture_f.js（window.__jobs に撮影一覧を入れて実行。手順は f2-report.md）。
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'f2'
FONT = ImageFont.truetype('C:/Windows/Fonts/YuGothB.ttc', 20)
BG = (24, 26, 34)


def label(im, text):
    im = im.copy()
    d = ImageDraw.Draw(im)
    x0, y0, x1, y1 = d.textbbox((0, 0), text, font=FONT)
    d.rectangle((6, 6, 6 + x1 - x0 + 16, 6 + y1 - y0 + 12), fill=(0, 0, 0))
    d.text((14 - x0, 12 - y0), text, font=FONT, fill=(255, 236, 170))
    return im


def sheet(rows, row_titles, out, scale=0.5, crop=None):
    """rows: [[(path, label), ...], ...]"""
    tiles = []
    for r in rows:
        line = []
        for p, text in r:
            im = Image.open(p).convert('RGB')
            if crop:
                im = im.crop(crop)
            im = im.resize((int(im.width * scale), int(im.height * scale)), Image.NEAREST)
            line.append(label(im, text))
        tiles.append(line)
    tw, th = tiles[0][0].size
    head = 130 if row_titles else 0
    gap = 4
    W = head + max(len(l) for l in tiles) * (tw + gap)
    s = Image.new('RGB', (W, len(tiles) * (th + gap)), BG)
    d = ImageDraw.Draw(s)
    for i, line in enumerate(tiles):
        y = i * (th + gap)
        if row_titles:
            d.text((10, y + th // 2 - 12), row_titles[i], font=FONT, fill=(230, 230, 230))
        for j, t in enumerate(line):
            s.paste(t, (head + j * (tw + gap), y))
    s.save(ROOT / out, optimize=True)
    print(out, s.size)


VIEW = {'std': '標準', 'near': '近距離', 'far': '遠距離', 'low': '浅い角度', 'road': '道', 'road-low': '道・浅い角度', 'road-yaw': '道・向き違い',
        'rock': '岩の周辺', 'tree': '木の根元', 'flower': '花畑', 'char-idle': 'キャラ待機', 'char-walk': 'キャラ歩行', 'char-run': 'キャラ走行', 'char-road': 'キャラ道'}

# 1. 改善前後（全視点）
views = ['std', 'near', 'far', 'low', 'road', 'road-low', 'road-yaw', 'rock', 'tree', 'flower']
sheet([[(SRC / 'before' / f'{v}.png', f'改善前 v1｜{VIEW[v]}'), (SRC / 'after' / f'{v}.png', f'改善版 v2｜{VIEW[v]}')] for v in views[:5]], None, 'f2-before-after-1.png')
sheet([[(SRC / 'before' / f'{v}.png', f'改善前 v1｜{VIEW[v]}'), (SRC / 'after' / f'{v}.png', f'改善版 v2｜{VIEW[v]}')] for v in views[5:]], None, 'f2-before-after-2.png')
# 標準視点の等倍
sheet([[(SRC / 'before' / 'std.png', '改善前 v1'), (SRC / 'after' / 'std.png', '改善版 v2')]], None, 'f2-default.png', scale=1)

# 2. 道の配色
roads = [('legacy', '改善前'), ('cobble', '石畳：灰（推奨）'), ('slate', '石畳：青灰'), ('sandstone', '砂岩'), ('dirt', '土の小道')]
sheet([[(SRC / 'road' / f'{r}-{v}.png', f'{n}｜{VIEW.get(v, "遠距離")}') for r, n in roads] for v in ['road', 'near', 'road-low', 'far']], None, 'f2-road-presets.png', scale=0.4)
# 道の拡大（中央部を等倍で切り出し）
sheet([[(SRC / 'road' / f'{r}-road.png', n) for r, n in roads]], None, 'f2-road-closeup.png', scale=1, crop=(240, 150, 620, 450))

# 3. 草の密度
dens = [('100', '100%（v1 の密度）'), ('80', '80%'), ('70', '70%（推奨）'), ('60', '60%')]
sheet([[(SRC / 'grass' / f'{d}-{v}.png', f'{n}｜{VIEW[v]}') for d, n in dens] for v in ['std', 'near', 'far', 'low', 'flower', 'rock', 'char-idle']], None, 'f2-grass-density.png', scale=0.4)

# 4. キャラクター周辺
chars = ['char-idle', 'char-walk', 'char-run', 'char-road']
sheet([[(SRC / 'before' / f'{v}.png', f'改善前｜{VIEW[v]}'), (SRC / 'after' / f'{v}.png', f'改善版｜{VIEW[v]}')] for v in chars], None, 'f2-character.png', scale=0.5)
# 足元の拡大
sheet([[(SRC / k / f'{v}.png', f'{"改善前" if k == "before" else "改善版"}｜{VIEW[v]}') for v in chars] for k in ['before', 'after']], None, 'f2-character-feet.png', scale=1, crop=(330, 200, 630, 560))
