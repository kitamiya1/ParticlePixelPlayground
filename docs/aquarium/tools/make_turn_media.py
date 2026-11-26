# 第 9 段階：方向転換の比較の動画と連続画像を作る（turn-cap.js で撮ったフレームから）。
#   python make_turn_media.py <frames の場所> <出力の場所>
#   - turn-<n>.webp      … 場面ごとの比較動画（2 × 2：A 従来 / B 現行 / C 踏ん張り旋回 / D 旋回中は歩行周期。20 枚 / 秒・同じ入力・同じカメラ）
#   - strip-<n>.jpg      … 場面ごとの連続画像（行 = 方式、列 = 0.15 秒ごと）
#   - sheet-<n>-<M>.jpg  … 比較ページの再生用（方式ごとのフレームを並べた 1 枚。10 列）
import glob
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

SRC, OUT = sys.argv[1], sys.argv[2]
# カニの周り（カメラはカニを画面の中央に追う）だけを切り出す
CROP = (80, 45, 400, 255)
os.makedirs(OUT, exist_ok=True)
MODES = ['A', 'B', 'C', 'D']
LABEL = {'A': 'A 従来（歩行周期）', 'B': 'B 現行（接地主導）', 'C': 'C 踏ん張り旋回（試作）', 'D': 'D 旋回中は歩行周期'}
FONT = None
for f in ['C:/Windows/Fonts/meiryo.ttc', 'C:/Windows/Fonts/YuGothM.ttc', 'C:/Windows/Fonts/msgothic.ttc']:
    if os.path.exists(f):
        FONT = ImageFont.truetype(f, 18)
        SMALL = ImageFont.truetype(f, 14)
        break


def label(im, text, sub=None):
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, 8 + d.textlength(text, font=FONT), 26], fill=(0, 0, 0))
    d.text((4, 2), text, fill=(255, 255, 255), font=FONT)
    if sub:
        d.text((4, im.height - 20), sub, fill=(255, 255, 255), font=SMALL, stroke_width=2, stroke_fill=(0, 0, 0))


scenes = sorted({int(os.path.basename(p)[1:]) for p in glob.glob(os.path.join(SRC, 's*'))})
for s in scenes:
    fr = {m: sorted(glob.glob(os.path.join(SRC, f's{s}', m, '*.jpg'))) for m in MODES}
    met = {}
    for m in MODES:
        p = os.path.join(SRC, f's{s}', m, 'metrics.json')
        if os.path.exists(p):
            met[m] = json.load(open(p, encoding='utf-8'))
    n = min(len(v) for v in fr.values())
    w, h = Image.open(fr['A'][0]).crop(CROP).size
    # 動画（2 × 2）
    grid = []
    for i in range(n):
        g = Image.new('RGB', (w * 2, h * 2))
        for k, m in enumerate(MODES):
            im = Image.open(fr[m][i]).convert('RGB').crop(CROP)
            label(im, LABEL[m], f'{i / 20:4.2f} 秒')
            g.paste(im, ((k % 2) * w, (k // 2) * h))
        grid.append(g)
    grid[0].save(os.path.join(OUT, f'turn-{s}.webp'), save_all=True, append_images=grid[1:], duration=50, loop=0, quality=72, method=4)
    # 連続画像（行 = 方式、列 = 3 枚ごと = 0.15 秒ごと。最大 12 列）
    cols = list(range(0, n, 3))[:12]
    sw, sh = w * 2 // 3, h * 2 // 3
    strip = Image.new('RGB', (sw * len(cols), sh * 4), (0, 0, 0))
    for r, m in enumerate(MODES):
        for c, i in enumerate(cols):
            im = Image.open(fr[m][i]).convert('RGB').crop(CROP).resize((sw, sh), Image.LANCZOS)
            if c == 0:
                label(im, m)
            strip.paste(im, (c * sw, r * sh))
    strip.save(os.path.join(OUT, f'strip-{s}.jpg'), quality=82)
    # 再生用の 1 枚（方式ごと、10 列）
    for m in MODES:
        rows = (n + 9) // 10
        sheet = Image.new('RGB', (w * 10, h * rows))
        for i in range(n):
            sheet.paste(Image.open(fr[m][i]).convert('RGB').crop(CROP), ((i % 10) * w, (i // 10) * h))
        sheet.save(os.path.join(OUT, f'sheet-{s}-{m}.jpg'), quality=68)
    json.dump({'frames': n, 'w': w, 'h': h, 'metrics': met}, open(os.path.join(OUT, f'scene-{s}.json'), 'w', encoding='utf-8'), ensure_ascii=False)
    print(s, n, w, h)
