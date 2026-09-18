# Satellite pipeline

The dashboard satellite tab is generated independently of the sensor computer.
Cloudflare Cron dispatches `render_satellite.py` through the GitHub Actions
`workflow_dispatch` API four times per hour. GitHub-hosted Linux renders and
deploys the result with the static GitHub Pages site. The Cloudflare Worker
stores a fine-grained GitHub token as an encrypted secret; it is limited to
Actions write access on this repository and is never exposed to browsers or
sensor devices. The dashboard displays both the source observation time and
the page-generation time and marks old imagery as stale.

Current products come from EUMETSAT EUMETView WMS and are based on MTG-I FCI:

- `mtg_fd:rgb_geocolour` — day/night Geo Colour RGB composite.
- `mtg_fd:ir105_hrfi` — 10.5 µm thermal infrared imagery.

The renderer crops Europe to 25°W–45°E / 30°N–72°N, overlays a WGS84
latitude/longitude grid plus Natural Earth 1:50m Admin-0 country boundaries
fitted to the same CRS:84 extent and exports WebP. This is country-level
administrative geometry, not merely a coastline layer. Observation time is
carried separately in `latest.json` and displayed by the dashboard.
No Mac, phone, browser session, API key, or inbound connection is required.
Country geometry is fetched by the scheduled renderer from Natural Earth.

## Raw FCI / Satpy upgrade

The frontend is intentionally source-agnostic. A later renderer can replace the
WMS source with EUMETSAT Data Store Level-1c files and Satpy's `fci_l1c_nc`
reader without changing the dashboard UI. That path requires EUMETSAT Data Store
credentials stored as GitHub Actions secrets.
