# 撮った画面を表に並べた 1 枚の画像を作る（比較用）。
#   python make_sheet.py <shots_dir> <out.jpg> <row_label=prefix,...> <col1,col2,...> [scale]
# 行 = ファイル名の前半（例 entry-before-back）、列 = 後半（例 0.5）。ファイル名 = f"{行}-{列}.jpg"
import sys
from PIL import Image, ImageDraw, ImageFont

d, out, rows, cols = sys.argv[1], sys.argv[2], sys.argv[3].split(','), sys.argv[4].split(',')
scale = float(sys.argv[5]) if len(sys.argv) > 5 else 0.33
ims = [[Image.open(f"{d}/{r}-{c}.jpg") for c in cols] for r in rows]
w, h = int(ims[0][0].width * scale), int(ims[0][0].height * scale)
L, T = 170, 22
sheet = Image.new('RGB', (L + w * len(cols), T + h * len(rows)), (20, 20, 24))
dr = ImageDraw.Draw(sheet)
try:
    font = ImageFont.truetype('C:/Windows/Fonts/meiryo.ttc', 14)
except OSError:
    font = ImageFont.load_default()
for j, c in enumerate(cols):
    dr.text((L + j * w + 4, 3), c, fill=(230, 230, 230), font=font)
for i, r in enumerate(rows):
    dr.text((4, T + i * h + h // 2 - 8), r, fill=(230, 230, 230), font=font)
    for j in range(len(cols)):
        sheet.paste(ims[i][j].resize((w, h)), (L + j * w, T + i * h))
sheet.save(out, quality=85)
print(out, sheet.size)
