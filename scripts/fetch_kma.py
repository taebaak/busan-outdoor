"""기상청 단기예보를 받아 data/forecast.json으로 저장한다.

실행:  python scripts/fetch_kma.py
필요:  busan-outdoor/.env 파일에  KMA_SERVICE_KEY=발급받은키  (GitHub에 올라가지 않음)

- 행정동 중심점을 기상청 5km 격자(nx, ny)로 바꾼 뒤, 부산에 걸친 격자 칸마다 한 번씩 호출한다
- 단기예보는 하루 8번(02, 05, 08, 11, 14, 17, 20, 23시) 발표되고 약 10분 뒤부터 받을 수 있다
"""
import json, math, os, sys, time, urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
KST = timezone(timedelta(hours=9))
URL = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst"


def load_key():
    key = os.environ.get("KMA_SERVICE_KEY", "").strip()
    env = HERE / ".env"
    if not key and env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.strip().startswith("KMA_SERVICE_KEY="):
                key = line.split("=", 1)[1].strip().strip('"').strip("'")
    if not key:
        sys.exit("인증키가 없습니다. busan-outdoor/.env 파일에 KMA_SERVICE_KEY=키 를 넣어 주세요.")
    return key


def to_grid(lat, lon):
    """위경도 → 기상청 격자 (기상청 람베르트 정각원추도법 변환식)"""
    RE, GRID, SLAT1, SLAT2, OLON, OLAT, XO, YO = 6371.00877, 5.0, 30.0, 60.0, 126.0, 38.0, 43, 136
    D = math.pi / 180
    re = RE / GRID
    s1, s2, olon, olat = SLAT1 * D, SLAT2 * D, OLON * D, OLAT * D
    sn = math.log(math.cos(s1) / math.cos(s2)) / math.log(math.tan(math.pi / 4 + s2 / 2) / math.tan(math.pi / 4 + s1 / 2))
    sf = math.tan(math.pi / 4 + s1 / 2) ** sn * math.cos(s1) / sn
    ro = re * sf / math.tan(math.pi / 4 + olat / 2) ** sn
    ra = re * sf / math.tan(math.pi / 4 + lat * D / 2) ** sn
    theta = (lon * D - olon + math.pi) % (2 * math.pi) - math.pi
    theta *= sn
    return int(ra * math.sin(theta) + XO + 0.5), int(ro - ra * math.cos(theta) + YO + 0.5)


def latest_base(now):
    """지금 받을 수 있는 가장 최근 발표 시각 (발표 후 15분 여유)"""
    t = now - timedelta(minutes=15)
    for h in (23, 20, 17, 14, 11, 8, 5, 2):
        if t.hour >= h:
            return t.replace(hour=h, minute=0, second=0, microsecond=0)
    return (t - timedelta(days=1)).replace(hour=23, minute=0, second=0, microsecond=0)


def parse_pcp(v):
    """강수량 문자열 → mm 숫자 ('강수없음', '1.0mm 미만', '30.0~50.0mm', '50.0mm 이상')"""
    v = str(v)
    if "없음" in v:
        return 0.0
    if "미만" in v:
        return 0.5
    v = v.replace("mm", "").replace("이상", "").strip()
    if "~" in v:
        a, b = v.split("~")
        return (float(a) + float(b)) / 2
    try:
        return float(v)
    except ValueError:
        return None


def fetch_cell(key, base, nx, ny):
    """한 격자 칸의 예보 전체. 예보 기간이 길면(최대 그글피) 여러 페이지로 나눠 받는다."""
    items, page, per = [], 1, 1000
    while True:
        body = fetch_page(key, base, nx, ny, page, per)
        got = body["items"]["item"] if body.get("items") else []
        items += got
        if len(items) >= int(body.get("totalCount", 0)) or not got:
            return items
        page += 1


