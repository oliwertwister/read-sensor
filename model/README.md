# ICON-EU quantitative model products

- **Live dashboard:** https://oliwertwister.github.io/read-sensor/
- **Operations/setup:** ../docs/RUNBOOK.md
- **DWD ICON-EU source:** https://opendata.dwd.de/weather/nwp/icon-eu/grib/

This document describes the model-processing implementation. Deployment credentials and whole-project run instructions live in the runbook.

## Current time dimension

`render_icon_products.py` discovers the freshest complete ICON-EU regular-lat/lon run and, by default, publishes a bounded three-step window from that single run:

- the previous complete valid time;
- the latest complete valid time not after the build clock;
- the next complete valid time.

The browser switches all active model layers coherently across this shared time dimension. The command-line `--time-radius` option controls the number of complete leads on either side and currently accepts 0–4.

This bounded design is intentional: it gives useful temporal context without turning GitHub Pages into an archive of complete model runs.

## Fields and diagnostics

Surface fields include:

- 2 m temperature;
- mean sea-level pressure;
- 2 m relative humidity;
- MetPy-derived 2 m dew point;
- total cloud cover;
- accumulated precipitation;
- 10 m wind speed from U/V components.

Pressure-level fields are generated at 850, 700 and 500 hPa for temperature, geopotential height, relative humidity, wind speed, potential temperature, relative vorticity and horizontal divergence.

Additional diagnostics currently include:

- 850 hPa equivalent potential temperature;
- 850 hPa frontogenesis;
- 500 hPa absolute vorticity;
- 850–500 hPa bulk wind shear.

Cloud cover and accumulated precipitation intentionally have no dense contour layer. Several diagnostics are colour/query products only to reduce clutter and persistent storage.

## Processing stack

```text
DWD ICON-EU GRIB2
  -> bz2 decompression
  -> ecCodes / cfgrib / xarray
  -> coordinate normalization + Europe subset
  -> MetPy / NumPy diagnostics
  -> display-unit conversion
  -> WebP rasters + GeoJSON contours/vectors + Float32 query grids
  -> compact static synoptic.webp
  -> Zarr v3 cube
  -> GitHub Pages + private Cloudflare R2
```

Each valid time is processed sequentially. Dask is not explicitly introduced for this bounded build because it would add scheduler overhead without a clear memory/runtime benefit.

## Interactive outputs

The browser does not infer values from image colours. Quantitative point queries use the published Float32 grids, sampled either at the nearest native grid point or bilinearly between four surrounding grid points.

Generated representations are field-dependent:

- colour raster for scalar display;
- GeoJSON isolines only where the field specification defines contour levels;
- thinned GeoJSON vectors for wind;
- Float32 grid for quantitative point queries.

Bilinear sampling is interpolation between model values and does not increase the physical resolution of ICON-EU.

## Satellite integration

The model catalogue consumes the current satellite metadata rather than assuming a fixed satellite backend.

The resilient WMS Geo Colour product can remain the map background while native Satpy products such as Airmass, IR 10.5 µm, Cloud Phase and other RGBs are exposed as independent optional layers. When native IR is available, `sat_ir105_bt` provides queryable brightness temperature.

Daylight-only satellite layers carry availability metadata into the model-layer catalogue. The frontend can therefore disable them at night instead of presenting an apparently broken black/empty layer.

## Static synoptic product

`render_icon_synoptic.py` generates `synoptic.webp` from the selected ICON run/lead using the current satellite background, PMSL isobars, 2 m isotherms and wind arrows.

The static image is a compact overview. The interactive Leaflet layers remain the authoritative path for independent styling, opacity and quantitative interrogation.

## Zarr / R2

The build also writes a Zarr v3 cube for the bounded time/pressure dimensions. Production publishing uses the Worker R2 gateway and a short-lived GitHub OIDC identity; the cube is intentionally excluded from the GitHub Pages artifact.

See the runbook for production upload behavior and credentials. Storage limits and retention are enforced by the uploader/Worker rather than by this README.

## Interpretation notes

- These fields are numerical model analysis/forecast values, not observations.
- `TOT_PREC` is accumulated from model initialization to the selected valid time, not an instantaneous precipitation rate.
- Isolines are calculated from the numerical grid; they do not contain information finer than that grid.
- Derived MetPy diagnostics inherit limitations of the source model grid and input variables.
- Satellite WMS pixels are display imagery and are not interchangeable with calibrated native FCI arrays.

## References

- DWD ICON-EU GRIB2: https://opendata.dwd.de/weather/nwp/icon-eu/grib/
- cfgrib: https://github.com/ecmwf/cfgrib
- xarray: https://docs.xarray.dev/
- MetPy calculations: https://unidata.github.io/MetPy/latest/api/generated/metpy.calc.html
- Leaflet: https://leafletjs.com/
- Zarr: https://zarr.readthedocs.io/
