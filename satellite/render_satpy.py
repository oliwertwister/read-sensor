#!/usr/bin/env python3
"""Optional native MTG/FCI Level-1c renderer using EUMDAC + Satpy.

This path is intentionally additive: the normal WMS renderer runs first and
remains the last-known-good fallback. This script overwrites the compatible
satellite outputs only after the native FCI download and Satpy processing
complete successfully.
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import shutil
import subprocess
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import hdf5plugin  # noqa: F401  # registers HDF5 compression filters
import numpy as np
from PIL import Image
from pyresample import create_area_def
from satpy import Scene, find_files_and_readers

import render_satellite as legacy


COLLECTION = "EO:EUM:DAT:0662"
READER = "fci_l1c_nc"
RESOLUTION_DEGREES = 0.05
NATIVE_LAG_MINUTES = 75
LOOKBACK_MINUTES = 180
# EUMDAC 3.1.1 consumes the search iterator while expanding
# --download-coverage, leaving the subsequent download order empty. These are
# the same Q4 entry patterns used internally by EUMDAC, passed directly so the
# product iterator reaches DownloadApp intact.
Q4_ENTRY_PATTERNS = [
    "*_????_0029.nc",
    "*_????_003[0-9].nc",
    "*_????_0040.nc",
    "*_????_0041.nc",
]
Q4_EXPECTED_ENTRIES = 13


def utc_iso(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if getattr(value, "tzinfo", None) is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def run_checked(command: list[str], *, env: dict[str, str] | None = None) -> None:
    subprocess.run(command, check=True, env=env)


def download_q4(input_dir: Path, start: datetime, end: datetime) -> None:
    key = os.environ.get("EUMETSAT_CONSUMER_KEY", "").strip()
    secret = os.environ.get("EUMETSAT_CONSUMER_SECRET", "").strip()
    if not key or not secret:
        raise RuntimeError("EUMETSAT_CONSUMER_KEY / EUMETSAT_CONSUMER_SECRET are not configured")

    # GitHub-hosted runners are ephemeral. EUMDAC stores the API credentials
    # only in that disposable runner home; they are never copied to Pages.
    run_checked(["eumdac", "set-credentials", key, secret])
    command = [
        "eumdac", "-y", "download",
        "-c", COLLECTION,
        "--start", start.strftime("%Y-%m-%dT%H:%M:%S"),
        "--end", end.strftime("%Y-%m-%dT%H:%M:%S"),
        "--limit", "1",
        "--sort", "sensing",
        "--desc",
        "--entry", *Q4_ENTRY_PATTERNS,
        "--onedir",
        "--no-progress-bars",
        "-o", str(input_dir),
    ]
    run_checked(command)


def europe_area():
    west, south, east, north = legacy.BBOX
    return create_area_def(
        "read_sensor_europe_latlon",
        {"proj": "longlat", "datum": "WGS84"},
        area_extent=[west, south, east, north],
        resolution=RESOLUTION_DEGREES,
        units="degrees",
        description="read-sensor Europe regular latitude/longitude grid",
    )


def load_scene(input_dir: Path):
    files = find_files_and_readers(base_dir=str(input_dir), reader=READER)
    if not files:
        raise RuntimeError(f"Satpy found no {READER} files in {input_dir}")
    source_scene = Scene(filenames=files)
    source_scene.load(["natural_color", "ir_105"], upper_right_corner="NE")
    target = europe_area()
    resampled_scene = source_scene.resample(
        target,
        resampler="nearest",
        radius_of_influence=5000,
    )
    # Keep source_scene alive while lazy resampled datasets are computed. The
    # FCI reader's NetCDF file handlers belong to the source Scene.
    return source_scene, resampled_scene


def save_enhanced(scene: Scene, dataset: str, destination: Path) -> Image.Image:
    png_path = destination.with_suffix(".png")
    scene.save_dataset(dataset, filename=str(png_path), writer="simple_image")
    try:
        with Image.open(png_path) as source:
            image = source.convert("RGB")
    finally:
        png_path.unlink(missing_ok=True)
    return image


def brightness_temperature(scene: Scene) -> tuple[np.ndarray, object]:
    data = scene["ir_105"]
    values = np.asarray(data.values, dtype=np.float32)
    units_name = str(data.attrs.get("units") or "").strip().lower()
    if units_name in {"k", "kelvin", "degrees_k", "degree_k"}:
        values_k = values
    elif units_name in {"c", "degc", "degree_celsius", "degrees_celsius", "°c"}:
        values_k = values + 273.15
    else:
        finite = values[np.isfinite(values)]
        if finite.size == 0:
            raise RuntimeError("Satpy IR 10.5 brightness-temperature grid is empty")
        median = float(np.nanmedian(finite))
        if 150.0 < median < 350.0:
            values_k = values
        else:
            raise RuntimeError(f"Unexpected IR 10.5 units {data.attrs.get('units')!r}")
    return values_k.astype(np.float32, copy=False), data


def write_float_grid(values: np.ndarray, path: Path) -> None:
    contiguous = np.ascontiguousarray(values.astype("<f4", copy=False))
    tmp = path.with_name(path.name + ".tmp")
    with gzip.open(tmp, "wb", compresslevel=6) as handle:
        handle.write(contiguous.tobytes(order="C"))
    os.replace(tmp, path)


def natural_earth_boundaries() -> dict:
    payload = legacy.fetch_bytes(legacy.COUNTRIES_URL, attempts=3)
    countries = json.loads(payload.decode("utf-8"))
    if not countries.get("features"):
        raise RuntimeError("Natural Earth Admin-0 geometry is empty")
    return countries


def render(input_dir: Path, output: Path) -> dict:
    output.mkdir(parents=True, exist_ok=True)
    source_scene, scene = load_scene(input_dir)
    countries = natural_earth_boundaries()

    natural = save_enhanced(scene, "natural_color", output / "_satpy-natural")
    ir_display = save_enhanced(scene, "ir_105", output / "_satpy-ir105")
    bt_k, ir_data = brightness_temperature(scene)

    # Commit compatible files only after all expensive processing succeeded.
    legacy.atomic_save_webp(natural, output / "geocolour-raw.webp")
    legacy.atomic_save_webp(legacy.decorate(natural, countries), output / "geocolour.webp")
    legacy.atomic_save_webp(ir_display, output / "ir105-raw.webp")
    legacy.atomic_save_webp(legacy.decorate(ir_display, countries), output / "ir105.webp")
    write_float_grid(bt_k, output / "ir105-bt.f32.gz")

    observed_at = utc_iso(ir_data.attrs.get("start_time") or ir_data.attrs.get("end_time"))
    generated_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    west, south, east, north = legacy.BBOX
    height, width = bt_k.shape[-2:]
    dx = (east - west) / width
    dy = (north - south) / height

    metadata = {
        "generated_at": generated_at,
        "source": "EUMETSAT Data Store native MTG/FCI Level-1c via EUMDAC + Satpy",
        "backend": "satpy-native-fci-l1c",
        "collection": COLLECTION,
        "reader": READER,
        "bbox": legacy.BBOX,
        "degraded": False,
        "warnings": [],
        "products": {
            "geocolour": {
                "file": "geocolour.webp",
                "raw_file": "geocolour-raw.webp",
                "title": "MTG/FCI natural colour · native Level-1c",
                "subtitle": "Satpy natural_color composite resampled to the read-sensor Europe grid",
                "observed_at": observed_at,
                "stale": False,
            },
            "ir105": {
                "file": "ir105.webp",
                "raw_file": "ir105-raw.webp",
                "title": "MTG/FCI IR 10.5 µm · native Level-1c",
                "subtitle": "Satpy IR 10.5 display plus calibrated brightness-temperature grid",
                "observed_at": observed_at,
                "stale": False,
            },
        },
        "numeric_fields": {
            "sat_ir105_bt": {
                "label": "MTG/FCI IR 10.5 µm brightness temperature",
                "unit": "K",
                "decimals": 1,
                "grid_file": "satellite/ir105-bt.f32.gz",
                "shape": [int(height), int(width)],
                "lat_start": float(north - dy / 2.0),
                "lat_step": float(-dy),
                "lon_start": float(west + dx / 2.0),
                "lon_step": float(dx),
            }
        },
    }
    tmp = output / "latest.json.tmp"
    tmp.write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(tmp, output / "latest.json")
    return metadata


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="satellite/output")
    parser.add_argument("--input-dir", help="Use existing native FCI Level-1c NetCDF chunks instead of downloading")
    parser.add_argument("--lag-minutes", type=int, default=NATIVE_LAG_MINUTES)
    parser.add_argument("--lookback-minutes", type=int, default=LOOKBACK_MINUTES)
    args = parser.parse_args()

    if args.input_dir:
        metadata = render(Path(args.input_dir), Path(args.output))
        print(json.dumps(metadata, indent=2, sort_keys=True))
        return 0

    end = datetime.now(timezone.utc) - timedelta(minutes=args.lag_minutes)
    start = end - timedelta(minutes=args.lookback_minutes)
    with tempfile.TemporaryDirectory(prefix="read-sensor-fci-") as tmp:
        input_dir = Path(tmp)
        download_q4(input_dir, start, end)
        nc_files = sorted(input_dir.rglob("*.nc"))
        if not nc_files:
            raise RuntimeError("EUMDAC completed but no FCI NetCDF chunks were downloaded")
        print(f"Downloaded {len(nc_files)} native FCI NetCDF chunks")
        if len(nc_files) < Q4_EXPECTED_ENTRIES:
            raise RuntimeError(
                f"Incomplete native FCI Q4 download: {len(nc_files)} of "
                f"{Q4_EXPECTED_ENTRIES} expected NetCDF chunks"
            )
        metadata = render(input_dir, Path(args.output))
    print(json.dumps(metadata, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
