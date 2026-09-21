# read-sensor

A zero-cost, public prototype for sensor telemetry, weather observations, numerical-weather-model products, and satellite imagery.

- **Live dashboard:** https://oliwertwister.github.io/read-sensor/
- **Source repository:** https://github.com/oliwertwister/read-sensor

The project deliberately separates a static public frontend from data collection and scheduled processing. GitHub Pages serves the dashboard; a Cloudflare Worker provides the telemetry/weather proxy API and scheduled workflow dispatch; Cloudflare D1 stores bounded sensor history; GitHub Actions performs scheduled static-data/image builds. The sensor computer only makes outbound HTTPS requests.

## Start here

- **Run / reproduce / credentials:** [`docs/RUNBOOK.md`](docs/RUNBOOK.md)
- **Satellite implementation:** [`satellite/README.md`](satellite/README.md)
- **ICON-EU implementation:** [`model/README.md`](model/README.md)
- **Production workflow:** [`.github/workflows/pages.yml`](.github/workflows/pages.yml)

The canonical full build is the GitHub Actions workflow. It is the only production path that can obtain the short-lived GitHub OIDC identity used for R2 model-cube uploads. Local instructions are intentionally limited to validation and rendering rather than emulating production credentials.

## Current dashboard

- **Overview** — current sensor value, age, and Berlin weather.
- **Sensors** — D1-backed telemetry with selectable latest-N or rolling-window history, optional 5/10/15/20/25-minute averaging, CSV export, a time-series chart, and a normalized temperature-distribution line plot.
- **Berlin Weather** — current conditions from Open-Meteo.
- **Aviation Weather** — worldwide station search, map selection, and METAR/TAF retrieval through the Aviation Weather Center Data API.
- **DWD ICON-EU** — interactive multidimensional Leaflet field explorer plus a static synoptic overlay. The map now has a bounded forecast-time dimension (previous/current/next complete valid hour from one run), independent satellite/raster/isoline/wind layers, per-layer opacity, bilinear or nearest-grid point sampling, and click queries against native numerical grids. Current quantitative fields include T2M, MetPy-derived 2 m dew point, PMSL, RH2M, total cloud cover, accumulated precipitation and 10 m wind, plus temperature, geopotential height, relative humidity, wind, potential temperature plus relative vorticity and horizontal divergence at 850/700/500 hPa; the latter two are colour/query products without dense isolines.
- **SYNOP** — worldwide WMO station search plus a recent-report map assembled from DWD SYNOP feeds; selected raw `AAXX` reports are decoded in the browser when available.
- **Satellite** — EUMETView WMS supplies the resilient 24-hour Geo Colour baseline. The credential-gated EUMDAC + Satpy stage adds native MTG/FCI Level-1c products, a queryable IR 10.5 µm brightness-temperature grid, and several derived RGB composites; daylight-only RGBs are explicitly masked outside valid solar illumination.
- **Berlin Map** — Leaflet/OpenStreetMap with WGS84 coordinate grid and local geometry loading.

## Telemetry architecture

The sensor computer makes one-shot outbound HTTPS requests to the Cloudflare Worker. The Worker authenticates the device and stores readings in D1. The public frontend reads only the public read API. There is no inbound listener, tunnel, or public service on the sensor computer.

`install-schedule.sh` installs a local LaunchAgent that runs the collector every five minutes. Runtime files live under `~/.local/lib/read-sensor` so scheduled collection does not depend on a synced Documents folder being available.

D1 retention is bounded by the Worker configuration. The frontend history API supports explicit `since`/`until` ranges and up to 10,000 readings per request. A 30-day UI selection does not manufacture missing history: it returns only observations that are actually present in the database.

## Local geometry

The Berlin Map accepts GeoJSON/JSON, GeoPackage (`.gpkg`), and Shapefiles either directly (`.shp`, with matching sidecar files where available) or packaged as `.zip` / `.rar`. Geometry is parsed in the browser and is not uploaded to the telemetry backend. Current safety limits are 10 MiB per selected file, 20 MiB after archive extraction, and 20,000 features.

Vendored parser notices are listed in [`vendor/THIRD_PARTY_NOTICES.md`](vendor/THIRD_PARTY_NOTICES.md).

## Satellite processing: WMS baseline + optional native Satpy path

The satellite build now has two layers of resilience. The always-on satellite/render_satellite.py path requests rendered MTG/FCI imagery from EUMETSAT EUMETView WMS and publishes the existing WebP products. A second, optional satellite/render_satpy.py stage activates only when EUMETSAT_CONSUMER_KEY and EUMETSAT_CONSUMER_SECRET are available as GitHub Actions secrets.

The native stage downloads a bounded MTG/FCI Level-1c subset through EUMDAC, reads it with Satpy's `fci_l1c_nc` reader, resamples to the Europe target grid, and publishes calibrated IR 10.5 µm plus derived Satpy RGB products. The WMS Geo Colour product remains the 24-hour display fallback whenever native Satpy GeoColor is unavailable; native failures are isolated and do not block the other composites or the Pages deployment.

