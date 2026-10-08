"""자외선(기상청 생활기상지수)과 미세먼지(에어코리아)를 받아 저장한다.

실행:  python scripts/fetch_extra.py
필요:  .env의 KMA_SERVICE_KEY (공공데이터포털 키 하나로 세 API 모두 사용)

만드는 파일
- data/uv.json       자외선지수 예보 (부산 전체 같은 값, 3시간 간격)
- data/air.json      측정소별 미세먼지 실시간 측정값 + 하루 단위 예보 등급
- data/stations.json 측정소 위치 (30일에 한 번만 다시 받음)

한 부분이 실패해도 나머지는 저장하고, 실패한 파일은 이전 것을 그대로 둔다.
"""
import json, sys, time, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_kma import load_key  # .env / 환경변수에서 키 읽기

HERE = Path(__file__).resolve().parent.parent
DATA = HERE / "data"
KST = timezone(timedelta(hours=9))

UV_URL = "https://apis.data.go.kr/1360000/LivingWthrIdxServiceV5/getUVIdxV5"
AIR_URL = "https://apis.data.go.kr/B552584/ArpltnInforInqireSvc"
STN_URL = "https://apis.data.go.kr/B552584/MsrstnInfoInqireSvc/getMsrstnList"


def get_json(url, key, **q):
    k = key if "%" in key else urllib.parse.quote(key, safe="")
    full = f"{url}?serviceKey={k}&" + urllib.parse.urlencode(q)
    last = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(full, timeout=40) as r:
                data = json.loads(r.read().decode("utf-8"))
            head = data["response"]["header"]
            if head["resultCode"] != "00":
                raise RuntimeError(f"{head['resultCode']} {head['resultMsg']}")
            return data["response"]["body"]
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, RuntimeError, KeyError) as e:
            last = e
            time.sleep(3)
    raise RuntimeError(f"{url.rsplit('/', 1)[-1]} 실패: {last}")


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None  # 측정값이 없으면 '-' 로 온다


def save(name, obj):
    (DATA / name).write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("저장:", name)


def fetch_uv(key, now):
    # 발표 시각(date)부터 3시간 간격 h0, h3, ... h75. 부산 어느 지역 코드로 물어도 같은 값이라 부산 전체 코드로 한 번만 받는다.
    body = get_json(UV_URL, key, pageNo=1, numOfRows=10, dataType="JSON", areaNo="2600000000", time=now.strftime("%Y%m%d%H"))
    it = body["items"]["item"][0]
    issued = datetime.strptime(it["date"], "%Y%m%d%H").replace(tzinfo=KST)
    values = []
    for h in range(0, 76, 3):
        v = num(it.get(f"h{h}"))
        if v is not None:
            values.append({"time": (issued + timedelta(hours=h)).isoformat(), "uv": v})
    save("uv.json", {"source": "기상청 생활기상지수", "issued": issued.isoformat(), "values": values})


def fetch_stations(key):
    path = DATA / "stations.json"
    if path.exists():
        old = json.loads(path.read_text(encoding="utf-8"))
        if datetime.now(KST) - datetime.fromisoformat(old["updated"]) < timedelta(days=30):
            return old["stations"]
    body = get_json(STN_URL, key, returnType="json", numOfRows=100, pageNo=1, addr="부산")
    stations = [{"name": s["stationName"], "lat": float(s["dmX"]), "lon": float(s["dmY"]), "type": s.get("mangName")}
                for s in body["items"] if s.get("dmX") and s.get("dmY")]
    save("stations.json", {"updated": datetime.now(KST).isoformat(), "stations": stations})
    return stations


def fetch_forecast(key, now):
    """하루 단위 미세먼지 예보 등급 (부산 권역). 오늘 발표분이 없으면 어제 것."""
    out = {}
    for code, field in (("PM10", "pm10"), ("PM25", "pm25")):
        for day in (now, now - timedelta(days=1)):
            body = get_json(f"{AIR_URL}/getMinuDustFrcstDspth", key, returnType="json", numOfRows=50, pageNo=1,
                            searchDate=day.strftime("%Y-%m-%d"), InformCode=code)
            items = sorted(body.get("items") or [], key=lambda x: x["dataTime"], reverse=True)
            if not items:
                continue
            latest = items[0]["dataTime"]
            for it in items:
                if it["dataTime"] != latest:
                    continue
                grade = next((g.split(":")[1].strip() for g in it["informGrade"].split(",") if g.strip().startswith("부산")), None)
                if grade:
                    out.setdefault(it["informData"], {})[field] = grade
            out.setdefault("_issued", {})[field] = latest
            break
    return out


def fetch_air(key, now):
    stations = fetch_stations(key)
    body = get_json(f"{AIR_URL}/getCtprvnRltmMesureDnsty", key, returnType="json", numOfRows=100, pageNo=1, sidoName="부산", ver="1.0")
    pos = {s["name"]: s for s in stations}
    rows, data_time = [], None
    for it in body["items"]:
        s = pos.get(it["stationName"])
        if not s:
            continue
        data_time = data_time or it["dataTime"]
        rows.append({"name": it["stationName"], "lat": s["lat"], "lon": s["lon"],
                     "pm10": num(it.get("pm10Value")), "pm25": num(it.get("pm25Value"))})
    try:
        forecast = fetch_forecast(key, now)
    except RuntimeError as e:
        print("  미세먼지 예보 실패(측정값만 저장):", e)
        old = DATA / "air.json"
        forecast = json.loads(old.read_text(encoding="utf-8")).get("forecast", {}) if old.exists() else {}
    save("air.json", {"source": "에어코리아", "dataTime": data_time.replace(" ", "T") + ":00+09:00" if data_time else None,
                      "stations": rows, "forecast": forecast})


def main():
    key = load_key()
    now = datetime.now(KST)
    ok = True
    for name, fn in (("자외선", fetch_uv), ("미세먼지", fetch_air)):
        try:
            fn(key, now)
        except Exception as e:
            ok = False
            print(f"{name} 실패, 이전 파일 유지:", e)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
