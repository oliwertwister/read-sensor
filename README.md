# read-sensor

A zero-cost, public prototype for sensor telemetry, weather observations, numerical-weather-model products, and satellite imagery.

- **Live dashboard:** https://oliwertwister.github.io/read-sensor/
- **Source repository:** https://github.com/oliwertwister/read-sensor

The project deliberately separates a static public frontend from data collection and scheduled processing. GitHub Pages serves the dashboard; a Cloudflare Worker provides the telemetry/weather proxy API and scheduled workflow dispatch; Cloudflare D1 stores bounded sensor history; GitHub Actions performs scheduled static-data/image builds. The sensor computer only makes outbound HTTPS requests.

## Current dashboard

- **Overview** — current sensor value, age, and Berlin weather.
- **Sensors** — D1-backed telemetry with selectable latest-N or rolling-window history, optional 5/10/15/20/25-minute averaging, CSV export, a time-series chart, and a normalized temperature-distribution line plot.
- **Berlin Weather** — current conditions from Open-Meteo.
- **Aviation Weather** — worldwide station search, map selection, and METAR/TAF retrieval through the Aviation Weather Center Data API.
- **DWD ICON-EU** — interactive multidimensional Leaflet field explorer plus a static synoptic overlay. The map now has a bounded forecast-time dimension (previous/current/next complete valid hour from one run), independent satellite/raster/isoline/wind layers, per-layer opacity, bilinear or nearest-grid point sampling, and click queries against native numerical grids. Current quantitative fields are T2M, PMSL, RH2M, total cloud cover, accumulated precipitation, 10 m wind, plus temperature, geopotential height, relative humidity, and wind on the bounded 850/700/500 hPa pressure dimension.
- **SYNOP** — worldwide WMO station search plus a recent-report map assembled from DWD SYNOP feeds; selected raw `AAXX` reports are decoded in the browser when available.
- **Satellite** — EUMETSAT EUMETView WMS imagery for MTG/FCI, rendered autonomously with a coordinate grid, country boundaries, and Berlin marker.
- **Berlin Map** — Leaflet/OpenStreetMap with WGS84 coordinate grid and local geometry loading.

## Telemetry architecture

The sensor computer makes one-shot outbound HTTPS requests to the Cloudflare Worker. The Worker authenticates the device and stores readings in D1. The public frontend reads only the public read API. There is no inbound listener, tunnel, or public service on the sensor computer.

`install-schedule.sh` installs a local LaunchAgent that runs the collector every five minutes. Runtime files live under `~/.local/lib/read-sensor` so scheduled collection does not depend on a synced Documents folder being available.

D1 retention is bounded by the Worker configuration. The frontend history API supports explicit `since`/`until` ranges and up to 10,000 readings per request. A 30-day UI selection does not manufacture missing history: it returns only observations that are actually present in the database.

## Local geometry

The Berlin Map accepts GeoJSON/JSON, GeoPackage (`.gpkg`), and Shapefiles either directly (`.shp`, with matching sidecar files where available) or packaged as `.zip` / `.rar`. Geometry is parsed in the browser and is not uploaded to the telemetry backend. Current safety limits are 10 MiB per selected file, 20 MiB after archive extraction, and 20,000 features.

Vendored parser notices are listed in [`vendor/THIRD_PARTY_NOTICES.md`](vendor/THIRD_PARTY_NOTICES.md).

## Satellite processing: implemented vs planned

The current satellite renderer is intentionally lightweight. `satellite/render_satellite.py` requests already-rendered PNG imagery from **EUMETSAT EUMETView WMS**, crops the requested Europe extent, and adds overlays with Pillow. It does **not** currently download native FCI Level-1c numerical data and it does **not** currently run Satpy. See [`satellite/README.md`](satellite/README.md) for the detailed limitations and upgrade path.

This distinction matters: the WMS path is appropriate for a zero-cost visual dashboard, but it cannot provide the native calibrated channel arrays needed for quantitative multispectral calculations, native-resolution resampling, channel algebra, or physically meaningful interpolation of satellite measurements.

## Numerical model analysis path

The quantitative ICON-EU build is orchestrated by [`model/render_icon_products.py`](model/render_icon_products.py), with the compact static renderer retained in [`model/render_icon_synoptic.py`](model/render_icon_synoptic.py). Details are in [`model/README.md`](model/README.md). The pipeline uses native DWD ICON-EU regular-lat/lon GRIB2 fields rather than extracting values from rendered charts.

1. discover the freshest complete ICON-EU run/lead combination;
2. download the required surface and pressure-level fields once per build;
3. decode GRIB2 with **ecCodes/cfgrib** into **xarray** arrays;
4. normalize coordinates and subset the Europe domain;
5. derive display units and 10 m wind speed;
6. export independent transparent WebP colour rasters, GeoJSON isolines, GeoJSON wind vectors, and native Float32 grids for point queries;
7. generate the legacy compact satellite + isobar/isotherm/wind static synoptic product from the same build;
8. let Leaflet compose the interactive layers in the browser rather than flattening them into one image.

**Dask is not used yet** because the current bounded three-time/three-pressure-level workload is processed sequentially and still fits comfortably in memory. It remains appropriate for substantially larger time/pressure/channel cubes where lazy loading and chunked computation materially reduce memory pressure.

