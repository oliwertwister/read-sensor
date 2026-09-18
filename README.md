# read-sensor

A zero-cost prototype for publishing outbound-only device telemetry to a static GitHub Pages dashboard.

## Dashboard

- **Overview** — current CPU temperature, sensor age, and Berlin weather.
- **Sensor / System** — D1-backed CPU-temperature history, latest reading, and architecture details.
- **Berlin Weather** — general Berlin weather from Open-Meteo.
- **BER Aviation Weather** — EDDB METAR/TAF plus DWD ICON forecast charts.
- **SYNOP Weather** — raw FM-12 AAXX reports with in-browser decoding for selected Berlin/Potsdam WMO stations.
- **Satellite** — autonomous MTG-I/FCI Europe imagery with WGS84 grid, dispatched four times per hour by Cloudflare Cron.
- **Berlin Map** — Leaflet/OpenStreetMap with WGS84 coordinate grid, Berlin and BER markers, and local geometry loading.

## Telemetry path

The sensor computer makes one-shot outbound HTTPS requests to a Cloudflare Worker. The Worker authenticates the device and stores bounded history in Cloudflare D1. GitHub Pages reads the public API; there is no inbound listener, tunnel, or public service on the sensor computer.

`install-schedule.sh` installs a local LaunchAgent that runs the collector every five minutes. Runtime files live under `~/.local/lib/read-sensor` so the job does not depend on background access to a synced Documents folder.

## Local geometry

The Berlin Map can display GeoJSON/JSON, GeoPackage (`.gpkg`), and Shapefiles either directly (`.shp` with optional matching `.dbf`, `.prj`, `.cpg`) or packaged as `.zip` / `.rar`. Geometry is parsed entirely in the browser and is never uploaded. Safety limits are 10 MiB per selected file, 20 MiB after archive extraction, and 20,000 features.

Vendored parser notices are in `vendor/THIRD_PARTY_NOTICES.md`.

## Autonomous satellite path

Cloudflare Cron dispatches the satellite renderer four times per hour. The renderer runs on GitHub-hosted Linux, reads the latest MTG-I/FCI imagery from EUMETSAT EUMETView, overlays a coordinate grid and timestamp, then deploys WebP images with the site. It is independent of the sensor computer and browser clients. See `satellite/README.md`.

The same cloud-only deployment fetches a bounded 36-hour window of raw Berlin/Potsdam AAXX reports from OGIMET and publishes a small static JSON snapshot. The browser decodes the standard FM-12 Section 1 fields for educational display. SYNOP fetching and decoding do not run on the sensor computer, require no secret, and open no inbound service.
