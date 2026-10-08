(function () {
  "use strict";

  var KEY = (window.APP_CONFIG && window.APP_CONFIG.VWORLD_KEY || "").trim();
  var LAYERS = Weather.LAYERS;
  var GU_MAX_ZOOM = 11;   // 이 배율 이하에서는 구 단위로 보여준다
  var ALL_LABEL_ZOOM = 13; // 이 배율 이상에서는 행정동 라벨을 모두 보여준다

  var state = {
    layer: "temp",     // 지금 칠하는 날씨 레이어 (없음이면 null)
    hour: 0,           // 지도에 표시 중인 시각 (0 = 지금)
    selected: null,    // 선택한 행정동
    labels: true,
    data: null
  };

  // ---------- 지도와 배경지도 ----------
  var map = L.map("map", { minZoom: 10, maxZoom: 19, maxBoundsViscosity: 1.0 }).setView([35.12, 129.06], 11);
  map.createPane("mask").style.zIndex = 350;      // 배경지도(200) 위, 색 면(400) 아래
  map.createPane("guLines").style.zIndex = 450;   // 행정동 색 면 위에 구 경계선
  map.createPane("selLine").style.zIndex = 455;   // 선택한 행정동 테두리
  map.createPane("hoverLine").style.zIndex = 460; // 마우스를 올린 지역 테두리 (가장 위)
  ["guLines", "selLine", "hoverLine"].forEach(function (p) { map.getPane(p).style.pointerEvents = "none"; });

  var VWORLD_ATTR = '&copy; <a href="https://www.vworld.kr" target="_blank" rel="noopener">VWorld</a>';
  function vworld(layer, ext) {
    return L.tileLayer("https://api.vworld.kr/req/wmts/1.0.0/" + KEY + "/" + layer + "/{z}/{y}/{x}." + ext,
      { maxZoom: 19, attribution: VWORLD_ATTR });
  }
  var basemaps = KEY ? {
    "흰색": vworld("white", "png"), "기본": vworld("Base", "png"),
    "위성": vworld("Satellite", "jpeg"), "야간": vworld("midnight", "png")
  } : {
    "OpenStreetMap": L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" })
  };
  var currentBase = null;
  var baseEl = document.getElementById("basemap-switch");
  Object.keys(basemaps).forEach(function (name, i) {
    var b = document.createElement("button");
    b.type = "button"; b.textContent = name;
    b.addEventListener("click", function () { useBase(name); });
    baseEl.appendChild(b);
    if (i === 0) useBase(name);
  });
  function useBase(name) {
    if (currentBase) map.removeLayer(currentBase);
    currentBase = basemaps[name].addTo(map);
    Array.prototype.forEach.call(baseEl.children, function (b) {
      b.setAttribute("aria-pressed", b.textContent === name ? "true" : "false");
    });
  }

  var statusEl = document.getElementById("status");
  function showStatus(msg) { statusEl.hidden = !msg; statusEl.textContent = msg || ""; }

  // ---------- 레이어 패널 ----------
  var radios = document.getElementById("weather-radios");
  Object.keys(LAYERS).concat([null]).forEach(function (key) {
    var lab = document.createElement("label"); lab.className = "opt";
    lab.innerHTML = '<input type="radio" name="wlayer" id="wl-' + (key || "none") + '"' + (key === state.layer ? " checked" : "") + '> ' +
      (key ? LAYERS[key].name : "없음");
    lab.querySelector("input").addEventListener("change", function () { state.layer = key; render(); });
    radios.appendChild(lab);
  });
  document.getElementById("show-labels").addEventListener("change", function (e) { state.labels = e.target.checked; placeLabels(); });
  var layersEl = document.getElementById("layers");
  document.getElementById("layers-toggle").addEventListener("click", function (e) {
    var open = layersEl.getAttribute("data-open") === "false";
    layersEl.setAttribute("data-open", open ? "true" : "false");
    e.currentTarget.setAttribute("aria-expanded", open ? "true" : "false");
  });
  if (window.innerWidth <= 640) layersEl.setAttribute("data-open", "false");

  // ---------- 경계 불러오기 ----------
  var dongs = [], gus = [];
  var dongLayer, guFill, guLines;

  // 경계선 4단계: 행정동(얇은 회색) < 구(굵은 검정) < 선택(자주색) < 마우스(파란색, 가장 굵게)
  var DONG_LINE = { color: "#3d474d", weight: 0.9, opacity: 0.55 };
  var GU_LINE = { color: "#1b2328", weight: 1.8, opacity: 0.8 };
  var SEL_LINE = { color: "#c2255c", weight: 3, opacity: 1, fill: false };
  var HOVER_LINE = { color: "#1c7ed6", weight: 4.5, opacity: 1, fill: false };

  var hoverLayer = L.geoJSON(null, { pane: "hoverLine", interactive: false, style: HOVER_LINE }).addTo(map);
  var selLayer = L.geoJSON(null, { pane: "selLine", interactive: false, style: SEL_LINE }).addTo(map);
  function hover(feature) { hoverLayer.clearLayers(); if (feature) hoverLayer.addData(feature); }

  function getJSON(url) { return fetch(url).then(function (r) { return r.json(); }); }

  Promise.all([getJSON("data/dongs.geojson"), getJSON("data/gus.geojson"), getJSON("data/busan.geojson")]).then(function (res) {
    var dongGeo = res[0], guGeo = res[1], busanGeo = res[2];

    // 부산 밖은 흰 막으로 가린다: 세계 전체 사각형에 부산 모양 구멍을 뚫은 다각형
    var holes = busanGeo.geometry.coordinates.map(function (poly) {
      return poly[0].map(function (c) { return [c[1], c[0]]; });
    });
    L.polygon([[[-89, -179], [89, -179], [89, 179], [-89, 179]]].concat(holes), {
      pane: "mask", interactive: false, stroke: false, fillColor: "#f4f6f7", fillOpacity: 0.78
    }).addTo(map);
    var outline = L.geoJSON(busanGeo, { pane: "guLines", interactive: false, style: { color: "#1b2328", weight: 2, fill: false } }).addTo(map);

    // 부산 밖으로 끌고 갈 수 없게 범위를 묶는다.
    // 아래쪽은 시간 패널에 가리므로 남쪽 여유를 크게 줘서 영도·가덕도·다대포까지 끌어올릴 수 있게 한다.
    var b = outline.getBounds();
    var latSpan = b.getNorth() - b.getSouth(), lonSpan = b.getEast() - b.getWest();
    map.setMaxBounds(L.latLngBounds(
      [b.getSouth() - latSpan * 0.55, b.getWest() - lonSpan * 0.08],
      [b.getNorth() + latSpan * 0.1, b.getEast() + lonSpan * 0.08]));
    // 처음 화면: 아래 패널을 뺀 영역에 부산 전체가 들어오게
    var bottomH = document.querySelector(".bottom").offsetHeight;
    map.fitBounds(b, { paddingTopLeft: [20, 56], paddingBottomRight: [20, bottomH + 16] });
    map.setMinZoom(map.getZoom());

    // 행정동 (확대했을 때)
    dongLayer = L.geoJSON(dongGeo, {
      style: function () { return Object.assign({ fillOpacity: 0 }, DONG_LINE); },
      onEachFeature: function (f, layer) {
        var d = { props: f.properties, layer: layer, rows: null, name: f.properties.dong };
        d.label = makeLabel(f.properties.lat, f.properties.lon);
        layer.on("click", function () { select(d); });
        layer.on("mouseover", function () { hover(f); });
        layer.on("mouseout", function () { hover(null); });
        d.feature = f;
        dongs.push(d);
      }
    });

    // 구 (축소했을 때): 색 면은 구 평균, 경계선은 확대해도 항상 위에 보인다
    guFill = L.geoJSON(guGeo, {
      style: Object.assign({ fillOpacity: 0 }, GU_LINE),
      onEachFeature: function (f, layer) {
        var g = { props: f.properties, layer: layer, name: f.properties.gu, dongs: [] };
        g.label = makeLabel(f.properties.lat, f.properties.lon);
        layer.on("click", function () { hover(null); map.fitBounds(layer.getBounds(), { maxZoom: 13 }); });
        layer.on("mouseover", function () { hover(f); });
        layer.on("mouseout", function () { hover(null); });
        gus.push(g);
      }
    });
    guLines = L.geoJSON(guGeo, { pane: "guLines", interactive: false, style: Object.assign({ fill: false }, GU_LINE) });

    dongs.sort(function (a, b) { return a.props.prio - b.props.prio; });
    dongs.forEach(function (d) { gus.forEach(function (g) { if (g.name === d.props.gu) g.dongs.push(d); }); });

    applyMode();
    showStatus("예보를 불러오는 중입니다");
    return Weather.load(dongs.map(function (d) { return d.props; }));
  }).then(function (data) {
    applyData(data);
    showStatus("");
    select(dongs.filter(function (d) { return d.props.dong === "남포동"; })[0] || dongs[0], true);
    startAutoRefresh();
  }).catch(function (err) {
    showStatus("데이터를 불러오지 못했습니다. 인터넷 연결을 확인하고 새로고침하세요. (" + err.message + ")");
  });

  // 예보 데이터를 화면에 적용한다. 보고 있던 시각이 새 예보에도 있으면 그 시각을 유지한다.
  function applyData(data) {
    var keepTime = state.data ? state.data.times[state.hour].getTime() : null;
    data.byIndex.forEach(function (rows, i) { dongs[i].rows = rows; });
    // 구 값 = 소속 행정동 값의 평균
    gus.forEach(function (g) {
      g.rows = data.times.map(function (_, h) {
        var avg = {};
        ["temp", "feels", "pop"].forEach(function (k) {
          var s = 0, n = 0;
          g.dongs.forEach(function (d) { var v = d.rows[h][k]; if (v != null) { s += v; n++; } });
          avg[k] = n ? s / n : null;
        });
        return avg;
      });
    });
    state.data = data;
    state.hour = 0;
    if (keepTime) {
      data.times.forEach(function (t, i) { if (t.getTime() === keepTime) state.hour = i; });
    }
    timeInput.value = state.hour;
    var src = "예보: " + data.meta.source;
    if (data.meta.base) { var bt = kst(data.meta.base); src += " (" + bt.month + "." + bt.date + " " + bt.hour + "시 발표)"; }
    document.getElementById("source").textContent = src + " · 체감온도는 기상청 산출식으로 계산";
    setupTimebar();
    render();
  }

  // ---------- 자동 갱신 ----------
  // 열어둔 화면도 최신 상태로: 10분마다 확인해서
  //  - 정각이 지나 '지금' 시각이 바뀌었거나
  //  - 새 예보(발표 시각이 다름)가 올라왔으면 조용히 다시 불러온다.
  // 다른 탭에 가 있다가 돌아왔을 때도 바로 확인한다.
  function startAutoRefresh() {
    setInterval(checkForUpdate, 10 * 60 * 1000);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) checkForUpdate(); });
  }
  var checking = false;
  function checkForUpdate() {
    if (checking || !state.data) return;
    // Open-Meteo는 호출 수 제한이 있으므로 '지금' 시각이 바뀌었을 때만 다시 받는다
    var hourPassed = Date.now() >= state.data.times[0].getTime() + 3600e3;
    if (state.data.meta.source !== "기상청 단기예보" && !hourPassed) return;
    checking = true;
    Weather.load(dongs.map(function (d) { return d.props; })).then(function (data) {
      var oldBase = state.data.meta.base ? state.data.meta.base.getTime() : null;
      var newBase = data.meta.base ? data.meta.base.getTime() : null;
      var hourChanged = data.times[0].getTime() !== state.data.times[0].getTime();
      if (hourChanged || newBase !== oldBase || data.meta.source !== state.data.meta.source) applyData(data);
    }).catch(function (err) { console.warn("예보 갱신 실패, 다음 확인 때 다시 시도합니다:", err); })
      .then(function () { checking = false; });
  }

  function makeLabel(lat, lon) {
    return L.marker([lat, lon], { icon: L.divIcon({ className: "label-icon", html: "", iconSize: null }), interactive: false, keyboard: false });
  }

  // ---------- 구 단위 / 행정동 단위 전환 ----------
  function mode() { return map.getZoom() <= GU_MAX_ZOOM ? "gu" : "dong"; }
  var currentMode = null;
  function applyMode() {
    var m = mode();
    if (m === currentMode) return;
    currentMode = m;
    hover(null);
    if (m === "gu") {
      map.removeLayer(dongLayer); map.removeLayer(guLines); map.removeLayer(selLayer); guFill.addTo(map);
      dongs.forEach(function (d) { map.removeLayer(d.label); });
    } else {
      map.removeLayer(guFill); dongLayer.addTo(map); guLines.addTo(map); selLayer.addTo(map);
      gus.forEach(function (g) { map.removeLayer(g.label); });
    }
    render();
  }
  map.on("zoomend", applyMode);
  map.on("moveend zoomend", placeLabels);

  // ---------- 칠하기 ----------
  function units() { return currentMode === "gu" ? gus : dongs; }

  function render() {
    if (!state.data) { updateTitle(); return; }
    var L_ = state.layer ? LAYERS[state.layer] : null;
    units().forEach(function (u) {
      var v = L_ ? L_.get(u.rows[state.hour]) : null;
      u.layer.setStyle({ fillColor: L_ ? L_.color(v) : "#000", fillOpacity: L_ ? L_.opacity : 0 });
    });
    placeLabels();
    renderLegend();
    renderHourly();
    updateTimeLabel();
    updateTitle();
  }

  // 라벨: 구 단위는 16개 모두, 행정동은 확대 배율에 따라 겹치지 않는 것만 또는 전부
  function placeLabels() {
    if (!state.data) return;
    var L_ = state.layer ? LAYERS[state.layer] : null;
    var isGu = currentMode === "gu";
    var showAll = !isGu && map.getZoom() >= ALL_LABEL_ZOOM;
    var placed = [], size = map.getSize();
    units().forEach(function (u) {
      var show = false;
      if (state.labels) {
        var val = L_ ? L_.fmt(L_.get(u.rows[state.hour])) : "";
        var p = map.latLngToContainerPoint(u.label.getLatLng());
        var w = (u.name.length + val.length) * 12 + 18, h = 22;
        var box = { x1: p.x - w / 2, x2: p.x + w / 2, y1: p.y - h / 2, y2: p.y + h / 2 };
        var inView = box.x2 > 0 && box.x1 < size.x && box.y2 > 0 && box.y1 < size.y;
        var hit = !showAll && placed.some(function (b) { return box.x1 < b.x2 + 4 && box.x2 > b.x1 - 4 && box.y1 < b.y2 + 2 && box.y2 > b.y1 - 2; });
        if (inView && (isGu || showAll || u === state.selected || !hit)) {
          show = true; placed.push(box);
          var cls = "dong-label" + (isGu ? " gu" : "") + (u === state.selected ? " sel" : "");
          var html = '<span class="' + cls + '">' + u.name + (val ? "<b>" + val + "</b>" : "") + "</span>";
          if (u.html !== html) { u.label.setIcon(L.divIcon({ className: "label-icon", html: html, iconSize: null })); u.html = html; }
        }
      }
      if (show && !map.hasLayer(u.label)) u.label.addTo(map);
      if (!show && map.hasLayer(u.label)) map.removeLayer(u.label);
    });
  }

  function renderLegend() {
    var el = document.getElementById("legend");
    var L_ = state.layer ? LAYERS[state.layer] : null;
    document.getElementById("hourly-layer").textContent = L_ ? L_.name : "날씨";
    if (!L_) { el.innerHTML = ""; return; }
    var a = L_.legend[0], b = L_.legend[L_.legend.length - 1], html = "<b>" + L_.fmt(a) + "</b>";
    for (var i = 0; i <= 9; i++) html += '<i style="background:' + L_.color(a + (b - a) * i / 9) + '"></i>';
    el.innerHTML = html + "<b>" + L_.fmt(b) + "</b>";
  }

  function updateTitle() {
    var L_ = state.layer ? LAYERS[state.layer] : null;
    var unit = mode() === "gu" ? "구별 평균" : "행정동별";
    var when = state.data ? fmtTime(state.hour) : "";
    document.getElementById("map-title").innerHTML = L_
      ? "<b>" + L_.name + "</b><span>" + unit + " · " + when + "</span>"
      : "<b>날씨 표시 없음</b><span>" + when + "</span>";
  }

  // ---------- 선택한 행정동의 시간별 예보 ----------
  function select(d, initial) {
    state.selected = d;
    selLayer.clearLayers(); selLayer.addData(d.feature);
    document.getElementById("hourly-name").textContent = d.props.gu + " " + d.props.dong;
    render();
  }

  var DAYS = ["일", "월", "화", "수", "목", "금", "토"];
  function kst(date) {
    var s = date.toLocaleString("en-US", { timeZone: "Asia/Seoul", hour12: false, weekday: "short", month: "numeric", day: "numeric", hour: "numeric" });
    var m = s.match(/(\w+), (\d+)\/(\d+), (\d+)/);
    var wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[m[1]];
    return { day: DAYS[wd], month: +m[2], date: +m[3], hour: (+m[4]) % 24 };
  }
  function fmtTime(i) {
    var t = kst(state.data.times[i]);
    return t.month + "." + t.date + " (" + t.day + ") " + t.hour + "시" + (i === 0 ? " · 지금" : "");
  }

  function renderHourly() {
    var d = state.selected, strip = document.getElementById("hourly-strip");
    if (!d || !d.rows) return;
    var L_ = LAYERS[state.layer] || LAYERS.temp;
    var html = "";
    d.rows.forEach(function (row, i) {
      var t = kst(state.data.times[i]);
      var newDay = i > 0 && t.hour === 0;
      var dayText = i === 0 ? "오늘 " + t.month + "." + t.date + " (" + t.day + ")" : newDay ? t.month + "." + t.date + " (" + t.day + ")" : "";
      var cls = "hour" + (newDay ? " newday" : "") + (i === 0 ? " now" : "");
      html += '<button type="button" class="' + cls + '" data-i="' + i + '"' + (i === state.hour ? ' aria-current="true"' : "") + '>' +
        '<span class="day">' + dayText + '</span><span class="t">' + (i === 0 ? "지금" : t.hour + "시") + '</span>' +
        icon(row.code, row.day) + '<span class="v">' + L_.fmt(L_.get(row)) + '</span><span class="p">' + row.pop + '%</span></button>';
    });
    strip.innerHTML = html;
    var cur = strip.querySelector('[aria-current="true"]');
    if (cur && state.hour > 0) strip.scrollLeft = Math.max(0, cur.offsetLeft - strip.clientWidth / 2 + cur.offsetWidth / 2);
  }
  // 시간별 표: 눌러서 시각 선택, 마우스로 누른 채 끌어서 좌우 이동
  var strip = document.getElementById("hourly-strip");
  var drag = null, justDragged = false;
  strip.addEventListener("pointerdown", function (e) {
    if (e.pointerType !== "mouse" || e.button !== 0) return; // 터치는 브라우저 기본 스크롤 사용
    drag = { x: e.clientX, left: strip.scrollLeft, moved: false };
  });
  window.addEventListener("pointermove", function (e) {
    if (!drag) return;
    var dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) > 4) { drag.moved = true; strip.classList.add("dragging"); }
    if (drag.moved) { strip.scrollLeft = drag.left - dx; e.preventDefault(); }
  });
  window.addEventListener("pointerup", function () {
    if (!drag) return;
    justDragged = drag.moved;
    strip.classList.remove("dragging");
    drag = null;
  });
  strip.addEventListener("click", function (e) {
    if (justDragged) { justDragged = false; return; } // 끌기가 끝난 직후의 클릭은 무시
    var b = e.target.closest(".hour");
    if (b) setHour(+b.getAttribute("data-i"));
  });

  // 날씨 코드(WMO) → 간단한 그림
  function icon(code, day) {
    var sun = '<circle cx="12" cy="12" r="5" fill="#f5b53d"/>';
    var moon = '<path d="M15 4a8 8 0 1 0 5 13A7 7 0 0 1 15 4z" fill="#8aa1c8"/>';
    var cloud = '<path d="M7 18h10a4 4 0 0 0 0-8 5.5 5.5 0 0 0-10.6 1.6A3.3 3.3 0 0 0 7 18z" fill="#aab6bd"/>';
    var rain = '<path d="M8 20l-1 2M12 20l-1 2M16 20l-1 2" stroke="#2f7fc1" stroke-width="1.6" stroke-linecap="round"/>';
    var snow = '<circle cx="8" cy="21" r="1" fill="#7fa7c9"/><circle cx="12" cy="22" r="1" fill="#7fa7c9"/><circle cx="16" cy="21" r="1" fill="#7fa7c9"/>';
    var body;
    if (code <= 1) body = day ? sun : moon;
    else if (code === 2) body = (day ? '<g transform="translate(-3 -3)">' + sun + '</g>' : '<g transform="translate(-3 -3) scale(.8)">' + moon + '</g>') + cloud;
    else if (code === 3 || code === 45 || code === 48) body = cloud;
    else if ((code >= 71 && code <= 77) || code === 85 || code === 86) body = '<g transform="translate(0 -3)">' + cloud + '</g>' + snow;
    else body = '<g transform="translate(0 -3)">' + cloud + '</g>' + rain;
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' + body + '</svg>';
  }

  // ---------- 시간 막대 ----------
  var timeInput = document.getElementById("time");
  function setupTimebar() {
    var n = state.data.times.length;
    timeInput.max = n - 1;
    var html = "";
    state.data.times.forEach(function (tm, i) {
      var t = kst(tm);
      if (t.hour === 0) html += '<span style="left:' + (i / (n - 1) * 100) + '%">' + t.month + "." + t.date + " (" + t.day + ")</span>";
    });
    document.getElementById("days").innerHTML = html;
  }
  timeInput.addEventListener("input", function () { setHour(+timeInput.value, true); });
  function setHour(i, fromSlider) {
    state.hour = i;
    if (!fromSlider) timeInput.value = i;
    render();
  }
  function updateTimeLabel() { document.getElementById("time-label").textContent = fmtTime(state.hour); }
})();
