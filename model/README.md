# ICON-EU quantitative model products

- **Live dashboard:** https://oliwertwister.github.io/read-sensor/
- **Repository:** https://github.com/oliwertwister/read-sensor
- **DWD ICON-EU GRIB2 source:** https://opendata.dwd.de/weather/nwp/icon-eu/grib/

The model pipeline now produces both the compact static synoptic image and the interactive Leaflet products. `render_icon_products.py` is the scheduled entry point; it reuses `render_icon_synoptic.py` for the static product so core GRIB fields are not downloaded twice.

## Current fields

The build discovers the freshest complete regular-lat/lon run and chooses the forecast lead with valid time nearest the build time. It currently loads:

- `T_2M` - 2 m temperature, K to deg C;
- `PMSL` - mean sea-level pressure, Pa to hPa;
- `U_10M`, `V_10M` - 10 m wind components and derived wind speed;
- `RELHUM_2M` - 2 m relative humidity;
- `CLCT` - total cloud cover;
- `TOT_PREC` - accumulated precipitation from model initialization to valid time;
- pressure-level `T` at 850 hPa - K to deg C;
- pressure-level `FI` at 500 hPa - geopotential converted to geopotential height in decametres.

The selected regular-lat/lon product currently has 0.0625 degree grid spacing over the useful ICON-EU domain. Longitudes are normalized to -180..180 and latitude rows are stored north-to-south for browser raster alignment.

## Processing stack

```text
DWD ICON-EU GRIB2
    -> bz2 decompression
    -> ecCodes / cfgrib
    -> xarray DataArray
    -> coordinate normalization + Europe subset
    -> unit conversion / derived wind speed
       -> transparent WebP colour rasters
       -> GeoJSON isolines
       -> GeoJSON thinned wind vectors
       -> Float32 native query grids
       -> compact static synoptic.webp
    -> GitHub Pages
    -> Leaflet
```

Dask is intentionally not used for this single-valid-time build. The selected arrays fit comfortably into memory on the standard GitHub-hosted runner. Dask becomes useful when the project starts processing many times/channels together or native FCI products large enough to benefit from chunked lazy computation.

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
- 2 m temperature 5 deg C isolines;
- PMSL 4 hPa isobars;
- thinned 10 m wind vectors.

Other generated fields are loaded only when the user enables them, so large contour files and query grids are not transferred unnecessarily.

## Static synoptic product

`render_icon_synoptic.py` still generates `synoptic.webp` for a compact overview with white PMSL isobars every 4 hPa, black 2 m isotherms every 5 deg C, white 10 m wind arrows, and the current MTG/FCI Geo Colour raster background. The static image and interactive layers use the same selected ICON run/lead.

## Why Leaflet remains the map engine

Leaflet is sufficient for the current requirements: georeferenced image overlays, GeoJSON contour/vector layers, per-layer opacity, pan/zoom, point-value interrogation, and a small already-deployed code footprint shared with the other project maps.

OpenLayers becomes preferable if the browser starts doing substantial numerical-raster work itself, especially WebGL raster expressions, large Cloud-Optimized GeoTIFFs, browser-side reprojection, many animated time slices, or GPU-heavy multidimensional styling. The generated data products are kept map-engine-neutral so migration remains possible later.

## Satpy integration path

Satpy is still not in the live satellite build. Current MTG/FCI layers are rendered EUMETView WMS pixels and therefore are not quantitatively queryable.

Planned native path:

```text
EUMETSAT Data Store / EUMDAC
    -> MTG FCI Level-1c NetCDF subset
    -> Satpy Scene(reader="fci_l1c_nc")
    -> calibrated channels / Satpy composites
    -> Satpy + pyresample
    -> xarray DataArrays
    -> same raster + query-grid layer catalogue
    -> Leaflet
```

This will allow native-channel values such as calibrated brightness temperatures to participate in the same point-query and opacity/layer workflow. Native FCI access, authentication, and redistribution/licensing requirements must be resolved before enabling that path in GitHub Actions.

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
11. Satpy FCI L1c reader: https://satpy.readthedocs.io/en/latest/api/satpy.readers.fci_l1c_nc.html
12. Satpy resampling: https://satpy.readthedocs.io/en/latest/resample.html
