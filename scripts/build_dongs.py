"""행정동 경계를 웹 지도용 GeoJSON(data/dongs.geojson)으로 만든다.

- 원본: ../data/HangJeongDong_ver20250101.geojson (졸업논문에 쓴 2025.01.01 경계)
- 좌표 단순화(Douglas-Peucker)와 소수점 5자리 반올림으로 용량을 줄인다
- 동마다 라벨 위치(가장 큰 폴리곤의 무게중심)와 라벨 우선순위를 넣는다
"""
import json, math
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
SRC = HERE.parent / "data" / "HangJeongDong_ver20250101.geojson"
OUT = HERE / "data" / "dongs.geojson"
TOL = 0.00008  # 도 단위, 약 8m

def dp(pts, tol):
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = pts[a], pts[b]
        dx, dy = bx - ax, by - ay
        L = math.hypot(dx, dy)
        best, idx = -1.0, None
        for i in range(a + 1, b):
            px, py = pts[i]
            d = math.hypot(px - ax, py - ay) if L < 1e-12 else abs(dy * px - dx * py + bx * ay - by * ax) / L
            if d > best:
                best, idx = d, i
        if idx is not None and best > tol:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(pts, keep) if k]

def simplify_ring(ring):
    out = []
    for x, y in dp(ring, TOL):
        p = [round(x, 5), round(y, 5)]
        if not out or out[-1] != p:
            out.append(p)
    if out[0] != out[-1]:
        out.append(out[0])
    return out if len(out) >= 4 else None

def ring_area_centroid(ring):
    a = cx = cy = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        f = x1 * y2 - x2 * y1
        a += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f
    if abs(a) < 1e-15:
        return 0.0, ring[0][0], ring[0][1]
    return abs(a / 2), cx / (3 * a), cy / (3 * a)

src = json.load(open(SRC, encoding="utf-8"))
features = []
for f in src["features"]:
    p = f["properties"]
    polys = f["geometry"]["coordinates"] if f["geometry"]["type"] == "MultiPolygon" else [f["geometry"]["coordinates"]]
    new_polys, best = [], (0, None, None)
    for poly in polys:
        rings = [r for r in (simplify_ring(r) for r in poly) if r]
        if not rings:
            continue
        new_polys.append(rings)
        area, cx, cy = ring_area_centroid(poly[0])
        if area > best[0]:
            best = (area, cx, cy)
    features.append({
        "type": "Feature",
        "properties": {
            "code": p["adm_cd2"], "gu": p["sggnm"], "dong": p["adm_nm"].split()[-1],
            "lat": round(best[2], 5), "lon": round(best[1], 5), "area": best[0],
        },
        "geometry": {"type": "MultiPolygon", "coordinates": new_polys},
    })

# 라벨 우선순위: 구마다 면적이 가장 큰 동이 1순위(축소해도 보임), 나머지는 면적 순
by_gu = {}
for f in features:
    by_gu.setdefault(f["properties"]["gu"], []).append(f)
for fs in by_gu.values():
    fs.sort(key=lambda f: -f["properties"]["area"])
    for i, f in enumerate(fs):
        f["properties"]["rep"] = 1 if i == 0 else 0
features.sort(key=lambda f: (-f["properties"]["rep"], -f["properties"]["area"]))
for i, f in enumerate(features):
    f["properties"]["prio"] = i
    del f["properties"]["area"]

OUT.parent.mkdir(exist_ok=True)
OUT.write_text(json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print(len(features), "dongs,", round(OUT.stat().st_size / 1024), "KB")


# ---------- 구 경계와 부산 외곽선 ----------
# 이웃한 행정동은 경계선(꼭짓점)을 공유한다. 묶음 안에서 한 번만 나오는 선분이 묶음의 바깥 경계다.
# (QGIS의 '디졸브'와 같은 결과를 원본 좌표로 직접 만든다)
def key(pt):
    return (round(pt[0], 7), round(pt[1], 7))

def outer_rings(geoms):
    count = {}
    for polys in geoms:
        for poly in polys:
            for ring in poly:
                for a, b in zip(ring, ring[1:]):
                    a, b = key(a), key(b)
                    if a == b:
                        continue
                    k = (a, b) if a < b else (b, a)
                    count[k] = count.get(k, 0) + 1
    adj = {}
    for (a, b), c in count.items():
        if c == 1:
            adj.setdefault(a, []).append(b)
            adj.setdefault(b, []).append(a)
    rings = []
    while adj:
        start = next(iter(adj))
        ring, prev, cur = [start], None, start
        while True:
            nbrs = adj.get(cur, [])
            nxt = next((n for n in nbrs if n != prev), nbrs[0] if nbrs else None)
            if nxt is None:
                break
            adj[cur].remove(nxt); adj[nxt].remove(cur)
            if not adj[cur]: del adj[cur]
            if not adj[nxt]: del adj[nxt]
            ring.append(nxt)
            prev, cur = cur, nxt
            if cur == start:
                break
        if len(ring) >= 4 and ring[0] == ring[-1]:
            rings.append([list(p) for p in ring])
    return rings

orig = {f["properties"]["adm_cd2"]: (f["geometry"]["coordinates"] if f["geometry"]["type"] == "MultiPolygon" else [f["geometry"]["coordinates"]])
        for f in src["features"]}

def point_in_ring(x, y, ring):
    inside = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside

def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))

def polylabel(ring, k=math.cos(math.radians(35.2))):
    """다각형 안에서 경계로부터 가장 먼 점 (시각적 중앙). 경도는 위도 보정."""
    pts = [(x * k, y) for x, y in ring]
    def dist(x, y):
        d = min(seg_dist(x, y, *a, *b) for a, b in zip(pts, pts[1:]))
        return d if point_in_ring(x, y, pts) else -d
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    best, best_d = None, -1e9
    # 거친 격자 → 가장 좋은 점 주변을 점점 촘촘히
    cx0, cy0, w, h = min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)
    n = 40
    for _ in range(4):
        for i in range(n + 1):
            for j in range(n + 1):
                x, y = cx0 + w * i / n, cy0 + h * j / n
                d = dist(x, y)
                if d > best_d:
                    best, best_d = (x, y), d
        w, h = w / 5, h / 5
        cx0, cy0 = best[0] - w / 2, best[1] - h / 2
    return best[0] / k, best[1]

gu_feats = []
for gu, fs in by_gu.items():
    rings = [r for r in (simplify_ring(r) for r in outer_rings([orig[f["properties"]["code"]] for f in fs])) if r]
    # 라벨 위치: 가장 큰 땅덩어리의 시각적 중앙 (오목한 모양이어도 안쪽에 찍힘)
    big = max(rings, key=lambda r: ring_area_centroid(r)[0])
    lx, ly = polylabel(big)
    gu_feats.append({
        "type": "Feature",
        "properties": {"gu": gu, "lat": round(ly, 5), "lon": round(lx, 5)},
        "geometry": {"type": "MultiPolygon", "coordinates": [[r] for r in rings]},
    })
(HERE / "data" / "gus.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": gu_feats}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

busan = [r for r in (simplify_ring(r) for r in outer_rings(list(orig.values()))) if r]
(HERE / "data" / "busan.geojson").write_text(json.dumps({"type": "Feature", "properties": {"name": "부산광역시"},
    "geometry": {"type": "MultiPolygon", "coordinates": [[r] for r in busan]}}, separators=(",", ":")), encoding="utf-8")
print(len(gu_feats), "gus,", len(busan), "busan outline rings")
