# 부산 야외활동 날씨지도

부산 206개 행정동의 시간대별 날씨를 지도로 보여주는 웹사이트입니다. 축소하면 구별 평균, 확대하면 행정동별 값을 보여주고, 시간 막대와 하단 시간별 표로 앞으로 약 2~3일의 예보를 확인할 수 있습니다.

- 레이어: 기온, 체감온도, 바람(풍속·풍향), 강수확률, 자외선, 미세먼지(PM10), 초미세먼지(PM2.5)
- 예보: 기상청 단기예보 (5km 격자, 1시간 간격)
- 자외선: 기상청 생활기상지수 (부산 전체 같은 값, 3시간 간격을 1시간 간격으로 보간)
- 미세먼지: 에어코리아. 지금 시각은 부산 측정소 35곳 값을 거리 가중 보간(IDW)해 행정동 값을 추정하고, 앞으로는 하루 단위 예보 등급을 표시합니다.
- 갱신: GitHub Actions가 매시 25분에 모든 자료를 받아 사이트에 반영합니다.
- 배경지도: 브이월드
- 경계: 행정동 경계 2025.01.01 기준. 구 경계와 부산 외곽선은 행정동 경계를 합쳐 만들었습니다.
- 체감온도: 기상청 산출식(여름: 기온·습도, 겨울: 기온·바람)으로 계산합니다.

## 폴더 구조

```
index.html            화면
css/style.css         꾸미기
js/weather.js         예보 불러오기, 체감온도 계산, 색 단계
js/app.js             지도, 라벨, 시간 막대, 시간별 표, 자동 갱신
data/dongs.geojson    행정동 경계 (웹용)
data/gus.geojson      구 경계
data/busan.geojson    부산 외곽선
data/forecast.json    기상청 단기예보 (자동 갱신)
data/uv.json          자외선지수 예보 (자동 갱신)
data/air.json         미세먼지 측정값과 예보 등급 (자동 갱신)
data/stations.json    미세먼지 측정소 위치
scripts/build_dongs.py  경계 데이터 만들기
scripts/fetch_kma.py    기상청 예보 받기
scripts/fetch_extra.py  자외선·미세먼지 받기
scripts/dev_server.py   개발용 서버
```

## 내 컴퓨터에서 실행

1. `config.example.js`를 복사해 `config.js`를 만들고 브이월드 키를 넣습니다.
2. `.env`에 `KMA_SERVICE_KEY=공공데이터포털 키`를 넣고 예보를 받습니다.
   ```
   python scripts/fetch_kma.py
   python scripts/fetch_extra.py
   ```
3. 개발 서버를 켜고 http://localhost:8000 을 엽니다.
   ```
   python scripts/dev_server.py
   ```
