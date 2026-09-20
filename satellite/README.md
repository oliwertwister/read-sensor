# Satellite pipeline

- **Live dashboard:** https://oliwertwister.github.io/read-sensor/
- **Repository:** https://github.com/oliwertwister/read-sensor

The satellite tab is generated independently of the sensor computer. Cloudflare Cron dispatches the GitHub Pages workflow four times per hour. A GitHub-hosted Linux runner executes `satellite/render_satellite.py`, writes static WebP/JSON outputs, and GitHub Pages deploys those outputs with the rest of the dashboard.

## What is actually implemented today

The current renderer is **not a Satpy pipeline**. It uses EUMETSAT **EUMETView WMS** as a rendered-image source:

- `mtg_fd:rgb_geocolour` — MTG/FCI Geo Colour RGB;
- `mtg_fd:ir105_hrfi` — MTG/FCI 10.5 µm thermal-infrared visual product.

`render_satellite.py` requests a PNG in `CRS:84` for 25°W–45°E / 30°N–72°N. It now preserves a clean georeferenced WebP for the interactive Leaflet map and separately uses Pillow to create the decorated Satellite-tab product with:

- WGS84 latitude/longitude grid;
- Natural Earth 1:50m Admin-0 country boundaries;
- Berlin marker;
- static WebP export plus `latest.json` metadata.

This path is computationally cheap and works well for the current zero-cost GitHub Actions setup. It is a **visualisation pipeline**, not a numerical satellite-analysis pipeline.

## Critical limitation of the WMS approach

A WMS PNG is already rendered by the upstream server. We receive display pixels rather than the native FCI channel arrays and associated calibration/geolocation metadata. Consequently the current code cannot reliably perform:

- native-channel radiance/reflectance/brightness-temperature calculations;
- custom RGB recipes from arbitrary FCI channels;
- quantitative cloud-top or surface retrieval algorithms;
- native geostationary-to-target-grid resampling;
- uncertainty/quality-flag analysis;
- physically meaningful interpolation of the original satellite observations.

Image-space interpolation of the PNG is possible, but it only interpolates rendered pixels. It does not recover missing physical information and should not be described as meteorological interpolation.

## Native FCI + Satpy upgrade

Satpy has an `fci_l1c_nc` reader for MTG FCI Level-1c NetCDF and supports resampling through `Scene.resample()` with nearest-neighbour, bilinear, EWA, native, and bucket resamplers. A quantitative pipeline would therefore look like:

```text
EUMETSAT Data Store / EUMDAC
        ↓
FCI Level-1c NetCDF chunks (spatial/channel subset)
        ↓
Satpy Scene(reader="fci_l1c_nc")
        ↓
calibrated channels / Satpy composites
        ↓
Satpy + pyresample to Europe target grid
        ↓
xarray / Dask-backed DataArrays as needed
        ↓
georeferenced display rasters + compact numerical query grids + metadata
        ↓
the same interactive Leaflet layer catalogue used by ICON-EU
        ↓
GitHub Pages
```

EUMETSAT Data Store downloads require registered-user authentication. Near-real-time FCI access may additionally depend on the applicable NRT licence. EUMETSAT explicitly recommends band and region-of-interest subsetting for FCI Level-1c processing because full products can be memory intensive. Credentials would have to remain GitHub Actions secrets and must never be written to the static Pages artifact.

## Where xarray and Dask fit

Satpy datasets are xarray-based and can be Dask-backed. That is useful for lazy loading/chunked operations on native FCI data, but Dask is not automatically an optimisation. On a single GitHub-hosted runner, excessive chunking can create scheduler overhead and memory pressure.

For this project the preferred sequence is:

1. select the smallest useful time/channel/geographic subset;
2. preserve source/native chunking where sensible;
3. use Satpy/pyresample for the geolocation-aware satellite resampling;
4. compute only the derived arrays needed for the published images;
5. discard native input files when the job finishes.