The distinction remains important: WMS products are display pixels; the native Satpy path provides calibrated FCI arrays suitable for quantitative work. Daylight-only products are labelled/masked rather than shown as black nighttime rectangles.

## Numerical model analysis path

The quantitative ICON-EU build is orchestrated by model/render_icon_products.py, with the compact static renderer retained in model/render_icon_synoptic.py. The pipeline uses native DWD ICON-EU regular-lat/lon GRIB2 fields rather than extracting values from rendered charts.

1. discover the freshest complete ICON-EU run/lead combination;
2. download the required surface and pressure-level fields once per build;
3. decode GRIB2 with ecCodes/cfgrib into xarray arrays;
4. normalize coordinates and subset the Europe domain;
5. use MetPy to derive 2 m dew point plus pressure-level potential temperature, plus relative vorticity and horizontal divergence as colour/query products without dense isolines;
6. derive display units and wind speed;
7. export independent transparent WebP colour rasters, GeoJSON isolines, GeoJSON wind vectors and native Float32 grids for point queries;
8. generate the compact satellite + isobar/isotherm/wind static synoptic product from the same build;
9. let Leaflet compose the interactive layers in the browser rather than flattening them into one image.

Dask is still not used explicitly for the bounded ICON build because each valid time is processed sequentially. It remains appropriate for materially larger time/pressure/channel cubes.

### Interactive field explorer and map engine

The interactive model viewer intentionally remains on **Leaflet** for now. Its current requirements—georeferenced image overlays, GeoJSON contours and vectors, opacity controls, pan/zoom, and point interrogation—fit Leaflet well and reuse the mapping stack already shipped by this project. Moving only this tab to OpenLayers would add a second map engine without a present technical necessity.

A move to **OpenLayers** becomes attractive if the browser starts doing substantial numerical-raster work itself: client-side reprojection, WebGL raster expressions, many simultaneously animated time slices, large Cloud-Optimized GeoTIFFs, or GPU-heavy multidimensional styling. Until then the architecture keeps the map-library boundary clean so the backend products can be consumed by either engine.

The optional Satpy backend now plugs into the same layer catalogue. Native MTG/FCI Level-1c chunks are calibrated/resampled with Satpy/pyresample and the IR 10.5 µm brightness-temperature array is published as a queryable numerical grid. EUMETView WMS remains the unconditional fallback.

This supports real meteorological plotting such as:

- mean-sea-level-pressure **isobars** from `pmsl`;
- 2 m **isotherms** from `t_2m`;
- pressure-level temperature, geopotential height, relative humidity, wind, potential temperature, relative vorticity and horizontal-divergence fields;
- 2 m dew point, wind barbs/streamlines and derived wind speed;
- precipitation and cloud-cover fields;
- anomaly/difference maps between forecast steps or model runs.

Contour generation itself does not require arbitrary interpolation if the model field is already on a suitable regular grid: contours can be computed directly on the model grid. Interpolation/resampling is appropriate when combining different grids, producing a common display grid, or sampling a field at arbitrary locations. It should not be used merely to make coarse model data look more detailed than their native information content.


## Zarr / R2 cube migration prototype

A parallel storage migration is now implemented in code without replacing the current map products yet. The ICON build writes a canonical **Zarr v3** cube with `sharding_indexed` storage, 128×128 logical horizontal chunks packed into 512×512 shards, and Blosc/Zstd compression. Canonical values are stored once (K, Pa, m, m/s, %, kg m-2) and presentation conversions remain a frontend concern.

The target backend is **Cloudflare R2** behind the existing Worker. The Worker exposes byte-range GET/HEAD routes and an authenticated upload route; GitHub Actions authenticates uploads with a short-lived GitHub OIDC token scoped to this repository/main branch and the custom `read-sensor-r2-upload` audience, so no long-lived upload secret is required. `model/upload_zarr_cube.py` publishes immutable run prefixes and updates `latest.json` only after all run objects are uploaded. The browser connector lazy-loads a vendored Zarrita bundle only when an R2 cube pointer is available.

The R2 bucket is private, uses Standard storage, and has a verified 14-day lifecycle rule. The existing Pages-based raster/GeoJSON path remains available during migration. The full `cube.zarr/` directory is explicitly removed from the Pages artifact, so the numerical archive does not consume GitHub Pages storage.


## Storage and free-tier guardrails

The project intentionally fails closed before storing excessive data. Current hard policy:

