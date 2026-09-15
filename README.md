# read-sensor

A zero-cost prototype for publishing device telemetry to a static GitHub Pages dashboard.

## Dashboard tabs

1. **Overview** — current CPU temperature, last sensor update, status, and Berlin weather summary.
2. **CPU Temperature** — time-series chart of CPU temperature with automatic browser refresh.
3. **Berlin Weather** — temperature and weather data for Berlin from a free public weather API.
4. **Berlin Map** — Leaflet map using OpenStreetMap tiles.
5. **Sensor / System** — raw latest sensor record, collector status, and explanation of the local-to-web data path.

## Data path

A scheduled job runs the local collector periodically. The collector reads CPU temperature, writes/recreates a small local sensor file, and publishes a compact telemetry record for the website. The website never gets direct filesystem access to the sensor node: the local collector is the bridge between the local file and the public dashboard.

The implementation is deliberately bounded so telemetry history cannot grow indefinitely or approach GitHub storage limits.

## Scheduling

`install-schedule.sh` installs a five-minute crontab entry. Each run recreates `sensor-latest.json`, appends one bounded history sample, and pushes the two telemetry files. GitHub Pages then serves the updated data and the open browser refreshes it every minute.

This is suitable for a low-frequency, free prototype. It is intentionally not a high-frequency telemetry database.
