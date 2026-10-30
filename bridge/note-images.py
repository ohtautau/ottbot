"""Compress stdin image bytes to the existing Ottlog memo limit, stdout JPEG."""
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
for size, quality in [(1280, 75), (960, 55), (720, 40)]:
    frame = image.copy()
    frame.thumbnail((size, size))
    output = io.BytesIO()
    frame.save(output, 'JPEG', quality=quality, optimize=True)
    if len(output.getvalue()) <= 180 * 1024:
        sys.stdout.buffer.write(output.getvalue())
        break
else:
    raise ValueError('Image still too large')
