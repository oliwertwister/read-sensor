"""Zarr v3/sharded storage for the ICON-EU numerical cube."""
from __future__ import annotations

import json
import shutil
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import zarr
from zarr.codecs import BloscCodec

GRAVITY = 9.80665


def iso_z(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


class IconZarrCubeWriter:
    """Write one ICON-EU run as a bounded time/level multidimensional Zarr v3 cube."""

    def __init__(self, path: Path, *, run: datetime, leads: list[int], levels: tuple[int, ...], lats: np.ndarray, lons: np.ndarray):
        self.path = Path(path)
        if self.path.exists():
            shutil.rmtree(self.path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.run = run
        self.leads = list(leads)
        self.levels = tuple(int(x) for x in levels)
        self.lats = np.asarray(lats, dtype=np.float32)
        self.lons = np.asarray(lons, dtype=np.float32)
        self.valid_times = [run + timedelta(hours=int(lead)) for lead in self.leads]
        self.group = zarr.open_group(
            str(self.path), mode="w", zarr_format=3,
            attributes={
                "title": "DWD ICON-EU bounded multidimensional cube",
                "source": "DWD ICON-EU regular-lat-lon GRIB2",
                "run_at": iso_z(run),
                "Conventions": "CF-1.11",
                "storage": "Zarr v3 sharding_indexed + Blosc/Zstd",
            },
        )
        self._compressor = [BloscCodec(cname="zstd", clevel=3, shuffle="bitshuffle")]
        self._create_coordinates()
        self._create_variables()

    def _coord(self, name: str, data: np.ndarray, dims: tuple[str, ...], attrs: dict):
        arr = self.group.create_array(
            name, data=np.asarray(data), chunks=np.asarray(data).shape,
            compressors=self._compressor, dimension_names=dims, attributes=attrs,
        )
        return arr

    def _create_coordinates(self):
        epoch_seconds = np.asarray([int(t.timestamp()) for t in self.valid_times], dtype=np.int64)
        self._coord("time", epoch_seconds, ("time",), {
            "standard_name": "time", "units": "seconds since 1970-01-01 00:00:00 UTC", "calendar": "proleptic_gregorian"
        })
        self._coord("forecast_hour", np.asarray(self.leads, dtype=np.int16), ("time",), {"units": "h"})
        self._coord("pressure_level", np.asarray(self.levels, dtype=np.int16), ("pressure_level",), {
            "standard_name": "air_pressure", "units": "hPa", "positive": "down"
        })
        self._coord("latitude", self.lats, ("latitude",), {"standard_name": "latitude", "units": "degrees_north"})
        self._coord("longitude", self.lons, ("longitude",), {"standard_name": "longitude", "units": "degrees_east"})

    def _array(self, name: str, shape: tuple[int, ...], dims: tuple[str, ...], attrs: dict):
        if len(shape) == 3:
            chunks = (1, 128, 128)
            shards = (1, 512, 512)
        elif len(shape) == 4:
            chunks = (1, 1, 128, 128)
            shards = (1, 1, 512, 512)
        else:
            raise ValueError(shape)
        return self.group.create_array(
            name, shape=shape, dtype="f4", chunks=chunks, shards=shards,
            compressors=self._compressor, fill_value=np.nan,
            dimension_names=dims, attributes=attrs,
        )

    def _create_variables(self):
        nt, nz, ny, nx = len(self.leads), len(self.levels), len(self.lats), len(self.lons)
        surf_dims = ("time", "latitude", "longitude")
        pressure_dims = ("time", "pressure_level", "latitude", "longitude")
        self.arrays = {
            "temperature_2m": self._array("temperature_2m", (nt, ny, nx), surf_dims, {"standard_name":"air_temperature", "units":"K", "height_m":2.0}),
            "pmsl": self._array("pmsl", (nt, ny, nx), surf_dims, {"standard_name":"air_pressure_at_mean_sea_level", "units":"Pa"}),
            "relative_humidity_2m": self._array("relative_humidity_2m", (nt, ny, nx), surf_dims, {"standard_name":"relative_humidity", "units":"%", "height_m":2.0}),
            "cloud_cover": self._array("cloud_cover", (nt, ny, nx), surf_dims, {"standard_name":"cloud_area_fraction", "units":"%"}),
            "precipitation": self._array("precipitation", (nt, ny, nx), surf_dims, {"long_name":"accumulated total precipitation since model initialization", "units":"kg m-2"}),
            "u10": self._array("u10", (nt, ny, nx), surf_dims, {"standard_name":"eastward_wind", "units":"m s-1", "height_m":10.0}),
            "v10": self._array("v10", (nt, ny, nx), surf_dims, {"standard_name":"northward_wind", "units":"m s-1", "height_m":10.0}),
            "temperature": self._array("temperature", (nt, nz, ny, nx), pressure_dims, {"standard_name":"air_temperature", "units":"K"}),
            "geopotential_height": self._array("geopotential_height", (nt, nz, ny, nx), pressure_dims, {"standard_name":"geopotential_height", "units":"m"}),
            "relative_humidity": self._array("relative_humidity", (nt, nz, ny, nx), pressure_dims, {"standard_name":"relative_humidity", "units":"%"}),
            "u": self._array("u", (nt, nz, ny, nx), pressure_dims, {"standard_name":"eastward_wind", "units":"m s-1"}),
            "v": self._array("v", (nt, nz, ny, nx), pressure_dims, {"standard_name":"northward_wind", "units":"m s-1"}),
        }

    @staticmethod
    def _values(grid) -> np.ndarray:
        return np.asarray(grid.values, dtype=np.float32)

    def write_time(self, time_index: int, grids: dict[str, object]):
        a = self.arrays
        a["temperature_2m"][time_index, :, :] = self._values(grids["t_2m"])
        a["pmsl"][time_index, :, :] = self._values(grids["pmsl"])
        a["relative_humidity_2m"][time_index, :, :] = self._values(grids["relhum_2m"])
        a["cloud_cover"][time_index, :, :] = self._values(grids["clct"])
        a["precipitation"][time_index, :, :] = self._values(grids["tot_prec"])
        a["u10"][time_index, :, :] = self._values(grids["u_10m"])
        a["v10"][time_index, :, :] = self._values(grids["v_10m"])
        for level_index, level in enumerate(self.levels):
            a["temperature"][time_index, level_index, :, :] = self._values(grids[f"t_{level}"])
            a["geopotential_height"][time_index, level_index, :, :] = self._values(grids[f"fi_{level}"]) / GRAVITY
            a["relative_humidity"][time_index, level_index, :, :] = self._values(grids[f"rh_{level}"])
            a["u"][time_index, level_index, :, :] = self._values(grids[f"u_{level}"])
            a["v"][time_index, level_index, :, :] = self._values(grids[f"v_{level}"])

    def manifest(self) -> dict:
        return {
            "version": 1,
            "format": "zarr-v3",
            "run_at": iso_z(self.run),
            "valid_times": [iso_z(x) for x in self.valid_times],
            "forecast_hours": self.leads,
            "pressure_levels_hpa": list(self.levels),
            "shape": {"time":len(self.leads), "pressure_level":len(self.levels), "latitude":len(self.lats), "longitude":len(self.lons)},
            "chunking": {"surface":[1,128,128], "pressure":[1,1,128,128]},
            "sharding": {"surface":[1,512,512], "pressure":[1,1,512,512]},
            "compression": "Blosc/Zstd level 3 + bitshuffle",
            "variables": list(self.arrays),
        }

    def write_manifest(self, path: Path):
        path.write_text(json.dumps(self.manifest(), indent=2, sort_keys=True) + "\n", encoding="utf-8")
