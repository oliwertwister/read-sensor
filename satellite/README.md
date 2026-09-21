# Satellite pipeline

- **Live dashboard:** https://oliwertwister.github.io/read-sensor/
- **Repository:** https://github.com/oliwertwister/read-sensor

The satellite tab is generated independently of the sensor computer. Cloudflare Cron dispatches the GitHub Pages workflow four times per hour. A GitHub-hosted Linux runner executes `satellite/render_satellite.py`, writes static WebP/JSON outputs, and GitHub Pages deploys those outputs with the rest of the dashboard.

## What is actually implemented today

There are now two satellite backends.

### Always-on WMS baseline

satellite/render_satellite.py uses EUMETSAT EUMETView WMS to obtain the MTG/FCI Geo Colour RGB and IR 10.5 µm visual products. It publishes clean georeferenced WebP layers plus decorated versions with the WGS84 grid, Natural Earth Admin-0 boundaries and Berlin marker.

### Credential-gated native FCI/Satpy upgrade

satellite/render_satpy.py runs after the WMS renderer only when EUMETSAT_CONSUMER_KEY and EUMETSAT_CONSUMER_SECRET are configured. It downloads a bounded recent subset from collection EO:EUM:DAT:0662 with EUMDAC, currently requests coverage quarter Q4, uses a 75-minute default lag and a three-hour search window, then reads the files with Satpy reader fci_l1c_nc.

The native path loads natural_color and calibrated ir_105, resamples onto a 0.05 degree regular Europe grid, and writes the same compatible geocolour and IR WebP files plus ir105-bt.f32.gz, a queryable Float32 brightness-temperature grid in kelvin.

Native metadata is replaced atomically only after successful processing. Authentication, entitlement, dependency, download, read or resampling failures emit a warning and keep the already-rendered WMS products, so Satpy cannot make the normal Pages deployment less available.

## Critical limitation of the WMS approach

A WMS PNG is already rendered by the upstream server. We receive display pixels rather than the native FCI channel arrays and associated calibration/geolocation metadata. Consequently the current code cannot reliably perform:

- native-channel radiance/reflectance/brightness-temperature calculations;
- custom RGB recipes from arbitrary FCI channels;
- quantitative cloud-top or surface retrieval algorithms;
- native geostationary-to-target-grid resampling;
- uncertainty/quality-flag analysis;
- physically meaningful interpolation of the original satellite observations.

Image-space interpolation of the PNG is possible, but it only interpolates rendered pixels. It does not recover missing physical information and should not be described as meteorological interpolation.

## Native FCI + Satpy operational path

The implemented processing chain is:

    EUMETSAT Data Store / EUMDAC
        -> recent Q4 FCI Level-1c NetCDF chunks
        -> Satpy Scene using fci_l1c_nc
        -> natural_color + calibrated ir_105
        -> Satpy / pyresample to 0.05 degree Europe grid
        -> georeferenced WebP layers + IR 10.5 K Float32 grid + metadata
        -> existing interactive Leaflet catalogue
        -> GitHub Pages

EUMETSAT Data Store downloads require registered-user authentication and product entitlement. Near-real-time availability can additionally depend on the applicable licence. Credentials remain GitHub Actions secrets; raw Level-1c chunks live only in an ephemeral temporary directory and are discarded at job end. The default 75-minute lag reduces reliance on immediate-NRT delivery but does not replace account or licence requirements.

## Where xarray and Dask fit

Satpy datasets are xarray-based and can be Dask-backed. That is useful for lazy loading/chunked operations on native FCI data, but Dask is not automatically an optimisation. On a single GitHub-hosted runner, excessive chunking can create scheduler overhead and memory pressure.

For this project the preferred sequence is:

1. select the smallest useful time/channel/geographic subset;
2. preserve source/native chunking where sensible;
3. use Satpy/pyresample for the geolocation-aware satellite resampling;
4. compute only the derived arrays needed for the published images;
5. discard native input files when the job finishes.

Dask becomes more valuable when multiple large NetCDF chunks or channels no longer fit comfortably in memory. The current native path is deliberately bounded and does not introduce a distributed Dask cluster. Satpy may use Dask-backed arrays internally, but the job computes only the publication products and discards raw inputs afterward.

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
