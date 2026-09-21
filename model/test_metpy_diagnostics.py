#!/usr/bin/env python3
"""Small regression test for MetPy-derived ICON diagnostics."""
from __future__ import annotations

import numpy as np
import xarray as xr

import render_icon_products as products


def field(values, lats, lons):
    return xr.DataArray(
        np.asarray(values, dtype=np.float32),
        coords={"latitude": lats, "longitude": lons},
        dims=("latitude", "longitude"),
    )


def main() -> None:
    lats = np.linspace(55.0, 45.0, 6)
    lons = np.linspace(5.0, 20.0, 8)
    yy, xx = np.meshgrid(np.arange(len(lats)), np.arange(len(lons)), indexing="ij")

    grids = {
        "t_2m": field(288.0 + 0.6 * xx - 0.4 * yy, lats, lons),
        "pmsl": field(101300.0 + 20.0 * xx, lats, lons),
        "relhum_2m": field(65.0 + 2.0 * yy, lats, lons),
        "clct": field(40.0 + 2.0 * xx, lats, lons),
        "tot_prec": field(2.0 + 0.1 * xx, lats, lons),
        "u_10m": field(4.0 + 0.2 * yy, lats, lons),
        "v_10m": field(2.0 + 0.1 * xx, lats, lons),
    }
    for level, base_temp in ((850, 282.0), (700, 270.0), (500, 252.0)):
        grids[f"t_{level}"] = field(base_temp + 0.4 * xx - 0.2 * yy, lats, lons)
        grids[f"fi_{level}"] = field((1500 + (850 - level) * 12 + 5 * yy) * 9.80665, lats, lons)
        grids[f"rh_{level}"] = field(55.0 + 2.0 * yy, lats, lons)
        grids[f"u_{level}"] = field(8.0 + 0.5 * yy + 0.1 * xx, lats, lons)
        grids[f"v_{level}"] = field(3.0 - 0.2 * yy + 0.3 * xx, lats, lons)

    arrays, out_lats, out_lons = products.prepared_fields_from_grids(grids)
    assert np.array_equal(out_lats, lats)
    assert np.array_equal(out_lons, lons)
    assert arrays["dewpoint2m"].shape == arrays["t2m"].shape
    assert np.all(np.isfinite(arrays["dewpoint2m"]))
    assert np.nanmax(arrays["dewpoint2m"] - arrays["t2m"]) <= 0.01

    for level in products.PRESSURE_LEVELS_HPA:
        for kind in ("theta", "vorticity", "divergence"):
            key = f"{kind}_{level}"
            assert key in arrays
            assert arrays[key].shape == arrays["t2m"].shape
            assert np.all(np.isfinite(arrays[key]))
        assert np.nanmean(arrays[f"theta_{level}"]) > np.nanmean(arrays[f"temp_{level}"] + 273.15)

    for key in ("thetae_850", "frontogenesis_850", "absolute_vorticity_500", "shear_850_500"):
        assert key in arrays
        assert arrays[key].shape == arrays["t2m"].shape
        assert np.all(np.isfinite(arrays[key]))
    assert np.nanmean(arrays["thetae_850"]) > np.nanmean(arrays["theta_850"])
    assert np.nanmin(arrays["absolute_vorticity_500"]) > -5.0
    assert np.nanmin(arrays["shear_850_500"]) >= 0.0

    print("MetPy diagnostics regression test: OK")


if __name__ == "__main__":
    main()
