#!/usr/bin/env python3
"""
ZOOM SMS — build the logo asset set from a supplied master image.

The master arrives as a square mark in gold on a solid black field, with no
alpha channel. Dropped straight into a dark UI it would read as a black box,
and on any light surface it would be worse. So the black field is keyed out to
transparency, which lets the mark sit directly on the panel background.

Keying rule, derived from the histogram of the supplied master:
    * coloured pixels (max-min channel spread > 25) are the gold mark -> opaque
    * very bright neutral pixels (max channel > 200) are white elements -> opaque
    * everything else is the black field -> transparent
Antialiased fringes are ramped rather than cut, to avoid a hard outline.

Writes:
    assets/zoom-logo-transparent.png   512x512  (used by the login + panels)
    assets/zoom-logo.png              1024x1024
    assets/zoom-logo-square.png       1024x1024
    assets/zoom-favicon.png             128x128

Usage: python3 tools/build-logo-assets.py <master.png>
"""
import os
import sys
from PIL import Image

SPREAD = 25      # channel spread above which a pixel counts as coloured (gold)
WHITE = 200      # max-channel above which a neutral pixel is a white element
RAMP_LO, RAMP_HI = 10, 34   # antialias ramp in max-channel units


def key_to_alpha(img):
    """Return an RGBA image with the black field made transparent."""
    src = img.convert('RGB')
    w, h = src.size
    px = src.load()
    out = Image.new('RGBA', (w, h))
    op = out.load()
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            mx, mn = max(r, g, b), min(r, g, b)
            spread = mx - mn
            if spread > SPREAD:
                # gold mark; fade only the very darkest antialiased fringe
                a = 0 if mx < RAMP_LO else (
                    255 if mx >= RAMP_HI else int(255 * (mx - RAMP_LO) / (RAMP_HI - RAMP_LO)))
            elif mx > WHITE:
                a = 255                     # white element
            else:
                a = 0                       # black field
            op[x, y] = (r, g, b, a)
    return out


def main():
    master = sys.argv[1] if len(sys.argv) > 1 else '/home/user/uploads/image-1.png'
    if not os.path.exists(master):
        sys.exit('master not found: ' + master)

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    assets = os.path.join(root, 'assets')

    img = Image.open(master)
    print('  master: %s  %s  %s' % (os.path.basename(master), img.size, img.mode))

    rgba = key_to_alpha(img)

    # Trim to the mark so the assets carry no dead margin.
    # Trim on the ALPHA channel, not on the image: getbbox() on an RGBA image
    # treats a near-black pixel with alpha 0 as non-zero, so the black field
    # (which is #030200 rather than pure #000000) kept the full canvas.
    bbox = rgba.split()[-1].getbbox()
    if bbox:
        rgba = rgba.crop(bbox)
        print('  trimmed to mark bbox: %s' % (rgba.size,))

    jobs = [
        ('zoom-logo-transparent.png', 512),
        ('zoom-logo.png', 1024),
        ('zoom-logo-square.png', 1024),
        ('zoom-favicon.png', 128),
    ]
    for name, size in jobs:
        im = rgba.resize((size, size), Image.LANCZOS)
        dest = os.path.join(assets, name)
        im.save(dest, 'PNG', optimize=True)
        print('  wrote %-30s %4dx%-4d  %7d bytes' % (name, size, size, os.path.getsize(dest)))

    # sanity: how much survived?
    a = rgba.split()[-1]
    hist = a.histogram()
    transparent, opaque = hist[0], sum(hist[1:])
    total = transparent + opaque
    print('  alpha check: %.1f%% opaque (mark), %.1f%% fully transparent (field)'
          % (100 * opaque / total, 100 * transparent / total))


if __name__ == '__main__':
    main()
