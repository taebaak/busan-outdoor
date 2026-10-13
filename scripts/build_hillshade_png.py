"""음영기복도(회색 PNG)를 지도 위에 겹치기 좋은 반투명 이미지로 바꾼다.

입력:  ../data/slope/hillshade_3857.png, hillshade_3857.json  (build_terrain.ps1 결과)
출력:  data/hillshade.png   그림자는 어둡게, 햇빛 받는 면은 살짝 밝게, 평지와 부산 밖은 투명
       data/hillshade.json  이미지가 놓일 위경도 범위

음영기복 값은 평지에서 약 180(= 255 × sin 45°)이다. 이보다 어두우면 그늘진 비탈, 밝으면 햇빛 받는 비탈.
"""
import json, math
from pathlib import Path
import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent.parent
SRC = HERE.parent / "data" / "slope"
FLAT = 255 * math.sin(math.radians(45))

img = Image.open(SRC / "hillshade_3857.png")
arr = np.asarray(img.convert("LA"), dtype=np.float32)
gray, valid = arr[..., 0], arr[..., 1] > 0

shadow = np.clip((FLAT - gray) / FLAT, 0, 1)            # 0~1, 그늘 정도
light = np.clip((gray - FLAT) / (255 - FLAT), 0, 1)     # 0~1, 햇빛 정도
out = np.zeros(gray.shape + (4,), dtype=np.uint8)
# 그늘: 짙은 남색 계열, 햇빛: 흰색. 둘 중 큰 쪽만 칠한다.
is_shadow = shadow >= light
out[..., 0] = np.where(is_shadow, 20, 255)
out[..., 1] = np.where(is_shadow, 30, 255)
out[..., 2] = np.where(is_shadow, 45, 255)
alpha = np.where(is_shadow, shadow ** 0.8 * 0.85, light * 0.45) * 255
out[..., 3] = np.where(valid, alpha, 0).astype(np.uint8)

dst = HERE / "data" / "hillshade.png"
Image.fromarray(out, "RGBA").save(dst, optimize=True)

# 범위: EPSG:3857 모서리 좌표 → 위경도
info = json.loads((SRC / "hillshade_3857.json").read_text(encoding="utf-8-sig"))
cc = info["cornerCoordinates"]
R = 6378137.0
def lonlat(x, y):
    return x / R * 180 / math.pi, (2 * math.atan(math.exp(y / R)) - math.pi / 2) * 180 / math.pi
west, north = lonlat(*cc["upperLeft"])
east, south = lonlat(*cc["lowerRight"])
(HERE / "data" / "hillshade.json").write_text(json.dumps(
    {"south": round(south, 6), "west": round(west, 6), "north": round(north, 6), "east": round(east, 6)}), encoding="utf-8")
print(f"저장: {dst} ({dst.stat().st_size // 1024} KB, {out.shape[1]}x{out.shape[0]})")
