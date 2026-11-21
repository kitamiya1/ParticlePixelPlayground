# A〜E の比較画像（docs/compare/abcde/*.png）から、方式名入りのコンタクトシートを作る。
# 使い方: python docs/compare/tools/make_sheets.py
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'abcde'
LETTERS = ['A', 'B', 'C', 'D', 'E']
NAMES = {'A': 'A：ポイント', 'B': 'B：Gaussian Splats', 'C': 'C：サーフェル', 'D': 'D：ボクセル', 'E': 'E：ピクセル化メッシュ'}
FONT = ImageFont.truetype('C:/Windows/Fonts/YuGothB.ttc', 22)
FONT_S = ImageFont.truetype('C:/Windows/Fonts/YuGothB.ttc', 18)
BG = (24, 26, 34)


def label(im: Image.Image, text: str, font=FONT) -> Image.Image:
    im = im.copy()
    d = ImageDraw.Draw(im)
    x0, y0, x1, y1 = d.textbbox((0, 0), text, font=font)
    d.rectangle((6, 6, 6 + x1 - x0 + 16, 6 + y1 - y0 + 12), fill=(0, 0, 0))
    d.text((14 - x0, 12 - y0), text, font=font, fill=(255, 236, 170))
    return im


def grid(rows, row_titles, out, scale=0.5, crop=None, font=FONT):
    """rows: [[path, ...], ...]。各セルに方式名、各行の左に見出しを付けて並べる"""
    tiles = []
    for r in rows:
        line = []
        for p, letter in r:
            im = Image.open(p).convert('RGB')
            if crop:
                im = im.crop(crop)
            im = im.resize((int(im.width * scale), int(im.height * scale)), Image.NEAREST)
            line.append(label(im, NAMES[letter], font))
        tiles.append(line)
    tw, th = tiles[0][0].size
    head = 150 if row_titles else 0
    gap = 4
    W = head + len(tiles[0]) * (tw + gap)
    H = len(tiles) * (th + gap)
    sheet = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(sheet)
    for i, line in enumerate(tiles):
        y = i * (th + gap)
        if row_titles:
            d.multiline_text((10, y + th // 2 - 24), row_titles[i], font=FONT_S, fill=(230, 230, 230), spacing=4)
        for j, im in enumerate(line):
            sheet.paste(im, (head + j * (tw + gap), y))
    sheet.save(ROOT / out)
    print(out, sheet.size)


def views(names):
    return [[(SRC / f'{v}-{L}.png', L) for L in LETTERS] for v in names]


# 1. 5 方式の横並び（標準視点・等倍）
grid(views(['default']), None, 'abcde-default.png', scale=1.0)
# 2. 視点ごとのコンタクトシート（行 = 視点、列 = A〜E）
grid(views(['default', 'near', 'far', 'pitch-low', 'pitch-high']), ['標準\nズーム15\n見下ろし0.6', '近距離\nズーム7.5', '遠距離\nズーム33', '浅い角度\n見下ろし0.3', '真上寄り\n見下ろし1.25'], 'abcde-grid.png')
# 3. 場面ごと（全景・地形と草木の拡大・キャラクターの拡大・カメラの向き）
grid(views(['overview', 'flora', 'character', 'yaw']), ['浮き島の全景\nズーム62\n見下ろし0.42', '地形・草木の拡大\nズーム5', 'キャラクター\nの拡大\nズーム3.2', 'カメラの向き\nヨー2.4\nズーム12'], 'abcde-scenes.png')
# 4. 歩行・走行（キャラクター周辺を切り出し。行 = 方式、列 = 歩行 4 位相・走行 4 位相）
cols = [f'walk{k}' for k in range(4)] + [f'run{k}' for k in range(4)]
rows = [[(SRC / f'anim-{c}-{L}.png', L) for c in cols] for L in LETTERS]
grid(rows, [f'{NAMES[L]}\n左4：歩行\n右4：走行' for L in LETTERS], 'abcde-anim.png', scale=0.75, crop=(325, 190, 625, 610), font=FONT_S)
# 5. 左右比較（E と A〜D。アプリの左右比較表示をそのまま保存したもの）
cmp = [Image.open(SRC / f'cmp-{L}-E.png').convert('RGB') for L in 'ABCD']
w, h = cmp[0].size
sheet = Image.new('RGB', (w * 2 + 4, h * 2 + 4), BG)
for i, im in enumerate(cmp):
    im = im.resize((w, h))
    sheet.paste(im, ((i % 2) * (w + 4), (i // 2) * (h + 4)))
sheet = sheet.resize((sheet.width // 2, sheet.height // 2), Image.LANCZOS)
sheet.save(ROOT / 'abcde-compare-E.png')
print('abcde-compare-E.png', sheet.size)
