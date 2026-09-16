# Satellite pipeline

The dashboard satellite tab is generated independently of the sensor computer.
GitHub Actions runs `render_satellite.py` every 15 minutes and deploys the result
with the static GitHub Pages site.

Current products come from EUMETSAT EUMETView WMS and are based on MTG-I FCI:

- `mtg_fd:rgb_geocolour` — day/night Geo Colour RGB composite.
- `mtg_fd:ir105_hrfi` — 10.5 µm thermal infrared imagery.

The renderer crops Europe to 25°W–45°E / 30°N–72°N, overlays a WGS84
latitude/longitude grid, embeds the observation timestamp and exports WebP.
No Mac, phone, browser session, API key, or inbound connection is required.

## Raw FCI / Satpy upgrade

The frontend is intentionally source-agnostic. A later renderer can replace the
WMS source with EUMETSAT Data Store Level-1c files and Satpy's `fci_l1c_nc`
reader without changing the dashboard UI. That path requires EUMETSAT Data Store
credentials stored as GitHub Actions secrets.
