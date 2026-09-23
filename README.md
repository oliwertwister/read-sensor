# read-sensor

Public, zero-cost weather/telemetry dashboard combining local sensor data, observations, satellite imagery and ICON-EU model products.

- **Live:** https://oliwertwister.github.io/read-sensor/
- **Source:** https://github.com/oliwertwister/read-sensor

## Documentation

- **Setup, credentials, running and verification:** [`docs/RUNBOOK.md`](docs/RUNBOOK.md)
- **Satellite pipeline:** [`satellite/README.md`](satellite/README.md)
- **ICON-EU / R2 model pipeline:** [`model/README.md`](model/README.md)
- **Production workflow:** [`.github/workflows/pages.yml`](.github/workflows/pages.yml)
- **Third-party notices:** [`vendor/THIRD_PARTY_NOTICES.md`](vendor/THIRD_PARTY_NOTICES.md)

Keep operational instructions in the runbook and component internals in their component README; this file is only the project overview.

## Architecture

```text
sensor computer ──HTTPS──> Cloudflare Worker ──> D1 telemetry
                                      │
                                      ├──> private R2 ICON Zarr archive
                                      └──> scheduled GitHub Actions dispatch

DWD / EUMETSAT / public weather feeds
                 │
                 v
          GitHub Actions
                 │
                 └──> GitHub Pages dashboard
```

The sensor computer has no inbound listener or public tunnel.

## What the dashboard contains

- **Sensors** — D1-backed telemetry, charting, averaging and CSV export.
- **Weather / aviation / SYNOP** — public observation and forecast feeds.
- **Satellite** — EUMETView Geo Colour fallback plus native MTG/FCI Satpy products; four recent complete snapshots are retained on Pages.
- **ICON-EU** — current rendered raster/vector/query products on Pages plus immutable numerical Zarr runs in private R2.
- **Model archive** — recent R2 runs are indexed by the Worker; historical numerical reads are decoded in a same-origin Web Worker without weakening the main page CSP.
- **Berlin map / local geometry** — Leaflet/OpenStreetMap with browser-side local geometry loading.

## Storage model

GitHub Pages stores the current browser-ready products: WebP, GeoJSON, JSON and compact Float32 query grids. It does **not** store the model Zarr cube.

Cloudflare R2 stores immutable ICON-EU Zarr runs under `icon-eu/runs/<UTC run>/`. The browser reads historical numerical values through the Worker byte-range gateway. Selecting an existing run does not create another copy.

D1 stores bounded sensor history. Original satellite NetCDF and model GRIB2 inputs are build-time intermediates and are not retained.

## Guardrails

| Resource | Policy |
| --- | --- |
| D1 telemetry | maximum 30 days |
| R2 ICON history | 14-day lifecycle |
| R2 cube | maximum 120 MiB and 2,000 objects per run |
| ICON publication | standard 00/06/12/18 UTC runs only; duplicates skipped |
| GitHub Pages | deployment fails above 500 MiB |
| Zarr on Pages | prohibited by the workflow |

The design principle is: **subset early, keep one canonical numerical copy, publish only the browser products that are actually needed.**

## Licensing

Upstream datasets retain their own licensing and redistribution conditions. Native EUMETSAT FCI ingestion is credential-gated; the public site publishes derived products rather than original licensed Level-1c files. See the component READMEs for source-specific details.