def fetch_page(key, base, nx, ny, page, per):
    # 디코딩 키는 주소용으로 인코딩하고, 이미 인코딩된 키(% 포함)는 그대로 쓴다
    k = key if "%" in key else urllib.parse.quote(key, safe="")
    q = urllib.parse.urlencode({
        "pageNo": page, "numOfRows": per, "dataType": "JSON",
        "base_date": base.strftime("%Y%m%d"), "base_time": base.strftime("%H%M"), "nx": nx, "ny": ny,
    })
    url = f"{URL}?serviceKey={k}&{q}"
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=20) as r:
                body = r.read().decode("utf-8")
            data = json.loads(body)
            head = data["response"]["header"]
            if head["resultCode"] != "00":
                raise RuntimeError(f"{head['resultCode']} {head['resultMsg']}")
            return data["response"]["body"]
        except json.JSONDecodeError:
            # 키 오류 등은 JSON이 아닌 XML로 돌아온다
            raise RuntimeError("응답이 JSON이 아닙니다. 인증키를 확인하세요: " + body[:200])
        except Exception:
            if attempt == 2:
                raise
            time.sleep(1.5)


def main():
    key = load_key()
    dongs = json.load(open(HERE / "data" / "dongs.geojson", encoding="utf-8"))["features"]
    dong_cell = {}
    for f in dongs:
        p = f["properties"]
        dong_cell[p["code"]] = "%d,%d" % to_grid(p["lat"], p["lon"])
    cells = sorted(set(dong_cell.values()))

    base = latest_base(datetime.now(KST))
    print(f"발표 시각 {base:%Y-%m-%d %H:%M}, 격자 {len(cells)}칸 요청")

    by_cell, all_times = {}, set()
    for i, c in enumerate(cells, 1):
        nx, ny = map(int, c.split(","))
        items = fetch_cell(key, base, nx, ny)
        rows = {}
        for it in items:
            t = it["fcstDate"] + it["fcstTime"]
            rows.setdefault(t, {})[it["category"]] = it["fcstValue"]
        by_cell[c] = rows
        all_times |= set(rows)
        print(f"  {i}/{len(cells)} ({c}) {len(rows)}시간")
        time.sleep(0.15)

    times = sorted(t for t in all_times if all("TMP" in by_cell[c].get(t, {}) for c in cells))
    # 뒤쪽(글피 이후)은 3시간 간격이라 1시간 간격이 이어지는 구간까지만 쓴다
    for i in range(1, len(times)):
        gap = datetime.strptime(times[i], "%Y%m%d%H%M") - datetime.strptime(times[i - 1], "%Y%m%d%H%M")
        if gap > timedelta(hours=1):
            times = times[:i]
            break
    # 마지막 칸이 다음 날 0시 하나뿐이면 그날은 빼서 날짜가 23시에서 끝나게 한다
    if times and times[-1].endswith("0000"):
        times = times[:-1]

    def num(v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    out_cells = {}
    for c in cells:
        out_cells[c] = []
        for t in times:
            r = by_cell[c][t]
            out_cells[c].append({
                "temp": num(r.get("TMP")), "rh": num(r.get("REH")), "pop": num(r.get("POP")),
                "pcp": parse_pcp(r.get("PCP", "강수없음")), "sky": num(r.get("SKY")), "pty": num(r.get("PTY")),
                "wind": num(r.get("WSD")), "vec": num(r.get("VEC")),
            })

    out = {
        "source": "기상청 단기예보",
        "base": base.strftime("%Y-%m-%dT%H:%M:00+09:00"),
        "generated": datetime.now(KST).strftime("%Y-%m-%dT%H:%M:%S+09:00"),
        "times": [f"{t[:4]}-{t[4:6]}-{t[6:8]}T{t[8:10]}:{t[10:12]}:00+09:00" for t in times],
        "dongCell": dong_cell,
        "cells": out_cells,
    }
    path = HERE / "data" / "forecast.json"
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"저장: {path} ({len(times)}시간, {out['times'][0]} ~ {out['times'][-1]})")


if __name__ == "__main__":
    main()
