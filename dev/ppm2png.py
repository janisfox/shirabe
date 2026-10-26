"""Convert the plain-text PPM snapshots from dev/snapshot.nyk to PNG (stdlib only).

usage: python dev/ppm2png.py <file.ppm> [...]
"""
import struct
import sys
import zlib


def convert(path: str) -> str:
    with open(path, encoding="ascii") as f:
        tokens = f.read().split()
    assert tokens[0] == "P3", "not a P3 ppm"
    w, h, _maxval = int(tokens[1]), int(tokens[2]), int(tokens[3])
    values = bytes(int(v) for v in tokens[4 : 4 + w * h * 3])
    raw = b"".join(b"\x00" + values[y * w * 3 : (y + 1) * w * 3] for y in range(h))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    out = path.rsplit(".", 1)[0] + ".png"
    with open(out, "wb") as f:
        f.write(png)
    return out


if __name__ == "__main__":
    for arg in sys.argv[1:]:
        print(convert(arg))
