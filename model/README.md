# ICON-EU quantitative model products

- **Live dashboard:** https://oliwertwister.github.io/read-sensor/
- **Repository:** https://github.com/oliwertwister/read-sensor
- **DWD ICON-EU GRIB2 source:** https://opendata.dwd.de/weather/nwp/icon-eu/grib/

The model pipeline now produces both the compact static synoptic image and a bounded multidimensional Leaflet product. `render_icon_products.py` is the scheduled entry point. Each build publishes three complete valid times from one ICON-EU run: the previous complete hour, the latest complete valid time not after the build clock, and the next complete hour. The browser switches all active numerical layers coherently across that time dimension.

## Current fields

The build discovers the freshest complete regular-lat/lon run and loads the existing surface and 850/700/500 hPa pressure-level fields. In addition to the directly decoded ICON variables, MetPy now derives:

- 2 m dew point from T_2M and RELHUM_2M;
- potential temperature at 850, 700 and 500 hPa;
- relative vorticity at 850, 700 and 500 hPa;
- horizontal divergence at 850, 700 and 500 hPa.

The original quantitative fields remain: T_2M, PMSL, U/V 10 m, RELHUM_2M, CLCT, TOT_PREC, pressure-level temperature, geopotential height, relative humidity and U/V wind. All derived fields use the same native regular ICON-EU grid and are published with the same raster, contour and Float32 query-grid conventions.

The bounded pressure dimension is now temperature / geopotential height / relative humidity / wind / potential temperature / relative vorticity / horizontal divergence at 850/700/500 hPa. Surface diagnostics remain separate physical vertical coordinates.

## Processing stack

    DWD ICON-EU GRIB2
        -> bz2 decompression
        -> ecCodes / cfgrib
        -> xarray DataArray
        -> coordinate normalization + Europe subset
        -> MetPy diagnostics
        -> unit conversion / derived wind speed
        -> transparent WebP colour rasters
        -> GeoJSON isolines
        -> GeoJSON thinned wind vectors
        -> Float32 native query grids
        -> compact static synoptic.webp
        -> GitHub Pages
        -> Leaflet

Dask is intentionally not used explicitly for the current three-valid-time build. Each valid time is loaded, transformed, written and released sequentially, so peak memory remains close to one time slice.

## Interactive Leaflet outputs

For every scalar field the workflow publishes three independent products:

1. a transparent colour raster bilinear-resampled 2x for smoother visual display;
2. GeoJSON contour geometry with contour values in feature properties;
3. a little-endian Float32 grid used for point interrogation.

The browser does not infer values from raster colours. Clicking the map loads the required Float32 grid lazily and samples it either with **nearest grid point** or **bilinear interpolation** between the four surrounding native grid points.

Bilinear sampling does not imply additional model resolution; it is only interpolation between model values.

The current layer catalogue also includes EUMETSAT MTG/FCI Geo Colour WMS imagery, EUMETSAT MTG/FCI IR 10.5 um WMS imagery, and thinned 10 m wind vectors with `u`, `v`, speed and direction metadata.

Each map layer has an independent checkbox and opacity slider. Raster colour scales are shown beside their layer controls. Contour labels are carried by GeoJSON feature metadata rather than baked into the background image.

## Current default view

The initial interactive stack is:

- MTG/FCI Geo Colour background;
- 2 m temperature colour raster;
- 2 m temperature 4 `degrees_celsius` isolines, labelled to one decimal place;
- PMSL 4 hPa isobars;
- thinned 10 m wind vectors.

Other generated fields are loaded only when the user enables them, so large contour files and query grids are not transferred unnecessarily.

## Static synoptic product

`render_icon_synoptic.py` still generates `synoptic.webp` for a compact overview with white PMSL isobars every 4 hPa, black 2 m isotherms every 4 `degrees_celsius`, white 10 m wind arrows, and the current MTG/FCI Geo Colour raster background. The static image and interactive layers use the same selected ICON run/lead.

## Why Leaflet remains the map engine

Leaflet is sufficient for the current requirements: georeferenced image overlays, GeoJSON contour/vector layers, per-layer opacity, pan/zoom, point-value interrogation, and a small already-deployed code footprint shared with the other project maps.

OpenLayers becomes preferable if the browser starts doing substantial numerical-raster work itself, especially WebGL raster expressions, large Cloud-Optimized GeoTIFFs, browser-side reprojection, many animated time slices, or GPU-heavy multidimensional styling. The generated data products are kept map-engine-neutral so migration remains possible later.

## Satpy integration path

The workflow now contains an optional native satellite backend in satellite/render_satpy.py. EUMetView WMS is rendered first as the guaranteed fallback. If EUMETSAT_CONSUMER_KEY and EUMETSAT_CONSUMER_SECRET are available, the second stage downloads a bounded FCI Level-1c subset through EUMDAC.

The native path uses Satpy reader fci_l1c_nc, loads natural_color and calibrated ir_105, resamples to a 0.05 degree regular Europe grid, writes compatible WebP layers, and publishes an IR 10.5 brightness-temperature Float32 query grid. Successful native processing exposes sat_ir105_bt to map point queries.

Failure is non-fatal: native metadata is written only after processing succeeds, while the preceding WMS files remain usable. Native availability still depends on the EUMETSAT account's product and licence access.

## Interpretation and limitations

These layers are model analysis/forecast fields, not direct observations. The coloured raster is a display representation of the regular model grid. Isolines are computed from that numerical grid and should not be interpreted as containing information finer than the source resolution.

`TOT_PREC` is cumulative from model initialization to the selected valid time. It is not an instantaneous precipitation rate.

The WMS satellite layers remain visual products only. Their pixel colours cannot be converted back into native FCI radiance, reflectance, or brightness-temperature measurements.

## References

1. DWD ICON-EU GRIB2: https://opendata.dwd.de/weather/nwp/icon-eu/grib/
2. DWD `t_2m`: https://opendata.dwd.de/weather/nwp/icon-eu/grib/00/t_2m/
3. DWD `pmsl`: https://opendata.dwd.de/weather/nwp/icon-eu/grib/00/pmsl/
4. DWD `relhum_2m`: https://opendata.dwd.de/weather/nwp/icon-eu/grib/00/relhum_2m/
5. DWD `clct`: https://opendata.dwd.de/weather/nwp/icon-eu/grib/00/clct/
6. DWD `tot_prec`: https://opendata.dwd.de/weather/nwp/icon-eu/grib/00/tot_prec/
7. cfgrib: https://github.com/ecmwf/cfgrib
8. xarray I/O: https://docs.xarray.dev/en/latest/user-guide/io.html
9. Matplotlib contouring: https://matplotlib.org/stable/api/_as_gen/matplotlib.pyplot.contour.html
10. Leaflet: https://leafletjs.com/
11. MetPy calculations: https://unidata.github.io/MetPy/latest/api/generated/metpy.calc.html
12. Satpy FCI Level-1c reader: https://satpy.readthedocs.io/en/latest/api/satpy.readers.fci_l1c_nc.html
13. Satpy resampling: https://satpy.readthedocs.io/en/latest/resample.html
