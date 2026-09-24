"""Génère le logo pixel art de Prism : un prisme qui décompose un rayon blanc en spectre.

Sorties (dans frontend/assets/) :
    prism-logo.svg  — 32×32, un <rect> par segment de pixels (net à toute taille)
    prism-logo.png  — 256×256 (×8, plus proche voisin)

Usage :  python tools/pixel_logo.py [--preview CHEMIN.png]
Aucune dépendance : le PNG est encodé à la main (zlib + struct).
"""
from __future__ import annotations

import argparse
import struct
import zlib
from pathlib import Path

SIZE = 32
ASSETS = Path(__file__).resolve().parent.parent / "frontend" / "assets"

# Palette volontairement réduite (esprit 16 bits).
OUTLINE = "#d9f3ff"
GLASS = ["#8fd0ff", "#5fa6f0", "#3f74c9", "#2b4a8f"]  # du plus éclairé au plus sombre
HIGHLIGHT = "#ffffff"
BEAM = "#ffffff"
BEAM_SOFT = "#b9c6ff"
INNER_RAY = "#b3dcff"
SPECTRUM = ["#ff4d5e", "#ff9f1c", "#ffe14d", "#3ddc84", "#3aa0ff", "#9b5cff"]

APEX, LEFT, RIGHT = (16.0, 4.0), (6.0, 26.0), (26.0, 26.0)


def _edge(a, b, p):
    return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])


def inside(x: int, y: int) -> bool:
    p = (x + 0.5, y + 0.5)
    d1, d2, d3 = _edge(APEX, RIGHT, p), _edge(RIGHT, LEFT, p), _edge(LEFT, APEX, p)
    return (d1 >= 0 and d2 >= 0 and d3 >= 0) or (d1 <= 0 and d2 <= 0 and d3 <= 0)


def line(x0: int, y0: int, x1: int, y1: int):
    """Bresenham : liste des pixels entre deux points."""
    pts, dx, dy = [], abs(x1 - x0), -abs(y1 - y0)
    sx, sy = (1 if x0 < x1 else -1), (1 if y0 < y1 else -1)
    err = dx + dy
    while True:
        pts.append((x0, y0))
        if (x0, y0) == (x1, y1):
            return pts
        e2 = 2 * err
        if e2 >= dy:
            err += dy
            x0 += sx
        if e2 <= dx:
            err += dx
            y0 += sy


def build_grid() -> list[list[str | None]]:
    grid: list[list[str | None]] = [[None] * SIZE for _ in range(SIZE)]

    def put(x, y, color):
        if 0 <= x < SIZE and 0 <= y < SIZE:
            grid[y][x] = color

    # 1. Spectre en éventail vers la droite (rouge en haut : il dévie le moins).
    exit_x, exit_y = 20, 15
    for x in range(exit_x, SIZE):
        t = (x - exit_x) / (SIZE - 1 - exit_x)
        center = exit_y + 0.5 + t * 5.5
        band = 0.5 + t * 1.6
        top = center - band * len(SPECTRUM) / 2
        for i, color in enumerate(SPECTRUM):
            for y in range(round(top + i * band), round(top + (i + 1) * band)):
                put(x, y, color)

    # 2. Rayon blanc entrant par la gauche (2 px : cœur + halo).
    for x, y in line(0, 21, 11, 16):
        put(x, y, BEAM)
        put(x, y + 1, BEAM_SOFT)

    # 3. Corps du prisme : dégradé quantifié, éclairé en haut à gauche.
    for y in range(SIZE):
        for x in range(SIZE):
            if not inside(x, y):
                continue
            shade = (x - LEFT[0]) / 20 * 0.55 + (y - APEX[1]) / 22 * 0.45
            grid[y][x] = GLASS[min(len(GLASS) - 1, max(0, int(shade * len(GLASS))))]

    # 4. Contour : pixels intérieurs touchant l'extérieur.
    for y in range(SIZE):
        for x in range(SIZE):
            if inside(x, y) and any(
                not (0 <= x + dx < SIZE and 0 <= y + dy < SIZE) or not inside(x + dx, y + dy)
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))
            ):
                grid[y][x] = OUTLINE

    # 5. Reflet sur l'arête gauche + trajet lumineux à travers le verre.
    for x, y in line(15, 7, 10, 18):
        if inside(x + 1, y) and grid[y][x + 1] != OUTLINE:
            put(x + 1, y, HIGHLIGHT)
    for x, y in line(12, 16, 19, 15):
        if inside(x, y) and grid[y][x] != OUTLINE:
            put(x, y, INNER_RAY)

    # 6. Étincelle.
    for dx, dy in ((0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)):
        put(26 + dx, 6 + dy, HIGHLIGHT if (dx, dy) == (0, 0) else "#9fdcff")
    return grid


def to_svg(grid) -> str:
    rects = []
    for y, row in enumerate(grid):
        x = 0
        while x < SIZE:
            color = row[x]
            if color is None:
                x += 1
                continue
            run = 1
            while x + run < SIZE and row[x + run] == color:
                run += 1
            rects.append(f'<rect x="{x}" y="{y}" width="{run}" height="1" fill="{color}"/>')
            x += run
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {SIZE} {SIZE}" '
        f'width="{SIZE}" height="{SIZE}" shape-rendering="crispEdges">'
        "<title>Prism</title>" + "".join(rects) + "</svg>\n"
    )


def to_png(grid, scale: int) -> bytes:
    def rgba(color):
        if color is None:
            return b"\x00\x00\x00\x00"
        return bytes.fromhex(color[1:]) + b"\xff"

    raw = bytearray()
    for row in grid:
        line_px = b"".join(rgba(c) * scale for c in row)
        for _ in range(scale):
            raw += b"\x00" + line_px

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    side = SIZE * scale
    header = struct.pack(">IIBBBBB", side, side, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preview", type=Path, help="PNG ×16 sur fond sombre, pour inspection")
    args = parser.parse_args()

    grid = build_grid()
    ASSETS.mkdir(parents=True, exist_ok=True)
    (ASSETS / "prism-logo.svg").write_text(to_svg(grid), encoding="utf-8")
    (ASSETS / "prism-logo.png").write_bytes(to_png(grid, 8))
    print(f"écrit : {ASSETS / 'prism-logo.svg'}")
    print(f"écrit : {ASSETS / 'prism-logo.png'}")
    if args.preview:
        dark = [[c or "#0b0d12" for c in row] for row in grid]
        args.preview.write_bytes(to_png(dark, 16))
        print(f"aperçu : {args.preview}")


if __name__ == "__main__":
    main()
