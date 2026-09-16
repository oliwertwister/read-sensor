# read-sensor

A zero-cost prototype for publishing outbound-only device telemetry to a static GitHub Pages dashboard.

## Dashboard

- **Overview** — current CPU temperature, sensor age, and Berlin weather.
- **CPU Temperature** — D1-backed temperature history with automatic refresh.
- **Berlin Weather** — general Berlin weather from Open-Meteo.
- **BER Aviation Weather** — EDDB METAR/TAF plus DWD ICON forecast charts.
- **Berlin Map** — Leaflet/OpenStreetMap with WGS84 coordinate grid, Berlin and BER markers, and local geometry loading.
- **Sensor / System** — latest telemetry record and architecture details.

## Telemetry path

The sensor computer makes one-shot outbound HTTPS requests to a Cloudflare Worker. The Worker authenticates the device and stores bounded history in Cloudflare D1. GitHub Pages reads the public API; there is no inbound listener, tunnel, or public service on the sensor computer.

`install-schedule.sh` installs a macOS LaunchAgent that runs the collector every five minutes. Runtime files live under `~/.local/lib/read-sensor` so the job does not depend on background access to an iCloud-backed Documents folder.

## Local geometry

The Berlin Map can display GeoJSON/JSON, GeoPackage (`.gpkg`), and Shapefiles either directly (`.shp` with optional matching `.dbf`, `.prj`, `.cpg`) or packaged as `.zip` / `.rar`. Geometry is parsed entirely in the browser and is never uploaded. Safety limits are 10 MiB per selected file, 20 MiB after archive extraction, and 20,000 features.

Vendored parser notices are in `vendor/THIRD_PARTY_NOTICES.md`.
