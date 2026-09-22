# Satellite pipeline

- **Live dashboard:** https://oliwertwister.github.io/read-sensor/
- **Operations/setup:** ../docs/RUNBOOK.md
- **Production workflow:** ../.github/workflows/pages.yml

This document describes the satellite implementation only. Account creation, secrets, full-project run commands and deployment verification live in the runbook.

## Current architecture

Each production build renders a resilient EUMETView WMS baseline first, then attempts a credential-gated native MTG/FCI Level-1c upgrade.

### 1. WMS baseline

`render_satellite.py` requests EUMETSAT EUMETView display imagery for Geo Colour and IR 10.5 µm. It publishes:

- raw georeferenced WebP overlays;
- decorated WebP versions with WGS84 grid, Natural Earth Admin-0 boundaries and the Berlin marker;
- `latest.json` metadata.

This path requires no EUMETSAT Data Store credential and remains the display fallback when the native path cannot complete.

### 2. Native FCI / Satpy upgrade

`render_satpy.py` activates only when `EUMETSAT_CONSUMER_KEY` and `EUMETSAT_CONSUMER_SECRET` are available. It downloads the most recent bounded Q4 subset from collection `EO:EUM:DAT:0662`, currently with:

- reader: `fci_l1c_nc`;
- target grid: regular WGS84 Europe grid at 0.05°;
- default source lag: 75 minutes;
- search window: 180 minutes;
- expected Q4 NetCDF chunks: 13.

The native renderer publishes calibrated IR 10.5 µm, a Float32 brightness-temperature grid in kelvin, and Satpy RGB composites.

Current requested native composites:

- Airmass RGB;
- Day Severe Storms RGB;
- Cloud Phase RGB;
- Cloud Type RGB;
- Fire Temperature RGB;
- Snow RGB;
- GeoColor;
- IR Sandwich.

## Geo Colour and daylight handling

Native `geo_color` is isolated from the shared Satpy scene because it may depend on auxiliary imagery. If it succeeds, it becomes the main Geo Colour layer. If it fails, the already-rendered EUMETView WMS Geo Colour is retained as the 24-hour display product. Only when neither is available does the renderer fall back to native Satpy `natural_color`, which is daylight-only.

Daylight-only RGBs are not flattened to black at night. Alpha from Satpy/Trollimage is preserved, and an additional PyOrbital solar-zenith mask is applied where appropriate: opaque through 78°, fading to transparent by 88°. The frontend receives `daylight_only` and `daylight_coverage_fraction` metadata so unavailable nighttime layers can be disabled explicitly.

The daylight-only set is currently:

- Day Severe Storms;
- Cloud Phase;
- Cloud Type;
- Snow;
- IR Sandwich.

Airmass and calibrated IR remain useful at night. Fire Temperature is not force-masked by the daylight rule.

## Failure isolation

The WMS result is created first and remains usable if native authentication, entitlement, dependency installation, download, resampling or composite rendering fails. GeoColor is loaded/rendered separately so its auxiliary-data failure cannot abort the other native composites.

Raw FCI Level-1c chunks exist only in the ephemeral build workspace and are discarded at job end.

## Why WMS and native FCI are different

EUMETView WMS returns rendered display pixels. It does not expose the original channel arrays, calibration or quality metadata, so it cannot support trustworthy radiance/reflectance/brightness-temperature calculations or custom native-channel RGB recipes.

The Satpy path works from Level-1c data and can therefore provide calibrated arrays, physically meaningful resampling and derived composites. Image interpolation of a WMS product must not be described as recovery of native meteorological information.

## Compute policy

The satellite job deliberately stays bounded:

1. select one recent product and only the required Q4 chunks;
2. resample once to the project Europe grid;
3. publish compact WebP/JSON/Float32 derivatives;
4. discard original NetCDF input.

Satpy arrays may be Dask-backed, but the current FCI graph is materialized with the synchronous scheduler because concurrent netCDF-C access has proven unsafe in this pipeline. A distributed Dask cluster is not part of the architecture.

## Snapshot history

The published site retains **4 complete satellite snapshots total**: the current observation plus the three most recent distinct previous observations. GitHub-hosted runners are ephemeral, so each run first hydrates the existing `satellite/history/` index and snapshot files from the deployed Pages site, renders the new final satellite state, archives it by observation timestamp, and prunes older directories.

The index is `satellite/history/index.json`; snapshot directories use UTC IDs such as `20260922T003000Z/`. A snapshot contains every final top-level satellite artifact from that run, including metadata, raw/decorated WebP products and the calibrated IR query grid when available. Repeated builds for the same observation replace rather than duplicate that snapshot.

The Satellite tab reads this index and exposes a timestamp selector for the retained observations. Product selection remains independent of time selection; daylight-only RGBs are disabled when the selected snapshot has no daylight coverage.

The Data Monitor reports both snapshot count and total retained history bytes, and the normal Pages 380 MiB planning target / 500 MiB hard guard still includes the history.

## Key outputs

- `satellite/output/latest.json` — backend/product metadata and warnings;
- `geocolour-raw.webp`, `geocolour.webp` — current continuous Geo Colour display/fallback;
- `ir105-raw.webp`, `ir105.webp` — IR 10.5 µm display;
- `ir105-bt.f32.gz` — calibrated query grid;
- one raw/decorated WebP pair for each successfully rendered derived composite.

Exact persistent footprint per composite is recorded in metadata and surfaced in the Data Monitor.

## References

- EUMETSAT Data Store: https://data.eumetsat.int/
- EUMDAC guide: https://user.eumetsat.int/resources/user-guides/eumetsat-data-access-client-eumdac-guide
- Satpy FCI L1c reader: https://satpy.readthedocs.io/en/latest/api/satpy.readers.fci_l1c_nc.html
- Satpy resampling: https://satpy.readthedocs.io/en/latest/resample.html
- PyOrbital: https://pyorbital.readthedocs.io/
