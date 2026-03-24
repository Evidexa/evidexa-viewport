#!/usr/bin/env python3
"""
Generates icons/icon{16,32,48,128}.png by resizing the Evidexa e-con brand mark.
Also copies the Evidexa white SVG logo for use in the panel header.
Run once from the project root: python3 scripts/gen-icons.py
"""

import os
import shutil
import struct
import zlib

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
TEMP_DIR = os.path.join(PROJECT_DIR, "~Temp")
ICONS_DIR = os.path.join(PROJECT_DIR, "icons")

SOURCE_PNG = os.path.join(TEMP_DIR, "e-con black with teal 300x300.png")
WHITE_LOGO = os.path.join(TEMP_DIR, "evidexa logo-white.svg")

SIZES = [16, 32, 48, 128]

os.makedirs(ICONS_DIR, exist_ok=True)


def read_png(path):
    with open(path, "rb") as f:
        data = f.read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "Not a valid PNG"
    chunks = []
    pos = 8
    while pos < len(data):
        length = struct.unpack(">I", data[pos:pos+4])[0]
        chunk_type = data[pos+4:pos+8]
        chunk_data = data[pos+8:pos+8+length]
        chunks.append((chunk_type, chunk_data))
        pos += 12 + length
    ihdr = chunks[0][1]
    width = struct.unpack(">I", ihdr[0:4])[0]
    height = struct.unpack(">I", ihdr[4:8])[0]
    bit_depth = ihdr[8]
    color_type = ihdr[9]
    return chunks, width, height, bit_depth, color_type


def decode_png_to_pixels(path):
    """Decode PNG to list of (r,g,b,a) tuples using stdlib only."""
    chunks, width, height, bit_depth, color_type = read_png(path)
    idat_data = b"".join(c[1] for c in chunks if c[0] == b"IDAT")
    raw = zlib.decompress(idat_data)

    if color_type == 6:
        channels = 4
    elif color_type == 2:
        channels = 3
    elif color_type == 4:
        channels = 2
    elif color_type == 0:
        channels = 1
    else:
        raise ValueError(f"Unsupported color type {color_type}")

    stride = width * channels
    pixels = []
    prev_row = bytes(stride)
    pos = 0
    for y in range(height):
        filter_type = raw[pos]
        pos += 1
        row = bytearray(raw[pos:pos+stride])
        pos += stride

        if filter_type == 0:
            pass
        elif filter_type == 1:
            for x in range(channels, len(row)):
                row[x] = (row[x] + row[x - channels]) & 0xFF
        elif filter_type == 2:
            for x in range(len(row)):
                row[x] = (row[x] + prev_row[x]) & 0xFF
        elif filter_type == 3:
            for x in range(len(row)):
                a = row[x - channels] if x >= channels else 0
                b = prev_row[x]
                row[x] = (row[x] + (a + b) // 2) & 0xFF
        elif filter_type == 4:
            for x in range(len(row)):
                a = row[x - channels] if x >= channels else 0
                b = prev_row[x]
                c = prev_row[x - channels] if x >= channels else 0
                pa = abs(b - c)
                pb = abs(a - c)
                pc = abs(a + b - 2 * c)
                pr = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                row[x] = (row[x] + pr) & 0xFF

        prev_row = bytes(row)
        row_pixels = []
        for x in range(width):
            off = x * channels
            if channels == 4:
                row_pixels.append((row[off], row[off+1], row[off+2], row[off+3]))
            elif channels == 3:
                row_pixels.append((row[off], row[off+1], row[off+2], 255))
            elif channels == 2:
                row_pixels.append((row[off], row[off], row[off], row[off+1]))
            else:
                row_pixels.append((row[off], row[off], row[off], 255))
        pixels.append(row_pixels)
    return pixels, width, height


def resize_pixels(pixels, src_w, src_h, dst_size):
    """Nearest-neighbour resize to dst_size x dst_size."""
    out = []
    for y in range(dst_size):
        row = []
        src_y = int(y * src_h / dst_size)
        for x in range(dst_size):
            src_x = int(x * src_w / dst_size)
            row.append(pixels[src_y][src_x])
        out.append(row)
    return out


def encode_png(pixels, size):
    """Encode RGBA pixel grid to PNG bytes."""
    def chunk(ctype, data):
        c = ctype + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    ihdr_data = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    raw = b""
    for row in pixels:
        raw += b"\x00"
        for r, g, b, a in row:
            raw += bytes([r, g, b, a])

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", ihdr_data)
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    return png


def main():
    print(f"Reading source: {SOURCE_PNG}")
    pixels, src_w, src_h = decode_png_to_pixels(SOURCE_PNG)

    for size in SIZES:
        resized = resize_pixels(pixels, src_w, src_h, size)
        out_path = os.path.join(ICONS_DIR, f"icon{size}.png")
        png_data = encode_png(resized, size)
        with open(out_path, "wb") as f:
            f.write(png_data)
        print(f"  Written {out_path} ({size}x{size})")

    logo_dst = os.path.join(ICONS_DIR, "evidexa-logo-white.svg")
    shutil.copy(WHITE_LOGO, logo_dst)
    print(f"  Copied white logo → {logo_dst}")

    print("Done.")


if __name__ == "__main__":
    main()
