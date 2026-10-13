"""부산 도시철도 노선·역을 OpenStreetMap에서 받아 data/subway.geojson으로 저장한다 (한 번만 실행하면 됨).

- 1~4호선, 부산김해경전철, 동해선 광역전철
- 노선은 방향별로 두 번 등록돼 있어 같은 선로(way)는 한 번만 그린다
- 노선 색은 OpenStreetMap에 적힌 공식 색을 쓴다
데이터: © OpenStreetMap contributors (ODbL)
"""
import json, time, urllib.parse, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
BBOX = "34.95,128.75,35.45,129.35"
QUERY = f"""[out:json][timeout:120];
relation["route"~"^(subway|light_rail|train|monorail)$"]["name"~"부산 도시철도|부산김해경전철|동해선 광역전철"]({BBOX});
out geom;"""
SERVERS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
ORDER = {"1": 1, "2": 2, "3": 3, "4": 4, "BGL": 5, "동해": 6}


def query():
    last = None
    for attempt in range(3):
        for url in SERVERS:
            try:
                req = urllib.request.Request(url, data=urllib.parse.urlencode({"data": QUERY}).encode(),
                                             headers={"User-Agent": "busan-outdoor-map"})
                return json.load(urllib.request.urlopen(req, timeout=150))
            except Exception as e:
                last = e
        time.sleep(10)
    raise RuntimeError(f"OpenStreetMap 서버 응답 없음: {last}")


def main():
    data = query()
    lines, stations, seen_way, seen_stn = {}, [], set(), set()
    for rel in data["elements"]:
        t = rel.get("tags", {})
        ref = t.get("ref") or t.get("name", "")
        name = t.get("name", "").split(":")[0].strip()
        line = lines.setdefault(ref, {"ref": ref, "name": name, "colour": t.get("colour", "#666666"), "coords": []})
        for m in rel.get("members", []):
            if m["type"] == "way" and m.get("geometry") and m["role"] in ("", "forward", "backward"):
                if m["ref"] in seen_way:
                    continue
                seen_way.add(m["ref"])
                line["coords"].append([[round(p["lon"], 5), round(p["lat"], 5)] for p in m["geometry"]])
            elif m["type"] == "node" and m["role"].startswith("stop") and "lat" in m:
                key = (ref, round(m["lat"], 3), round(m["lon"], 3))
                if key not in seen_stn:
                    seen_stn.add(key)
                    stations.append({"ref": ref, "colour": line["colour"], "lat": round(m["lat"], 5), "lon": round(m["lon"], 5)})

    feats = []
    for ln in sorted(lines.values(), key=lambda l: ORDER.get(l["ref"], 9)):
        if ln["coords"]:
            feats.append({"type": "Feature", "properties": {"kind": "line", "ref": ln["ref"], "name": ln["name"], "colour": ln["colour"]},
                          "geometry": {"type": "MultiLineString", "coordinates": ln["coords"]}})
    for s in stations:
        feats.append({"type": "Feature", "properties": {"kind": "station", "ref": s["ref"], "colour": s["colour"]},
                      "geometry": {"type": "Point", "coordinates": [s["lon"], s["lat"]]}})
    out = HERE / "data" / "subway.geojson"
    out.write_text(json.dumps({"type": "FeatureCollection", "attribution": "© OpenStreetMap contributors", "features": feats},
                              ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    for ln in sorted(lines.values(), key=lambda l: ORDER.get(l["ref"], 9)):
        print(f"  {ln['ref']:>4} {ln['name']} {ln['colour']} 선로 {len(ln['coords'])}개")
    print(f"저장: {out} (역 {len(stations)}곳, {out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
