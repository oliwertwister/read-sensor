# Satellite pipeline

- **Operations/setup:** [`../docs/RUNBOOK.md`](../docs/RUNBOOK.md)
- **Production workflow:** [`../.github/workflows/pages.yml`](../.github/workflows/pages.yml)

## Pipeline

Each build renders a public EUMETView WMS baseline first, then optionally upgrades it with native MTG/FCI Level-1c data when EUMETSAT credentials are present.

### WMS baseline

`render_satellite.py` publishes Geo Colour and IR 10.5 µm as raw georeferenced WebP plus decorated WebP with grid/boundaries/marker metadata. This path needs no Data Store credential and remains the fallback when native processing fails.

### Native FCI / Satpy

`render_satpy.py` uses:

- collection `EO:EUM:DAT:0662`;
- Satpy reader `fci_l1c_nc`;
- bounded Q4 download (normally 13 chunks);
- regular WGS84 Europe target grid at 0.05°;
- EUMDAC credentials from `EUMETSAT_CONSUMER_KEY` / `EUMETSAT_CONSUMER_SECRET`.

It publishes calibrated IR 10.5 µm, a Float32 brightness-temperature query grid and these requested composites:

- Airmass;
- Day Severe Storms;
- Cloud Phase;
- Cloud Type;
- Fire Temperature;
- Snow;
- GeoColor;
- IR Sandwich.

## Fallback and daylight rules

Native `geo_color` is isolated because it may depend on auxiliary assets. If it fails, the WMS Geo Colour remains the 24-hour display product. Native `natural_color` is only a final daylight fallback.

Daylight-only RGBs preserve alpha and use a PyOrbital solar-zenith mask: opaque through 78°, fading to transparent by 88°. The frontend receives `daylight_only` and `daylight_coverage_fraction` so unavailable nighttime products are disabled rather than shown as black rectangles.

Daylight-only products: Day Severe Storms, Cloud Phase, Cloud Type, Snow and IR Sandwich. Airmass and IR remain available at night.

## Snapshot history

Pages retains **4 complete satellite observations total**: current + three previous distinct snapshots.

Each run:

1. renders the new final satellite state;
2. hydrates at most three older snapshots from deployed Pages, excluding the current observation;
3. archives the current top-level satellite artifacts under `history/<UTC timestamp>/`;
4. prunes anything older than four snapshots.

The index is `satellite/history/index.json`. Repeated builds of the same observation replace that snapshot instead of duplicating it. The Data Monitor includes retained snapshot count/bytes.

## Outputs

- `latest.json` — current backend/product metadata and warnings;
- `geocolour*.webp` — Geo Colour display/fallback;
- `ir105*.webp` — IR 10.5 µm display;
- `ir105-bt.f32.gz` — calibrated query grid;
- raw/decorated WebP pairs for successful derived composites;
- `history/index.json` + up to four complete snapshot directories.

Original FCI NetCDF chunks are ephemeral build inputs and are not retained.

## References

- EUMETSAT Data Store: https://data.eumetsat.int/
- EUMDAC guide: https://user.eumetsat.int/resources/user-guides/eumetsat-data-access-client-eumdac-guide
- Satpy FCI reader: https://satpy.readthedocs.io/en/latest/api/satpy.readers.fci_l1c_nc.html
- PyOrbital: https://pyorbital.readthedocs.io/
