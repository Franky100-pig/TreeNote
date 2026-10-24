#!/usr/bin/env python3
"""Generate the PWA icon set from build/icon.png.

Outputs (all deterministic — safe to re-run, output is committed):
  pwa/icons/icon-192.png             standard launcher icon
  pwa/icons/icon-512.png             standard launcher icon (splash/store)
  pwa/icons/icon-maskable-192.png    adaptive icon, content inside the 80% safe zone
  pwa/icons/icon-maskable-512.png    adaptive icon, content inside the 80% safe zone
  pwa/icons/apple-touch-icon-180.png iOS home-screen icon (no alpha, opaque bg)

The maskable variants pad the artwork to 80% of the canvas on a black field so
Android can crop them to any shape (circle/squircle/rounded square) without
cutting the tree. icon.png is 1024x1024 RGBA from icon.svg.
"""
import os
import sys

from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
SRC = os.path.join(ROOT, "build", "icon.png")
OUT = os.path.join(ROOT, "pwa", "icons")


def paste_centered(canvas: Image.Image, art: Image.Image) -> None:
    canvas.paste(art, ((canvas.width - art.width) // 2, (canvas.height - art.height) // 2), art)


def main() -> int:
    im = Image.open(SRC).convert("RGBA")
    os.makedirs(OUT, exist_ok=True)

    # Standard icons: full-bleed artwork.
    for size in (192, 512):
        im.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, f"icon-{size}.png"))

    # Maskable: shrink to the 80% safe zone on an opaque black field.
    for size in (192, 512):
        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 255))
        art = im.resize((int(size * 0.8), int(size * 0.8)), Image.LANCZOS)
        paste_centered(canvas, art)
        canvas.save(os.path.join(OUT, f"icon-maskable-{size}.png"))

    # Apple touch icon: opaque background (iOS composites it onto black itself,
    # but alpha-free PNGs avoid the occasional black-box artifact), full-bleed.
    apple = Image.new("RGBA", (180, 180), (0, 0, 0, 255))
    art = im.resize((180, 180), Image.LANCZOS)
    paste_centered(apple, art)
    apple.save(os.path.join(OUT, "apple-touch-icon-180.png"))

    for name in sorted(os.listdir(OUT)):
        path = os.path.join(OUT, name)
        with Image.open(path) as check:
            print(f"{name}: {check.size[0]}x{check.size[1]} {os.path.getsize(path)} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
