# E / C / F の比較画像（docs/compare/ecf/*.png）から、方式名入りのコンタクトシートを作る。
# 使い方: python docs/compare/tools/make_sheets_ecf.py
# 撮影は tools/capture.js（window.__shots に E / C / F / F2 の撮影一覧を入れて実行）。F2 = F で幹も C 側にしたもの。
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'ecf'
FONT = ImageFont.truetype('C:/Windows/Fonts/YuGothB.ttc', 22)
FONT_S = ImageFont.truetype('C:/Windows/Fonts/YuGothB.ttc', 18)
BG = (24, 26, 34)
NAMES = {'C': 'C：サーフェル', 'E': 'E：ピクセル化メッシュ', 'F': 'F：Hybrid (E+C)', 'F2': 'F：Hybrid（幹も C）'}


def label(im, text, font=FONT):
    im = im.copy()
    d = ImageDraw.Draw(im)
    x0, y0, x1, y1 = d.textbbox((0, 0), text, font=font)
    d.rectangle((6, 6, 6 + x1 - x0 + 16, 6 + y1 - y0 + 12), fill=(0, 0, 0))
    d.text((14 - x0, 12 - y0), text, font=font, fill=(255, 236, 170))
    return im


def grid(rows, row_titles, out, scale=0.5, crop=None, font=FONT):
    tiles = []
    for r in rows:
        line = []
        for p, key in r:
            im = Image.open(p).convert('RGB')
            if crop:
                im = im.crop(crop)
            im = im.resize((int(im.width * scale), int(im.height * scale)), Image.NEAREST)
            line.append(label(im, NAMES[key], font))
        tiles.append(line)
    tw, th = tiles[0][0].size
    head = 150 if row_titles else 0
    gap = 4
    sheet = Image.new('RGB', (head + len(tiles[0]) * (tw + gap), len(tiles) * (th + gap)), BG)
    d = ImageDraw.Draw(sheet)
    for i, line in enumerate(tiles):
        y = i * (th + gap)
        if row_titles:
            d.multiline_text((10, y + th // 2 - 24), row_titles[i], font=FONT_S, fill=(230, 230, 230), spacing=4)
        for j, im in enumerate(line):
            sheet.paste(im, (head + j * (tw + gap), y))
    sheet.save(ROOT / out)
    print(out, sheet.size)


def views(names, keys=('E', 'C', 'F')):
    return [[(SRC / f'{v}-{k}.png', k) for k in keys] for v in names]


# 1. 標準視点の E / C / F 横並び（等倍）
grid(views(['default']), None, 'ecf-default.png', scale=1.0)
# 2. 視点ごとのコンタクトシート（行 = 視点、列 = E / C / F）
grid(views(['default', 'near', 'far', 'pitch-low', 'pitch-high']), ['標準\nズーム15\n見下ろし0.6', '近距離\nズーム7.5', '遠距離\nズーム33', '浅い角度\n見下ろし0.3', '真上寄り\n見下ろし1.25'], 'ecf-grid.png')
# 3. 場面（全景・拡大・キャラ・向き違い）
grid(views(['island', 'closeup', 'character', 'yaw']), ['全景\nズーム62', '地形・草木\nズーム5', 'キャラ\nズーム3.2', '向き違い\nヨー2.4'], 'ecf-scenes.png')
# 4. 幹の扱い（F：幹 E / 幹 C）
grid(views(['default', 'closeup', 'pitch-low'], ('F', 'F2')), ['標準', '拡大\nズーム5', '浅い角度'], 'ecf-trunk.png')
