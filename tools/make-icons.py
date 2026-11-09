#!/usr/bin/env python3
"""Draw the toolbar icons: a blue rounded square, a white tick, a red squiggle.

Rendered eight times oversampled and averaged down, which is where the smooth
edges come from. Writes icons/icon{16,32,48,128}.png.

    python3 tools/make-icons.py
"""

import math
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), 'icons')

BLUE = (5, 68, 164)
WHITE = (255, 255, 255)
RED = (235, 87, 87)
SS = 6                       # supersampling factor


def dist_to_segment(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    length = dx * dx + dy * dy
    t = 0.0 if length == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length))
    cx, cy = ax + t * dx, ay + t * dy
    return math.hypot(px - cx, py - cy)


def sample(u, v):
    """Colour at (u, v) in the unit square, or None for transparent."""
    # rounded square
    radius = 0.22
    inside_x = min(max(u, radius), 1 - radius)
    inside_y = min(max(v, radius), 1 - radius)
    if math.hypot(u - inside_x, v - inside_y) > radius:
        return None

    # red squiggle along the bottom
    wave = 0.80 + 0.045 * math.sin((u - 0.18) * math.pi * 6.5)
    if 0.16 < u < 0.86 and abs(v - wave) < 0.052:
        return RED

    # white tick
    tick = min(
        dist_to_segment(u, v, 0.24, 0.50, 0.42, 0.655),
        dist_to_segment(u, v, 0.42, 0.655, 0.78, 0.26),
    )
    if tick < 0.075:
        return WHITE

    return BLUE


def render(size):
    big = size * SS
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            r = g = b = a = 0
            for sy in range(SS):
                for sx in range(SS):
                    u = (x * SS + sx + 0.5) / big
                    v = (y * SS + sy + 0.5) / big
                    colour = sample(u, v)
                    if colour is None:
                        continue
                    r += colour[0]
                    g += colour[1]
                    b += colour[2]
                    a += 255
            n = SS * SS
            if a == 0:
                row += b'\x00\x00\x00\x00'
            else:
                covered = a / 255.0
                row += bytes((
                    int(round(r / covered)) & 255,
                    int(round(g / covered)) & 255,
                    int(round(b / covered)) & 255,
                    int(round(a / n)) & 255,
                ))
        rows.append(bytes(row))
    return rows


def write_png(path, rows, size):
    raw = b''.join(b'\x00' + row for row in rows)

    def chunk(kind, data):
        return (struct.pack('>I', len(data)) + kind + data
                + struct.pack('>I', zlib.crc32(kind + data) & 0xFFFFFFFF))

    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw, 9))
           + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)


def main():
    os.makedirs(OUT, exist_ok=True)
    for size in (16, 32, 48, 128):
        path = os.path.join(OUT, f'icon{size}.png')
        write_png(path, render(size), size)
        print(f'{path} ({os.path.getsize(path)} bytes)')


if __name__ == '__main__':
    main()