### Interactive field explorer and map engine

The interactive model viewer intentionally remains on **Leaflet** for now. Its current requirements—georeferenced image overlays, GeoJSON contours and vectors, opacity controls, pan/zoom, and point interrogation—fit Leaflet well and reuse the mapping stack already shipped by this project. Moving only this tab to OpenLayers would add a second map engine without a present technical necessity.

A move to **OpenLayers** becomes attractive if the browser starts doing substantial numerical-raster work itself: client-side reprojection, WebGL raster expressions, many simultaneously animated time slices, large Cloud-Optimized GeoTIFFs, or GPU-heavy multidimensional styling. Until then the architecture keeps the map-library boundary clean so the backend products can be consumed by either engine.

The Satpy upgrade is designed to plug into the same layer catalogue. Native MTG/FCI Level-1c channels would be read through Satpy, calibrated/resampled with Satpy/pyresample, and published as additional georeferenced rasters plus queryable numerical grids. The current EUMETView WMS imagery remains a lightweight fallback/background until native FCI access and licensing are resolved.

This supports real meteorological plotting such as:

- mean-sea-level-pressure **isobars** from `pmsl`;
- 2 m **isotherms** from `t_2m`;
- pressure-level temperature, geopotential height, relative humidity, and wind fields;
- wind barbs/streamlines and derived wind speed;
- precipitation and cloud-cover fields;
- anomaly/difference maps between forecast steps or model runs.

Contour generation itself does not require arbitrary interpolation if the model field is already on a suitable regular grid: contours can be computed directly on the model grid. Interpolation/resampling is appropriate when combining different grids, producing a common display grid, or sampling a field at arbitrary locations. It should not be used merely to make coarse model data look more detailed than their native information content.

## Cost-free compute constraints

The repository is public, so standard GitHub-hosted Actions runners are currently free for public repositories. The standard `ubuntu-latest` runner provides substantially more CPU/RAM than the present Pillow renderer needs, but each job starts from a fresh VM and the repository should avoid turning scheduled rendering into a bulk archive-processing service. Large downloads, repeated full-disc FCI processing, unnecessary Dask graphs, and persistent intermediate datasets would waste bandwidth and runner time.

The practical free-tier strategy is therefore **subset early, compute small, publish derived products only**. GitHub Pages should contain WebP/PNG/vector/JSON outputs, not large original GRIB2/NetCDF satellite/model archives.

## Data sources, attribution, and technical references

The dashboard combines several independent upstream services. Availability, latency, licensing, and completeness remain properties of those sources; this repository does not operate the observing systems.

1. **Live site:** [read-sensor GitHub Pages](https://oliwertwister.github.io/read-sensor/).
2. **EUMETSAT EUMETView / MTG:** [MTG data resources](https://user.eumetsat.int/data/satellites/meteosat-third-generation/resources) and [MTG operations/data access](https://user.eumetsat.int/resources/user-guides/mtg-in-operations).
3. **EUMETSAT Data Store / EUMDAC:** [Introductory Data Store guide](https://user.eumetsat.int/resources/user-guides/introductory-data-store-user-guide) and [EUMDAC guide](https://user.eumetsat.int/resources/user-guides/eumetsat-data-access-client-eumdac-guide).
4. **Satpy:** [FCI L1c NetCDF reader](https://satpy.readthedocs.io/en/latest/api/satpy.readers.fci_l1c_nc.html) and [Satpy resampling](https://satpy.readthedocs.io/en/latest/resample.html).
5. **DWD ICON-EU:** [ICON-EU Open Data GRIB directories](https://opendata.dwd.de/weather/nwp/icon-eu/grib/), including [`t_2m`](https://opendata.dwd.de/weather/nwp/icon-eu/grib/00/t_2m/) and [`pmsl`](https://opendata.dwd.de/weather/nwp/icon-eu/grib/00/pmsl/).
6. **xarray / Dask:** [xarray parallel computing with Dask](https://docs.xarray.dev/en/latest/user-guide/dask.html) and [xarray I/O](https://docs.xarray.dev/en/latest/user-guide/io.html).
7. **GRIB2 decoding:** [ECMWF cfgrib](https://github.com/ecmwf/cfgrib), which provides the `xarray` GRIB engine on top of ecCodes.
8. **Aviation weather:** [Aviation Weather Center Data API](https://connect.aviationweather.gov/data/api/).
9. **WMO station metadata:** [WMO OSCAR](https://oscar.wmo.int/surface/) / [OSCAR overview](https://space.oscar.wmo.int/).
10. **General weather:** [Open-Meteo API documentation](https://open-meteo.com/en/docs).
11. **Map data:** [OpenStreetMap](https://www.openstreetmap.org/) and [Natural Earth](https://www.naturalearthdata.com/).
12. **GitHub Actions:** [billing and usage](https://docs.github.com/en/actions/concepts/billing-and-usage) and [GitHub-hosted runner specifications](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

### Licensing note

Rendered visual products and original numerical data are not interchangeable from a licensing perspective. In particular, EUMETSAT licensing depends on product and use case. Native FCI Level-1c ingestion should be implemented only after confirming the applicable Data Store/NRT licence and redistribution conditions. The pipeline should publish derived visual products rather than republishing original licensed numerical files unless the applicable licence explicitly permits redistribution.
