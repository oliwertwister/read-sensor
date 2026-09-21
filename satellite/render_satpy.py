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
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import dask
import hdf5plugin  # noqa: F401  # registers HDF5 compression filters
import numpy as np
from PIL import Image
from pyresample import create_area_def
from satpy import Scene, find_files_and_readers

import render_satellite as legacy
from monitor.telemetry import record_transfer


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

COMPOSITE_SPECS = {
    "airmass": {
        "dataset": "airmass",
        "file_stem": "airmass",
        "title": "FCI Airmass RGB",
        "subtitle": "Water-vapour / thermal-IR RGB for air-mass boundaries and dry intrusions",
        "definition": "Airmass RGB combines water-vapour and infrared channel differences to emphasize contrasting air masses, upper-level moisture and dry intrusions.",
        "method": "Native FCI Level-1c channels processed by Satpy's built-in airmass composite, then nearest-neighbour resampled to the Europe grid and encoded as WebP.",
    },
    "day_severe_storms": {
        "dataset": "day_severe_storms",
        "file_stem": "day-severe-storms",
        "title": "FCI Day Severe Storms RGB",
        "subtitle": "Daytime RGB emphasizing vigorous convection and cloud microphysics",
        "definition": "Day Severe Storms RGB combines visible, near-infrared and thermal/water-vapour channel differences to highlight vigorous convective clouds and microphysical differences.",
        "method": "Native FCI Level-1c channels processed by Satpy day_severe_storms, then nearest-neighbour resampled and encoded as WebP.",
    },
    "cloud_phase": {
        "dataset": "cloud_phase",
        "file_stem": "cloud-phase",
        "title": "FCI Cloud Phase RGB",
        "subtitle": "Daytime cloud liquid/ice phase and particle-size discrimination",
        "definition": "Cloud Phase RGB uses visible and near-infrared reflectances to help distinguish liquid-water, ice and mixed cloud characteristics during daylight.",
        "method": "Native FCI Level-1c channels processed by Satpy cloud_phase with solar-geometry corrections, then resampled and encoded as WebP.",
    },
    "cloud_type": {
        "dataset": "cloud_type",
        "file_stem": "cloud-type",
        "title": "FCI Cloud Type RGB",
        "subtitle": "Daytime cloud-type discrimination from visible/NIR channels",
        "definition": "Cloud Type RGB combines near-infrared and visible reflectances to distinguish broad cloud types and surface/cloud contrasts during daylight.",
        "method": "Native FCI Level-1c channels processed by Satpy cloud_type with solar-geometry corrections, then resampled and encoded as WebP.",
    },
    "fire_temperature": {
        "dataset": "fire_temperature",
        "file_stem": "fire-temperature",
        "title": "FCI Fire Temperature RGB",
        "subtitle": "Hot-spot visualization using 3.8, 2.2 and 1.6 µm channels",
        "definition": "Fire Temperature RGB emphasizes hot pixels and helps separate lower-temperature from more intense fires using shortwave/near-infrared channels.",
        "method": "Native FCI Level-1c ir_38, nir_22 and nir_16 channels processed by Satpy fire_temperature, then resampled and encoded as WebP.",
    },
    "snow": {
        "dataset": "snow",
        "file_stem": "snow",
        "title": "FCI Snow RGB",
        "subtitle": "Daytime snow/ice versus cloud discrimination",
        "definition": "Snow RGB exploits visible, near-infrared and shortwave-infrared behaviour to separate snow/ice from many cloud types during daylight.",
        "method": "Native FCI Level-1c channels processed by Satpy snow, then nearest-neighbour resampled and encoded as WebP.",
    },
    "geo_color": {
        "dataset": "geo_color",
        "file_stem": "geo-color",
        "title": "FCI GeoColor",
        "subtitle": "Day/night blend: true colour by day and enhanced cloud presentation at night",
        "definition": "GeoColor blends a true-colour daytime view with infrared cloud layers and a night background to provide a continuous day/night presentation.",
        "method": "Native FCI Level-1c channels processed by Satpy geo_color. Its night background may require Satpy auxiliary static imagery; failures are reported without breaking the core satellite path.",
    },
    "ir_sandwich": {
        "dataset": "ir_sandwich",
        "file_stem": "ir-sandwich",
        "title": "FCI IR Sandwich",
        "subtitle": "Visible cloud texture combined with colourized IR cloud-top temperature",
        "definition": "IR Sandwich combines high-resolution visible cloud texture with colourized 10.5 µm infrared information, making convective cloud structure and cold tops easy to compare.",
        "method": "Native FCI Level-1c vis_06 and ir_105 processed by Satpy ir_sandwich, then resampled and encoded as WebP.",
    },
}


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