| Resource | Project policy | Guardrail |
| --- | --- | --- |
| D1 telemetry | 30 days maximum | Worker clamps `RETENTION_DAYS` to 30 and scheduled maintenance globally prunes older rows |
| R2 ICON cubes | 14 days maximum | `model/r2-lifecycle.json` expires the bucket; publisher accepts only 00/06/12/18 UTC runs |
| R2 per-run cube | 120 MiB maximum | publisher refuses larger runs |
| R2 objects per run | 2,000 maximum | publisher refuses larger object counts |
| R2 duplicate runs | never re-upload | publisher checks `latest.json` and skips an already published run |
| GitHub Pages staged site | 500 MiB maximum | workflow refuses deployment above this safety ceiling |
| Zarr on GitHub Pages | prohibited | workflow fails if `_site/model/cube.zarr` exists |

At the four standard ICON run hours per day, the 120 MiB per-run cap and 14-day R2 lifecycle bound retained cube storage to about 6.6 GiB before small metadata overhead, leaving margin below R2 Standard's 10 GB-month free allowance. The bucket must remain **Standard** storage; Infrequent Access is not used.

Forecast animation is generated client-side from the existing model time dimension. It does not save rendered frame sequences, GIFs, or videos on the server.

## Cost-free compute constraints

The repository is public, so standard GitHub-hosted Actions runners are currently free for public repositories. The standard `ubuntu-latest` runner provides substantially more CPU/RAM than the present Pillow renderer needs, but each job starts from a fresh VM and the repository should avoid turning scheduled rendering into a bulk archive-processing service. Large downloads, repeated full-disc FCI processing, unnecessary Dask graphs, and persistent intermediate datasets would waste bandwidth and runner time.

The practical free-tier strategy is therefore **subset early, compute small, publish derived products only**. GitHub Pages should contain WebP/PNG/vector/JSON outputs, not large original GRIB2/NetCDF satellite/model archives.

## Data sources, attribution, and technical references

The dashboard combines several independent upstream services. Availability, latency, licensing, and completeness remain properties of those sources; this repository does not operate the observing systems.

1. **Live site:** [read-sensor GitHub Pages](https://oliwertwister.github.io/read-sensor/).
2. **EUMETSAT EUMETView / MTG:** [MTG data resources](https://user.eumetsat.int/data/satellites/meteosat-third-generation/resources) and [MTG operations/data access](https://user.eumetsat.int/resources/user-guides/mtg-in-operations).
3. **EUMETSAT Data Store / EUMDAC:** [Introductory Data Store guide](https://user.eumetsat.int/resources/user-guides/introductory-data-store-user-guide) and [EUMDAC guide](https://user.eumetsat.int/resources/user-guides/eumetsat-data-access-client-eumdac-guide).
4. **Satpy:** [FCI L1c NetCDF reader](https://satpy.readthedocs.io/en/latest/api/satpy.readers.fci_l1c_nc.html) and [Satpy resampling](https://satpy.readthedocs.io/en/latest/resample.html).
5. **MetPy calculations:** https://unidata.github.io/MetPy/latest/api/generated/metpy.calc.html
6. **DWD ICON-EU:** [ICON-EU Open Data GRIB directories](https://opendata.dwd.de/weather/nwp/icon-eu/grib/), including [`t_2m`](https://opendata.dwd.de/weather/nwp/icon-eu/grib/00/t_2m/) and [`pmsl`](https://opendata.dwd.de/weather/nwp/icon-eu/grib/00/pmsl/).
7. **xarray / Dask:** [xarray parallel computing with Dask](https://docs.xarray.dev/en/latest/user-guide/dask.html) and [xarray I/O](https://docs.xarray.dev/en/latest/user-guide/io.html).
8. **GRIB2 decoding:** [ECMWF cfgrib](https://github.com/ecmwf/cfgrib), which provides the `xarray` GRIB engine on top of ecCodes.
9. **Aviation weather:** [Aviation Weather Center Data API](https://connect.aviationweather.gov/data/api/).
10. **WMO station metadata:** [WMO OSCAR](https://oscar.wmo.int/surface/) / [OSCAR overview](https://space.oscar.wmo.int/).
11. **General weather:** [Open-Meteo API documentation](https://open-meteo.com/en/docs).
12. **Map data:** [OpenStreetMap](https://www.openstreetmap.org/) and [Natural Earth](https://www.naturalearthdata.com/).
13. **GitHub Actions:** [billing and usage](https://docs.github.com/en/actions/concepts/billing-and-usage) and [GitHub-hosted runner specifications](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

### Licensing note

Rendered visual products and original numerical data are not interchangeable from a licensing perspective. In particular, EUMETSAT licensing depends on product and use case. Native FCI Level-1c ingestion is credential-gated and must be used only under the applicable Data Store/NRT licence and redistribution conditions. The pipeline should publish derived visual products rather than republishing original licensed numerical files unless the applicable licence explicitly permits redistribution.

Operational setup, credentials, verification and reproduction commands are maintained in [`docs/RUNBOOK.md`](docs/RUNBOOK.md). Storage ceilings are defined once above and enforced in code/workflow rather than repeated in multiple documentation sections.
