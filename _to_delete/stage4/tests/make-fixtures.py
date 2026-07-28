#!/usr/bin/env python3
"""Regenerate the square-grid fixture map used by the regression harness."""
import sys
from PIL import Image, ImageDraw
out = sys.argv[1] if len(sys.argv) > 1 else 'printed-grid.png'
w, h, cell, ox, oy = 1000, 700, 53.3, 17.0, 9.0
im = Image.new('RGB', (w, h), '#e8dcc0')
d = ImageDraw.Draw(im)
x = ox
while x < w:
    d.line([(x, 0), (x, h)], fill='#8a7c5c', width=2); x += cell
y = oy
while y < h:
    d.line([(0, y), (w, y)], fill='#8a7c5c', width=2); y += cell
im.save(out)
print('wrote', out)
