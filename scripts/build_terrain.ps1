# 부산 지형 데이터 만들기: 등고선 → DEM → 음영기복도 / 경사도
# QGIS에 포함된 GDAL 명령어 도구로 처리한다 (QGIS의 TIN 보간, 음영기복, 경사 도구와 같은 엔진).
#
# 실행 (PowerShell):  powershell -ExecutionPolicy Bypass -File scripts\build_terrain.ps1
# 입력:  ..\data\WEB\N3L_F0010000_부산\N3L_F0010000_26.shp  (수치지형도 등고선, EPSG:5179, 높이 필드 CONT)
#        data\busan.geojson                               (부산 외곽선, 자르기용)
# 출력:  ..\data\slope\  busan_dem.tif, busan_hillshade.tif, busan_slope_pct.tif, hillshade_3857.png
#        (웹용 이미지는 scripts\build_hillshade_png.py 가 마무리)

$ErrorActionPreference = "Stop"
$q = "C:\Program Files\QGIS 3.40.11"
$env:PATH = "$q\bin;$q\apps\gdal\bin;" + $env:PATH
$env:GDAL_DATA = "$q\apps\gdal\share\gdal"
$env:PROJ_DATA = "$q\share\proj"
$env:PROJ_LIB = "$q\share\proj"

$root = Split-Path -Parent $PSScriptRoot           # busan-outdoor
$src = Join-Path $root "..\data\WEB\N3L_F0010000_부산\N3L_F0010000_26.shp"
$outline = Join-Path $root "data\busan.geojson"
$out = Join-Path $root "..\data\slope"
New-Item -ItemType Directory -Force $out | Out-Null
$res = 20   # 격자 크기(m)

Write-Host "1/6 등고선 단순화 (5m 이내 꼭짓점 정리, 높이 필드만 남김)"
ogr2ogr -f GPKG "$out\contours.gpkg" $src -select CONT -simplify 5 -nln contours -overwrite

Write-Host "2/6 TIN 보간으로 DEM 만들기 (${res}m)"
# 범위(EPSG:5179 미터): 등고선 범위를 감싸는 사각형. -tye는 위쪽(북)부터 적어야 북쪽이 위인 이미지가 된다.
$xmin = 1115000; $xmax = 1164000; $ymin = 1655300; $ymax = 1711700
$w = ($xmax - $xmin) / $res; $h = ($ymax - $ymin) / $res
gdal_grid -l contours -a linear -zfield CONT -txe $xmin $xmax -tye $ymax $ymin -outsize $w $h -a_srs EPSG:5179 -ot Float32 -of GTiff -co COMPRESS=DEFLATE "$out\contours.gpkg" "$out\busan_dem_full.tif"
if (-not (Test-Path "$out\busan_dem_full.tif")) { throw "DEM을 만들지 못했습니다" }

Write-Host "3/6 부산 경계로 자르기"
gdalwarp -overwrite -cutline $outline -crop_to_cutline -dstnodata -9999 -co COMPRESS=DEFLATE "$out\busan_dem_full.tif" "$out\busan_dem.tif"

Write-Host "4/6 음영기복 (방위각 315, 고도 45)"
gdaldem hillshade "$out\busan_dem.tif" "$out\busan_hillshade.tif" -az 315 -alt 45 -z 1 -compute_edges -co COMPRESS=DEFLATE

Write-Host "5/6 경사도 (퍼센트)"
gdaldem slope "$out\busan_dem.tif" "$out\busan_slope_pct.tif" -p -compute_edges -co COMPRESS=DEFLATE

Write-Host "6/6 웹 지도 좌표계(EPSG:3857)로 바꿔 PNG로 저장"
gdalwarp -overwrite -t_srs EPSG:3857 -r bilinear -tr $res $res -dstalpha "$out\busan_hillshade.tif" "$out\hillshade_3857.tif"
gdal_translate -of PNG "$out\hillshade_3857.tif" "$out\hillshade_3857.png"
gdalinfo -json "$out\hillshade_3857.tif" | Out-File -Encoding utf8 "$out\hillshade_3857.json"
Write-Host "완료: $out"
