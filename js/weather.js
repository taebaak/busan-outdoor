// 날씨 데이터: 불러오기, 체감온도 계산, 레이어별 색 단계
(function () {
  "use strict";

  var HOURS = 72;
  var VARS = ["temperature_2m", "relative_humidity_2m", "precipitation_probability", "precipitation",
    "weather_code", "wind_speed_10m", "wind_direction_10m", "is_day"];

  // 1순위: 기상청 단기예보 파일 (scripts/fetch_kma.py가 만든 data/forecast.json)
  // 2순위: 파일이 없거나 지난 예보면 Open-Meteo
  // 자외선(uv.json)과 미세먼지(air.json)는 있으면 덧붙이고, 없으면 그 레이어만 비워 둔다
  function load(points) {
    var base = fetch("data/forecast.json", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("no file"); return r.json(); })
      .then(function (json) { return fromKma(json, points); })
      .catch(function () { return loadOpenMeteo(points); });
    return Promise.all([base, optional("data/uv.json"), optional("data/air.json")]).then(function (res) {
      var data = res[0];
      addUv(data, res[1]);
      addAir(data, points, res[2]);
      return data;
    });
  }
  function optional(url) {
    return fetch(url, { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }

  // ---------- 자외선: 3시간 간격 예보를 1시간 간격으로 (앞뒤 값 사이를 직선으로 채움) ----------
  function addUv(data, uv) {
    var pts = uv ? uv.values.map(function (v) { return [new Date(v.time).getTime(), v.uv]; }) : [];
    data.meta.uvIssued = uv ? uv.issued : null;
    var series = data.times.map(function (t) {
      var x = t.getTime();
      for (var i = 1; i < pts.length; i++) {
        if (x >= pts[i - 1][0] && x <= pts[i][0]) {
          var f = (x - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]);
          return pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f;
        }
      }
      return null;
    });
    data.byIndex.forEach(function (rows) { rows.forEach(function (r, h) { r.uv = series[h]; }); });
  }

  // ---------- 미세먼지 ----------
  // 지금 시각: 측정소 값을 거리 가중 보간(IDW)해서 행정동 값을 추정한다.
  // 앞으로: 공식 시간별 예보가 없으므로 그날의 부산 권역 예보 등급을 쓴다.
  var PM_LIMITS = { pm10: [30, 80, 150], pm25: [15, 35, 75] };            // 환경부 등급 경계 (좋음/보통/나쁨/매우나쁨)
  var PM_TYPICAL = { pm10: { "좋음": 15, "보통": 55, "나쁨": 115, "매우나쁨": 180 }, pm25: { "좋음": 8, "보통": 25, "나쁨": 55, "매우나쁨": 90 } };
  var GRADES = ["좋음", "보통", "나쁨", "매우나쁨"];
  function gradeOf(kind, v) {
    if (v == null) return null;
    var lim = PM_LIMITS[kind];
    return v <= lim[0] ? "좋음" : v <= lim[1] ? "보통" : v <= lim[2] ? "나쁨" : "매우나쁨";
  }
  function km(a, b) {
    var dx = (a.lon - b.lon) * 111.32 * Math.cos(a.lat * Math.PI / 180), dy = (a.lat - b.lat) * 110.57;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function idw(p, stations, kind) {
    var near = stations.filter(function (s) { return s[kind] != null; })
      .map(function (s) { return { s: s, d: km(p, s) }; })
      .sort(function (a, b) { return a.d - b.d; }).slice(0, 4)
      .filter(function (x, i) { return i === 0 || x.d <= 15; });
    if (!near.length) return null;
    if (near[0].d < 0.3) return near[0].s[kind];
    var sw = 0, sv = 0;
    near.forEach(function (x) { var w = 1 / (x.d * x.d); sw += w; sv += w * x.s[kind]; });
    return sv / sw;
  }
  function kstDate(t) { return new Date(t.getTime() + 9 * 3600e3).toISOString().slice(0, 10); }

  function addAir(data, points, air) {
    data.air = air;
    data.meta.airTime = air && air.dataTime ? new Date(air.dataTime) : null;
    var measured = data.meta.airTime ? data.meta.airTime.getTime() : null;
    data.byIndex.forEach(function (rows, i) {
      var p = points[i], est = null;
      rows.forEach(function (r, h) {
        var t = data.times[h];
        // 측정 시각과 같은 시간대(예보 첫 칸 = 지금)는 측정값, 그 뒤는 하루 단위 예보 등급
        if (measured && Math.abs(t.getTime() - measured) <= 90 * 60e3) {
          est = est || { pm10: idw(p, air.stations, "pm10"), pm25: idw(p, air.stations, "pm25") };
          r.pmMode = "측정";
          r.pm10 = est.pm10; r.pm25 = est.pm25;
          r.pm10g = gradeOf("pm10", r.pm10); r.pm25g = gradeOf("pm25", r.pm25);
        } else {
          var fc = air && air.forecast && air.forecast[kstDate(t)];
          r.pmMode = fc ? "예보" : null;
          r.pm10g = fc && fc.pm10 || null; r.pm25g = fc && fc.pm25 || null;
          r.pm10 = r.pm10g ? PM_TYPICAL.pm10[r.pm10g] : null;
          r.pm25 = r.pm25g ? PM_TYPICAL.pm25[r.pm25g] : null;
        }
      });
    });
  }

  function fromKma(json, points) {
    var times = json.times.map(function (t) { return new Date(t); });
    var now = Date.now(), start = -1;
    for (var i = 0; i < times.length; i++) { if (times[i].getTime() + 3600e3 > now) { start = i; break; } }
    if (start < 0 || times.length - start < 6) throw new Error("지난 예보");
    var meta = { source: "기상청 단기예보", base: new Date(json.base) };
    return {
      meta: meta,
      times: times.slice(start, start + HOURS),
      byIndex: points.map(function (p) {
        var cell = json.cells[json.dongCell[p.code]];
        return cell.slice(start, start + HOURS).map(function (r, k) {
          var t = times[start + k];
          var row = {
            temp: r.temp, rh: r.rh, pop: r.pop, pcp: r.pcp, wind: r.wind, vec: r.vec,
            code: kmaCode(r.sky, r.pty), day: sunAltitude(p.lat, p.lon, t) > -0.833
          };
          row.feels = feelsLike(row.temp, row.rh, row.wind, t);
          return row;
        });
      })
    };
  }

  // 기상청 하늘상태(SKY)·강수형태(PTY) → 그림용 날씨 코드(WMO 방식)
  function kmaCode(sky, pty) {
    if (pty === 3 || pty === 7) return 71;               // 눈
    if (pty >= 1) return 61;                             // 비, 비/눈, 소나기
    if (sky === 4) return 3;                             // 흐림
    if (sky === 3) return 2;                             // 구름많음
    return 0;                                            // 맑음
  }

  // 태양 고도(도). 해가 지평선 위면 낮으로 본다.
  function sunAltitude(lat, lon, date) {
    var D = Math.PI / 180;
    var d = date.getTime() / 864e5 - 10957.5;            // 2000-01-01 12:00 UTC 기준 일수
    var g = (357.529 + 0.98560028 * d) * D;
    var q = 280.459 + 0.98564736 * d;
    var L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D;
    var e = (23.439 - 0.00000036 * d) * D;
    var ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
    var dec = Math.asin(Math.sin(e) * Math.sin(L));
    var gmst = (18.697374558 + 24.06570982441908 * d) % 24;
    var ha = (gmst * 15 + lon) * D - ra;
    return Math.asin(Math.sin(lat * D) * Math.sin(dec) + Math.cos(lat * D) * Math.cos(dec) * Math.cos(ha)) / D;
  }

  // 206개 동 중심점을 한 번에 요청한다 (Open-Meteo는 좌표 여러 개를 쉼표로 받음)
  function loadOpenMeteo(points) {
    var url = "https://api.open-meteo.com/v1/forecast" +
      "?latitude=" + points.map(function (p) { return p.lat; }).join(",") +
      "&longitude=" + points.map(function (p) { return p.lon; }).join(",") +
      "&hourly=" + VARS.join(",") +
      "&timezone=Asia%2FSeoul&forecast_days=4&wind_speed_unit=ms";
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("예보 서버 응답 " + r.status);
      return r.json();
    }).then(function (json) {
      var list = Array.isArray(json) ? json : [json];
      var times = list[0].hourly.time;
      var start = currentHourIndex(times);
      var out = {
        meta: { source: "Open-Meteo", base: null },
        times: times.slice(start, start + HOURS).map(function (t) { return new Date(t + ":00+09:00"); }),
        byIndex: list.map(function (loc) {
          var h = loc.hourly, rows = [];
          for (var i = start; i < start + HOURS && i < h.time.length; i++) {
            var row = {
              temp: h.temperature_2m[i], rh: h.relative_humidity_2m[i],
              pop: h.precipitation_probability[i], pcp: h.precipitation[i],
              code: h.weather_code[i], wind: h.wind_speed_10m[i], vec: h.wind_direction_10m[i], day: h.is_day[i] === 1
            };
            row.feels = feelsLike(row.temp, row.rh, row.wind, new Date(h.time[i] + ":00+09:00"));
            rows.push(row);
          }
          return rows;
        })
      };
      return out;
    });
  }

  function currentHourIndex(times) {
    var now = new Date();
    for (var i = 0; i < times.length; i++) {
      var t = new Date(times[i] + ":00+09:00");
      if (t.getTime() + 3600e3 > now.getTime()) return i;
    }
    return 0;
  }

  // 기상청 체감온도 산출식
  // 여름(5~9월): 기온과 습도로 구한 습구온도 기반
  // 겨울(10~4월): 기온 10℃ 이하, 풍속 1.3m/s 이상일 때 바람냉각 식, 그 외에는 기온 그대로
  function feelsLike(ta, rh, ws, date) {
    if (ta == null || rh == null) return null;
    var month = Number(date.toLocaleString("en-US", { timeZone: "Asia/Seoul", month: "numeric" }));
    if (month >= 5 && month <= 9) {
      var tw = ta * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) + Math.atan(ta + rh) - Math.atan(rh - 1.67633) +
        0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) - 4.686035;
      return -0.2442 + 0.55399 * tw + 0.45535 * ta - 0.0022 * tw * tw + 0.00278 * tw * ta + 3.0;
    }
    if (ta <= 10 && ws >= 1.3) {
      var v = Math.pow(ws * 3.6, 0.16);
      return 13.12 + 0.6215 * ta - 11.37 * v + 0.3965 * ta * v;
    }
    return ta;
  }

  // 레이어 정의: 값 꺼내기, 색 단계, 표시 형식
  var TEMP_STOPS = [
    [-10, "#5b4a9b"], [-6, "#3f63b5"], [-2, "#3f8fd0"], [2, "#52b7d8"], [6, "#6cc7b6"], [10, "#8fcf8a"],
    [14, "#b6d86a"], [18, "#e2d64f"], [22, "#f2b63f"], [26, "#ef8a35"], [30, "#e0582f"], [34, "#b92d2b"], [38, "#7e1a2a"]
  ];
  // 풍속(m/s): 기상청 표현 기준 약한 바람(4 미만) · 약간 강한(4~9) · 강한(9~14) · 매우 강한(14 이상)
  var WIND_STOPS = [[0, "#f3f8f9"], [2, "#d3eaf0"], [4, "#a6d3df"], [7, "#68b2c7"], [9, "#3b8fae"], [14, "#1d4e63"], [18, "#2b2a5c"]];
  var POP_STOPS = [[0, "#ffffff"], [20, "#d7e9f7"], [40, "#a9d0ef"], [60, "#6aaee0"], [80, "#2f7fc1"], [100, "#1b4f8a"]];

  function hex(c) { return [1, 3, 5].map(function (i) { return parseInt(c.substr(i, 2), 16); }); }
  function mix(a, b, t) {
    var x = hex(a), y = hex(b);
    return "rgb(" + x.map(function (v, i) { return Math.round(v + (y[i] - v) * t); }).join(",") + ")";
  }
  // step 간격으로 구간을 나눠 그 구간의 색을 돌려준다 (네이버처럼 경계가 뚜렷한 단계 색)
  function stepped(stops, step) {
    return function (v) {
      if (v == null) return "#cccccc";
      var s = Math.floor(v / step) * step + step / 2;
      if (s <= stops[0][0]) return stops[0][1];
      for (var i = 1; i < stops.length; i++) {
        if (s <= stops[i][0]) return mix(stops[i - 1][1], stops[i][1], (s - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]));
      }
      return stops[stops.length - 1][1];
    };
  }

  // 미세먼지 등급색: 좋음 파랑 · 보통 초록 · 나쁨 주황 · 매우나쁨 빨강 (에어코리아 관례)
  var PM_COLORS = { "좋음": "#4a90e2", "보통": "#3fbf6f", "나쁨": "#f2a33a", "매우나쁨": "#e0503a" };

  var LAYERS = {
    temp: { name: "기온", unit: "°", get: function (r) { return r.temp; }, color: stepped(TEMP_STOPS, 2),
      fmt: function (v) { return Math.round(v) + "°"; }, legend: [0, 10, 20, 30], opacity: 0.55 },
    feels: { name: "체감온도", unit: "°", get: function (r) { return r.feels; }, color: stepped(TEMP_STOPS, 2),
      fmt: function (v) { return Math.round(v) + "°"; }, legend: [0, 10, 20, 30], opacity: 0.55 },
    wind: { name: "바람", unit: "m/s", get: function (r) { return r.wind; }, color: stepped(WIND_STOPS, 1),
      fmt: function (v) { return v.toFixed(1) + "m/s"; }, short: function (v) { return v.toFixed(1); }, legend: [0, 4, 9, 14], opacity: 0.6,
      dir: function (r) { return r.vec; } },
    pop: { name: "강수확률", unit: "%", get: function (r) { return r.pop; }, color: stepped(POP_STOPS, 10),
      fmt: function (v) { return Math.round(v) + "%"; }, legend: [0, 30, 60, 90], opacity: 0.6 },
    uv: uvLayer(),
    pm10: pmLayer("pm10", "미세먼지"),
    pm25: pmLayer("pm25", "초미세먼지")
  };

  // 자외선지수: 기상청 5단계 (낮음 0~2, 보통 3~5, 높음 6~7, 매우높음 8~10, 위험 11 이상)
  function uvLayer() {
    var steps = [[2, "낮음", "#7bc47f"], [5, "보통", "#f2d24b"], [7, "높음", "#f29b3c"], [10, "매우높음", "#e0533a"], [99, "위험", "#8e44ad"]];
    function stage(v) { var r = Math.round(v); for (var i = 0; i < steps.length; i++) if (r <= steps[i][0]) return steps[i]; }
    return {
      name: "자외선", unit: "", opacity: 0.55, get: function (r) { return r.uv; },
      color: function (v) { return v == null ? "#cccccc" : stage(v)[2]; },
      fmt: function (v) { return v == null ? "-" : Math.round(v) + " " + stage(v)[1]; },
      short: function (v) { return v == null ? "-" : String(Math.round(v)); },
      items: steps.map(function (s) { return [s[1], s[2]]; }),
      note: function () { return "부산 전체 같은 예보 (기상청 생활기상지수)"; }
    };
  }

  function pmLayer(kind, name) {
    var g = kind + "g";
    return {
      name: name, unit: "㎍/㎥", opacity: 0.55, kind: kind,
      get: function (r) { return r[kind]; },
      color: function (v, r) { var gr = r ? r[g] : gradeOf(kind, v); return gr ? PM_COLORS[gr] : "#cccccc"; },
      fmt: function (v) { return v == null ? "-" : Math.round(v) + " " + gradeOf(kind, v); },
      // 예보 구간은 숫자가 아니라 등급만 의미가 있으므로 등급만 보여준다
      text: function (r) { return r[kind] == null ? "-" : r.pmMode === "예보" ? r[g] : Math.round(r[kind]) + " " + r[g]; },
      short: function (v, r) { return r && r.pmMode === "예보" ? r[g] : v == null ? "-" : String(Math.round(v)); },
      items: GRADES.map(function (gr) { return [gr, PM_COLORS[gr]]; }),
      note: function (r) { return !r || !r.pmMode ? "자료 없음" : r.pmMode === "측정" ? "측정소 값으로 추정 (에어코리아)" : "하루 단위 예보 등급 (에어코리아)"; }
    };
  }

  window.Weather = { load: load, LAYERS: LAYERS, HOURS: HOURS, gradeOf: gradeOf, PM_COLORS: PM_COLORS };
})();