Dask becomes more valuable when multiple large NetCDF chunks or channels no longer fit comfortably in memory. It is unnecessary for the current WMS/Pillow renderer. Once native FCI arrays are available, calibrated channel values can be published into the same click-query/opacity/layer workflow now used by the interactive ICON-EU Leaflet map.

## Numerical weather models: separate from Satpy

Isobars and isotherms should normally come from a numerical weather prediction model, not from an FCI RGB image. DWD publishes ICON-EU fields as GRIB2, including 2 m temperature (`t_2m`) and mean-sea-level pressure (`pmsl`). A suitable model pipeline is:

```text
DWD ICON-EU GRIB2
        ↓
ecCodes / cfgrib
        ↓
xarray Dataset
        ↓
subset / unit conversion / optional interpolation
        ↓
Matplotlib + Cartopy contours
        ↓
WebP/PNG or compact vector/JSON output
```

Examples:

- **isobars:** contours of `pmsl`, typically converted Pa → hPa before plotting;
- **isotherms:** contours of `t_2m`, typically converted K → degrees_celsius;
- **upper-air charts:** pressure-level temperature, geopotential, relative humidity, and wind where available;
- **combined products:** satellite imagery as the raster background with independently computed ICON-EU isobars/isotherms overlaid.

For ICON-EU regular-lat/lon products, Matplotlib can contour the native grid directly. Interpolation is needed only when aligning multiple grids, producing a different target grid, or sampling arbitrary locations. We should avoid smoothing that visually implies resolution the model does not contain.

## What is realistic on the zero-cost architecture

The public repository can use standard GitHub-hosted Actions runners without per-minute charges. `ubuntu-latest` currently provides a multi-core VM with enough RAM for modest subsetted geospatial processing. The limiting resources are more practically **network transfer, transient disk, memory peaks, workflow duration, and upstream service/licence constraints** than Python itself.

Reasonable scheduled products:

- latest FCI Europe composite from a small subset of channels;
- one or two resampled IR/visible channels;
- ICON-EU `pmsl` isobars + `t_2m` isotherms for the current forecast step;
- satellite + model overlay;
- a few selected forecast lead times;
- compact derived metadata/vector contours.

Poor fits for the free scheduled runner:

- continuously archiving complete FCI full-disc Level-1c cycles;
- downloading all FCI bands every 10 minutes;
- keeping full ICON-EU runs or large multi-run ensembles in the repository;
- large Dask workflows that expect a persistent distributed cluster;
- publishing original licensed numerical satellite data through GitHub Pages.

The best design remains: **download the minimum → process once → publish small derived artifacts → discard raw inputs**.

## References

1. EUMETSAT MTG resources: https://user.eumetsat.int/data/satellites/meteosat-third-generation/resources
2. EUMETSAT MTG operations/data access: https://user.eumetsat.int/resources/user-guides/mtg-in-operations
3. EUMETSAT Data Store guide: https://user.eumetsat.int/resources/user-guides/introductory-data-store-user-guide
4. EUMDAC guide: https://user.eumetsat.int/resources/user-guides/eumetsat-data-access-client-eumdac-guide
5. Satpy FCI L1c reader: https://satpy.readthedocs.io/en/latest/api/satpy.readers.fci_l1c_nc.html
6. Satpy resampling: https://satpy.readthedocs.io/en/latest/resample.html
7. xarray + Dask: https://docs.xarray.dev/en/latest/user-guide/dask.html
8. cfgrib / ecCodes xarray engine: https://github.com/ecmwf/cfgrib
9. DWD ICON-EU GRIB2: https://opendata.dwd.de/weather/nwp/icon-eu/grib/
10. DWD ICON-EU 2 m temperature: https://opendata.dwd.de/weather/nwp/icon-eu/grib/00/t_2m/
11. DWD ICON-EU mean-sea-level pressure: https://opendata.dwd.de/weather/nwp/icon-eu/grib/00/pmsl/
12. GitHub Actions runner reference: https://docs.github.com/en/actions/reference/runners/github-hosted-runners