def scene_files(input_dir: Path):
    files = find_files_and_readers(base_dir=str(input_dir), reader=READER)
    if not files:
        raise RuntimeError(f"Satpy found no {READER} files in {input_dir}")
    return files


def resample_scene(files, datasets: list[str], target):
    source_scene = Scene(filenames=files)
    source_scene.load(datasets, upper_right_corner="NE")
    resampled_scene = source_scene.resample(
        target,
        resampler="nearest",
        radius_of_influence=5000,
    )
    return source_scene, resampled_scene


def load_scene(input_dir: Path):
    files = scene_files(input_dir)
    target = europe_area()
    warnings = []

    # Keep GeoColor out of the shared graph. It pulls Satpy auxiliary imagery,
    # so an auxiliary-reader failure must not abort the other FCI composites.
    shared_specs = {k: v for k, v in COMPOSITE_SPECS.items() if k != "geo_color"}
    shared_datasets = ["natural_color", "ir_105", *[cfg["dataset"] for cfg in shared_specs.values()]]
    source_scene, resampled_scene = resample_scene(files, shared_datasets, target)

    loaded_composites = []
    for key, cfg in shared_specs.items():
        if cfg["dataset"] in resampled_scene:
            loaded_composites.append(key)
        else:
            warnings.append(f"{key}: Satpy did not expose {cfg['dataset']} after resampling")

    geo_source = None
    geo_scene = None
    try:
        geo_source, geo_scene = resample_scene(files, ["geo_color"], target)
        if "geo_color" not in geo_scene:
            warnings.append("geo_color: Satpy did not expose geo_color after resampling")
            geo_source = None
            geo_scene = None
    except Exception as error:
        warnings.append(f"geo_color: isolated load/resample failed: {type(error).__name__}: {error}")

    return source_scene, resampled_scene, loaded_composites, warnings, geo_source, geo_scene


def save_enhanced(scene: Scene, dataset: str, destination: Path) -> Image.Image:
    png_path = destination.with_suffix(".png")
    scene.save_dataset(dataset, filename=str(png_path), writer="simple_image")
    try:
        with Image.open(png_path) as source:
            # Trollimage writes invalid/masked Satpy pixels as an alpha band
            # when fill_value is left unset. Preserve it: converting to RGB
            # turns daylight/no-data masks into the black rectangles that were
            # previously visible in Leaflet.
            image = source.convert("RGBA")
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


def webp_storage(output: Path, stem: str) -> dict:
    decorated = output / f"{stem}.webp"
    raw = output / f"{stem}-raw.webp"
    decorated_bytes = decorated.stat().st_size
    raw_bytes = raw.stat().st_size
    return {
        "bytes": decorated_bytes + raw_bytes,
        "decorated_bytes": decorated_bytes,
        "raw_bytes": raw_bytes,
        "files": 2,
    }


def natural_earth_boundaries() -> dict:
    payload = legacy.fetch_bytes(legacy.COUNTRIES_URL, attempts=3)
    countries = json.loads(payload.decode("utf-8"))
    if not countries.get("features"):
        raise RuntimeError("Natural Earth Admin-0 geometry is empty")
    return countries


