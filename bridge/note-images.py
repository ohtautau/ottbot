"""Bounded stdin image compression for Ottlog memos or Weixin upload fallback."""
import io
import sys
from PIL import Image, ImageOps

raw = sys.stdin.buffer.read(10 * 1024 * 1024 + 1)
if len(raw) > 10 * 1024 * 1024:
    raise ValueError('Image exceeds transport limit')
Image.MAX_IMAGE_PIXELS = 40_000_000
image = Image.open(io.BytesIO(raw))
if image.width * image.height > 40_000_000:
    raise ValueError('Image dimensions too large')
image = ImageOps.exif_transpose(image)
if image.mode != 'RGB':
    background = Image.new('RGB', image.size, 'white')
    if 'A' in image.getbands():
        background.paste(image, mask=image.getchannel('A'))
    else:
        background.paste(image.convert('RGB'))
    image = background
weixin = '--weixin' in sys.argv[1:]
limit = 48 * 1024 if weixin else 180 * 1024
profiles = [(1600, 85), (1280, 80), (1024, 75), (960, 65), (800, 60), (640, 55), (512, 45), (320, 40)] if weixin else [(1280, 75), (960, 55), (720, 40)]
for size, quality in profiles:
    frame = image.copy()
    frame.thumbnail((size, size))
    output = io.BytesIO()
    frame.save(output, 'JPEG', quality=quality, optimize=True)
    if len(output.getvalue()) <= limit:
        sys.stdout.buffer.write(output.getvalue())
        break
else:
    raise ValueError('Image still too large')
