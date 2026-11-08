"""生成扩展图标 PNG（纯标准库，无外部依赖）。"""
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
os.makedirs(OUT, exist_ok=True)


def png(size):
    rows = []
    cx = cy = (size - 1) / 2
    r = size * 0.47
    for y in range(size):
        row = bytearray()
        for x in range(size):
            # 圆角方形底：B 站蓝
            inside = (x - cx) ** 2 + (y - cy) ** 2 <= r * r
            if not inside:
                row += bytes((0, 0, 0, 0))
                continue
            # 白色「眼睛 + 斜杠」：被划掉的自动发评
            eye = (x - cx) ** 2 + (y - cy) ** 2 <= (size * 0.26) ** 2
            eye_ring = eye and (x - cx) ** 2 + (y - cy) ** 2 >= (size * 0.19) ** 2
            slash = abs((y - cy) + (x - cx) * 0.9) <= size * 0.045 and abs(x - cx) <= size * 0.30
            if eye_ring or slash:
                row += bytes((255, 255, 255, 255))
            elif eye:
                row += bytes((0, 174, 236, 255))
            else:
                row += bytes((0, 174, 236, 255))
        rows.append(bytes(row))
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


for s in (16, 48, 128):
    with open(os.path.join(OUT, f"icon{s}.png"), "wb") as f:
        f.write(png(s))
    print("wrote", os.path.join(OUT, f"icon{s}.png"))
