#!/usr/bin/env python3
"""Export already sampled RGBA PNG frames without losing GIF transparency.

Requires Pillow. Frame sampling/cropping is separate from GIF encoding so that
an export cannot silently change the source animation's time axis.
"""
import argparse
from pathlib import Path

from PIL import Image


def palette_frame(image):
    rgba = image.convert("RGBA")
    # Reserve one palette index in EVERY frame. Pillow's automatic RGBA palette
    # can assign a different transparent index per frame; a shared save option
    # then turns some of those pixels into opaque black (or another colour).
    indexed = rgba.convert("RGB").quantize(colors=255)
    palette = indexed.getpalette()
    indexed.putpalette((palette + [0] * 768)[:765] + [0, 0, 0])
    indexed.paste(255, mask=rgba.getchannel("A").point(lambda a: 255 if a <= 80 else 0))
    indexed.info["transparency"] = 255
    return indexed


def export_frames(frames, destination, duration_ms=100):
    frames = list(frames)
    if not frames or not 100 <= duration_ms <= 500 or duration_ms % 10:
        raise ValueError("Need frames and a GIF frame duration of 100–500 ms in 10 ms units")
    if len({frame.size for frame in frames}) != 1:
        raise ValueError("All frames must have the same dimensions")
    encoded = [palette_frame(frame) for frame in frames]
    encoded[0].save(destination, save_all=True, append_images=encoded[1:],
                    duration=duration_ms, loop=0, disposal=2, optimize=False,
                    transparency=255, background=255)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Directory of time-ordered RGBA PNG frames")
    parser.add_argument("output", type=Path)
    parser.add_argument("--crop", nargs=4, type=int, metavar=("LEFT", "TOP", "RIGHT", "BOTTOM"))
    parser.add_argument("--duration-ms", type=int, default=100)
    args = parser.parse_args()
    frames = [Image.open(path).convert("RGBA") for path in sorted(args.input.glob("*.png"))]
    if args.crop:
        frames = [frame.crop(tuple(args.crop)) for frame in frames]
    export_frames(frames, args.output, args.duration_ms)
