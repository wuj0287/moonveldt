from PIL import Image, ImageDraw, ImageFont
import os

S = 1024
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
grad = Image.new('RGBA', (S, S))
top, bot = (96, 145, 255), (56, 92, 225)
gd = ImageDraw.Draw(grad)
for y in range(S):
    t = y / S
    r = int(top[0] + (bot[0] - top[0]) * t)
    g = int(top[1] + (bot[1] - top[1]) * t)
    b = int(top[2] + (bot[2] - top[2]) * t)
    gd.line([(0, y), (S, y)], fill=(r, g, b, 255))

mask = Image.new('L', (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([48, 48, S - 48, S - 48], radius=200, fill=255)
img.paste(grad, (0, 0), mask)

d = ImageDraw.Draw(img)
font_path = r'C:\Windows\Fonts\segoeuib.ttf'
if not os.path.exists(font_path):
    font_path = r'C:\Windows\Fonts\arialbd.ttf'
font = ImageFont.truetype(font_path, 600)
bbox = d.textbbox((0, 0), 'w', font=font)
w = bbox[2] - bbox[0]
h = bbox[3] - bbox[1]
d.text(((S - w) / 2 - bbox[0], (S - h) / 2 - bbox[1] - 20), 'w', font=font, fill=(255, 255, 255, 255))

out = r'C:\Users\62702\WorkBuddy\2026-09-03-22-00-42\wwj-app'
img.save(os.path.join(out, 'icon.png'))
img.save(os.path.join(out, 'wwj.ico'),
         sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('icon ok')
