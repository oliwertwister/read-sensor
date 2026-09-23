# ICON-EU model pipeline

- **Operations/setup:** [`../docs/RUNBOOK.md`](../docs/RUNBOOK.md)
- **DWD source:** https://opendata.dwd.de/weather/nwp/icon-eu/grib/

## Current time model

`render_icon_products.py` selects the freshest complete ICON-EU run and normally publishes three complete valid times from that run: previous, current and next. `--time-radius` controls the bounded window.

The browser changes all active current-run layers together across this shared time dimension.

## Fields

Surface products include:

- 2 m temperature and MetPy-derived dew point;
- mean sea-level pressure;
- 2 m relative humidity;
- total cloud cover;
- accumulated precipitation;
- 10 m wind from U/V components.

Pressure-level products at 850/700/500 hPa include temperature, geopotential height, relative humidity, wind, potential temperature, relative vorticity and horizontal divergence.

Additional diagnostics include 850 hPa equivalent potential temperature/frontogenesis, 500 hPa absolute vorticity and 850–500 hPa bulk shear.

## Current-run browser products

The Pages build derives only the representations needed by the frontend:

- transparent WebP rasters;
- GeoJSON contours where useful;
- thinned GeoJSON wind vectors;
- compact Float32 grids for current-run point queries;
- `synoptic.webp` for the static overview.

Point values come from numerical grids, not from image colours. Sampling can be nearest-grid or bilinear; interpolation does not increase ICON-EU's physical resolution.

## Zarr / R2 archive

Each standard model run also produces one canonical Zarr v3 cube with sharded horizontal chunks and Blosc/Zstd compression. The cube is excluded from GitHub Pages and uploaded to private Cloudflare R2.

Immutable runs live under:

```text
icon-eu/runs/<UTC run>/
```

R2 applies the 14-day lifecycle. The Worker exposes:

- `/api/v1/model-cube/...` — range-capable cube reads;
- `/api/v1/model-runs?limit=N` — compact index of recent immutable runs.

The run index uses a delimiter-based R2 listing and reads only each selected `cube-manifest.json`; it does not scan or copy the cube objects.

## Historical query mode

The model tab has an **ICON run** selector.

- **Current rendered run:** full Pages layer catalogue and animation.
- **Older R2 run:** archive-query mode using the three valid times already stored in that run.

Historical numerical chunks are decoded in a same-origin Web Worker so the main-page CSP does not require `unsafe-eval`. The first archive field is **2 m temperature**; map clicks read only the small Zarr window needed for the selected location/sampling method.

Selecting or querying an existing run adds R2 read operations but no R2 storage.

## Storage constraints

- only 00/06/12/18 UTC runs are persisted to R2;
- duplicate run uploads are skipped;
- one run is capped at 120 MiB and 2,000 objects;
- R2 history expires after 14 days;
- `cube.zarr` must never be staged on GitHub Pages.

These limits are enforced by code/workflow, not only documented here.

## Interpretation

- model fields are numerical analysis/forecast data, not observations;
- `TOT_PREC` is accumulated since model initialization;
- contours and interpolation contain no information finer than the source grid;
- WMS satellite imagery is display data and is not equivalent to calibrated native FCI arrays.

## References

- DWD ICON-EU: https://opendata.dwd.de/weather/nwp/icon-eu/grib/
- cfgrib: https://github.com/ecmwf/cfgrib
- MetPy: https://unidata.github.io/MetPy/latest/api/generated/metpy.calc.html
- Zarr: https://zarr.readthedocs.io/