def render(input_dir: Path, output: Path) -> dict:
    output.mkdir(parents=True, exist_ok=True)
    # netCDF-C access used by the FCI reader is not safe under concurrent
    # threaded reads. Keep the native FCI graph single-threaded while it is
    # materialized; this does not affect the separate ICON/MetPy pipeline.
    with dask.config.set(scheduler="synchronous"):
        (
            source_scene,
            scene,
            loaded_composites,
            composite_warnings,
            geo_source,
            geo_scene,
        ) = load_scene(input_dir)
        countries = natural_earth_boundaries()

        natural = save_enhanced(scene, "natural_color", output / "_satpy-natural")
        ir_display = save_enhanced(scene, "ir_105", output / "_satpy-ir105")
        bt_k, ir_data = brightness_temperature(scene)

        composite_images = {}
        for key in loaded_composites:
            cfg = COMPOSITE_SPECS[key]
            try:
                composite_images[key] = save_enhanced(scene, cfg["dataset"], output / f"_satpy-{cfg['file_stem']}")
            except Exception as error:
                composite_warnings.append(f"{key}: render failed: {type(error).__name__}: {error}")

        if geo_scene is not None:
            cfg = COMPOSITE_SPECS["geo_color"]
            try:
                composite_images["geo_color"] = save_enhanced(
                    geo_scene,
                    cfg["dataset"],
                    output / f"_satpy-{cfg['file_stem']}",
                )
            except Exception as error:
                composite_warnings.append(f"geo_color: isolated render failed: {type(error).__name__}: {error}")

    # Commit compatible files only after all expensive processing succeeded.
    legacy.atomic_save_webp(natural, output / "geocolour-raw.webp")
    legacy.atomic_save_webp(legacy.decorate(natural, countries), output / "geocolour.webp")
    legacy.atomic_save_webp(ir_display, output / "ir105-raw.webp")
    legacy.atomic_save_webp(legacy.decorate(ir_display, countries), output / "ir105.webp")
    write_float_grid(bt_k, output / "ir105-bt.f32.gz")
    for key, image in composite_images.items():
        stem = COMPOSITE_SPECS[key]["file_stem"]
        legacy.atomic_save_webp(image, output / f"{stem}-raw.webp")
        legacy.atomic_save_webp(legacy.decorate(image, countries), output / f"{stem}.webp")

    observed_at = utc_iso(ir_data.attrs.get("start_time") or ir_data.attrs.get("end_time"))
    generated_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    west, south, east, north = legacy.BBOX
    height, width = bt_k.shape[-2:]
    dx = (east - west) / width
    dy = (north - south) / height

    metadata = {
        "generated_at": generated_at,
        "source": "EUMETSAT Data Store native Meteosat FCI Level-1c via EUMDAC + Satpy",
        "backend": "satpy-native-fci-l1c",
        "platform": "Meteosat Third Generation",
        "instrument": "FCI",
        "nominal_cadence_minutes": 10,
        "boundary_overlay": "Native FCI Level-1c → Satpy composite/calibration → Europe resampling; optional grid and Natural Earth Admin-0 overlay",
        "collection": COLLECTION,
        "reader": READER,
        "bbox": legacy.BBOX,
        "degraded": False,
        "warnings": [],
        "products": {
            "geocolour": {
                "file": "geocolour.webp",
                "raw_file": "geocolour-raw.webp",
                "title": "Meteosat FCI · Natural colour · native Level-1c",
                "subtitle": "Satpy natural_color composite resampled to the read-sensor Europe grid",
                "definition": "A multispectral RGB composite designed to approximate a natural daytime appearance of clouds and the surface.",
                "method": "Native FCI Level-1c NetCDF → Satpy fci_l1c_nc → natural_color composite → nearest-neighbour Europe resampling → WebP.",
                "source_kind": "native-derived",
                "observed_at": observed_at,
                "stale": False,
            },
            "ir105": {
                "file": "ir105.webp",
                "raw_file": "ir105-raw.webp",
                "title": "Meteosat FCI · Infrared 10.5 µm · native Level-1c",
                "subtitle": "Satpy IR 10.5 display plus calibrated brightness-temperature grid",
                "definition": "Thermal infrared radiation near 10.5 µm; colder brightness temperatures usually correspond to higher cloud tops.",
                "method": "Native FCI Level-1c NetCDF → Satpy fci_l1c_nc → calibrated ir_105 dataset → nearest-neighbour Europe resampling; WebP display and Float32 kelvin grid are generated separately.",
                "source_kind": "native-derived",
                "observed_at": observed_at,
                "stale": False,
            },
        },
        "composite_warnings": composite_warnings,
        "numeric_fields": {
            "sat_ir105_bt": {
                "label": "FCI 10.5 µm brightness temperature",
                "unit": "K",
                "decimals": 1,
                "definition": "Brightness temperature is the blackbody-equivalent temperature corresponding to the measured 10.5 µm infrared radiance.",
                "method": "Native EUMETSAT FCI Level-1c NetCDF read with Satpy fci_l1c_nc; Satpy ir_105 calibrated values are resampled by nearest neighbour and written as a Float32 kelvin grid.",
                "grid_file": "satellite/ir105-bt.f32.gz",
                "shape": [int(height), int(width)],
                "lat_start": float(north - dy / 2.0),
                "lat_step": float(-dy),
                "lon_start": float(west + dx / 2.0),
                "lon_step": float(dx),
            }
        },
    }
    for key, image in composite_images.items():
        cfg = COMPOSITE_SPECS[key]
        stem = cfg["file_stem"]
        metadata["products"][key] = {
            "file": f"{stem}.webp",
            "raw_file": f"{stem}-raw.webp",
            "title": cfg["title"],
            "subtitle": cfg["subtitle"],
            "observed_at": observed_at,
            "stale": False,
            "definition": cfg["definition"],
            "method": cfg["method"],
            "source_kind": "native-derived",
            "storage": webp_storage(output, stem),
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
        download_started = time.perf_counter()
        download_q4(input_dir, start, end)
        nc_files = sorted(input_dir.rglob("*.nc"))
        record_transfer(
            "https://data.eumetsat.int/",
            sum(path.stat().st_size for path in nc_files),
            time.perf_counter() - download_started,
            source="EUMETSAT Data Store",
            category="native FCI Level-1c",
        )
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
