#!/usr/bin/env python3
"""Build static + interactive ICON-EU products for the Leaflet dashboard."""

from __future__ import annotations

import argparse
import gzip
import json
import math
import re
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from PIL import Image

import render_icon_synoptic as syn


FIELD_SPECS = {
    "t_2m": {"directory": "t_2m", "kind": "single-level", "variable": "T_2M"},
    "pmsl": {"directory": "pmsl", "kind": "single-level", "variable": "PMSL"},
    "u_10m": {"directory": "u_10m", "kind": "single-level", "variable": "U_10M"},
    "v_10m": {"directory": "v_10m", "kind": "single-level", "variable": "V_10M"},
    "relhum_2m": {"directory": "relhum_2m", "kind": "single-level", "variable": "RELHUM_2M"},
    "clct": {"directory": "clct", "kind": "single-level", "variable": "CLCT"},
    "tot_prec": {"directory": "tot_prec", "kind": "single-level", "variable": "TOT_PREC"},
    "t_850": {"directory": "t", "kind": "pressure-level", "level": "850", "variable": "T"},
    "fi_500": {"directory": "fi", "kind": "pressure-level", "level": "500", "variable": "FI"},
}

FILE_RE = re.compile(
    r'href="(icon-eu_europe_regular-lat-lon_(single-level|pressure-level)_'
    r'(\d{10})_(\d{3})(?:_(\d+))?_([A-Z0-9_.]+)\.grib2\.bz2)"'
)

DISPLAY_SPECS = {
    "t2m": {
        "label": "2 m temperature", "unit": "degrees_celsius", "cmap": "coolwarm",
        "vmin": -20.0, "vmax": 40.0, "contours": list(np.arange(-40, 42, 2)),
        "line_color": "#101010", "decimals": 1,
    },
    "pmsl": {
        "label": "Mean sea-level pressure", "unit": "hPa", "cmap": "viridis",
        "vmin": 960.0, "vmax": 1040.0, "contours": list(np.arange(940, 1061, 4)),
        "line_color": "#ffffff", "decimals": 1,
    },
    "rh2m": {
        "label": "2 m relative humidity", "unit": "%", "cmap": "YlGnBu",
        "vmin": 0.0, "vmax": 100.0, "contours": [20, 40, 60, 80, 90, 100],
        "line_color": "#166b8f", "decimals": 0,
    },
    "cloud": {
        "label": "Total cloud cover", "unit": "%", "cmap": "Greys",
        "vmin": 0.0, "vmax": 100.0, "contours": [20, 40, 60, 80, 100],
        "line_color": "#555555", "decimals": 0,
    },
    "precip": {
        "label": "Accumulated precipitation", "unit": "mm", "cmap": "Blues",
        "vmin": 0.0, "vmax": 30.0, "contours": [0.5, 1, 2, 5, 10, 20, 30, 50],
        "line_color": "#1261a0", "decimals": 1,
    },
    "t850": {
        "label": "850 hPa temperature", "unit": "degrees_celsius", "cmap": "coolwarm",
        "vmin": -30.0, "vmax": 30.0, "contours": list(np.arange(-40, 36, 5)),
        "line_color": "#6d1f1f", "decimals": 1,
    },
    "z500": {
        "label": "500 hPa geopotential height", "unit": "dam", "cmap": "cividis",
        "vmin": 500.0, "vmax": 600.0, "contours": list(np.arange(480, 621, 6)),
        "line_color": "#5d3a9b", "decimals": 1,
    },
    "wind": {
        "label": "10 m wind speed", "unit": "m/s", "cmap": "plasma",
        "vmin": 0.0, "vmax": 25.0, "contours": [5, 10, 15, 20, 25, 30],
        "line_color": "#9b4f00", "decimals": 1,
    },
}


def list_field(cycle: str, key: str, cache: dict) -> list[dict]:
    spec = FIELD_SPECS[key]
    cache_key = (cycle, spec["directory"])
    if cache_key not in cache:
        url = f"{syn.BASE}/{cycle}/{spec['directory']}/"
        cache[cache_key] = syn.fetch_bytes(url, timeout=30).decode("utf-8", errors="replace")
    text = cache[cache_key]
    rows = []
    for filename, kind, run_text, lead_text, level, variable in FILE_RE.findall(text):
        if kind != spec["kind"] or variable != spec["variable"]:
            continue
        wanted_level = str(spec.get("level") or "")
        if (level or "") != wanted_level:
            continue
        run = datetime.strptime(run_text, "%Y%m%d%H").replace(tzinfo=timezone.utc)
        lead = int(lead_text)
        rows.append({
            "filename": filename,
            "run": run,
            "lead": lead,
            "valid": run + timedelta(hours=lead),
            "url": f"{syn.BASE}/{cycle}/{spec['directory']}/{filename}",
        })
    return rows


def discover_selection(now: datetime) -> tuple[datetime, int, dict[str, str]]:
    cache: dict[tuple[str, str], str] = {}
    candidates = []
    for cycle in syn.CYCLES:
        candidates.extend((cycle, row) for row in list_field(cycle, "t_2m", cache))
    if not candidates:
        raise RuntimeError("No ICON-EU T_2M products advertised by DWD")
    candidates.sort(key=lambda item: (
        abs((item[1]["valid"] - now).total_seconds()),
        -item[1]["run"].timestamp(),
        item[1]["lead"],
    ))

    for cycle, selected in candidates:
        run, lead = selected["run"], selected["lead"]
        urls = {"t_2m": selected["url"]}
        complete = True
        for key in FIELD_SPECS:
            if key == "t_2m":
                continue
            rows = list_field(cycle, key, cache)
            match = next((row for row in rows if row["run"] == run and row["lead"] == lead), None)
            if not match:
                complete = False
                break
            urls[key] = match["url"]
        if complete:
            return run, lead, urls
    raise RuntimeError("Could not find a complete ICON-EU interactive field set")


def discover_time_series(now: datetime, radius: int = 1) -> tuple[datetime, list[tuple[int, dict[str, str]]], int]:
    """Return a bounded set of complete leads from one run around current time."""
    run, selected_lead, _ = discover_selection(now)
    cycle = f"{run.hour:02d}"
    cache: dict[tuple[str, str], str] = {}
    rows_by_field = {key: list_field(cycle, key, cache) for key in FIELD_SPECS}
    leads_by_field = {
        key: {row["lead"]: row for row in rows if row["run"] == run}
        for key, rows in rows_by_field.items()
    }
    common = sorted(set.intersection(*(set(rows) for rows in leads_by_field.values())))
    if not common:
        raise RuntimeError(f"No complete ICON-EU leads for run {run.isoformat()}")
    valid_times = [run + timedelta(hours=lead) for lead in common]
    past_indices = [index for index, valid in enumerate(valid_times) if valid <= now]
    current_full_index = past_indices[-1] if past_indices else 0
    start = max(0, current_full_index - radius)
    stop = min(len(common), current_full_index + radius + 1)
    # Preserve the requested window width near the edges.
    width = min(len(common), radius * 2 + 1)
    if stop - start < width:
        if start == 0:
            stop = min(len(common), width)
        else:
            start = max(0, len(common) - width)
    selected = []
    for lead in common[start:stop]:
        urls = {key: leads_by_field[key][lead]["url"] for key in FIELD_SPECS}
        selected.append((lead, urls))
    current_index = next(
        (index for index, (lead, _) in enumerate(selected) if lead == common[current_full_index]),
        min(range(len(selected)), key=lambda index: abs(selected[index][0] - selected_lead)),
    )
    return run, selected, current_index


def regular_grid(data):
    data = syn.normalize_grid(data)
    lat_name = "latitude" if "latitude" in data.coords else "lat"
    lon_name = "longitude" if "longitude" in data.coords else "lon"
    if float(data[lat_name][0]) < float(data[lat_name][-1]):
        data = data.sortby(lat_name, ascending=False)
    if float(data[lon_name][0]) > float(data[lon_name][-1]):
        data = data.sortby(lon_name)
    return data
def prepared_fields(raw: dict) -> tuple[dict[str, np.ndarray], np.ndarray, np.ndarray]:
    grids = {key: regular_grid(value) for key, value in raw.items()}
    base = grids["t_2m"]
    lat_name = "latitude" if "latitude" in base.coords else "lat"
    lon_name = "longitude" if "longitude" in base.coords else "lon"
    lats = np.asarray(base[lat_name].values, dtype=np.float64)
    lons = np.asarray(base[lon_name].values, dtype=np.float64)

    arrays = {
        "t2m": np.asarray(grids["t_2m"].values, dtype=np.float32) - 273.15,
        "pmsl": np.asarray(grids["pmsl"].values, dtype=np.float32) / 100.0,
        "rh2m": np.asarray(grids["relhum_2m"].values, dtype=np.float32),
        "cloud": np.asarray(grids["clct"].values, dtype=np.float32),
        "precip": np.asarray(grids["tot_prec"].values, dtype=np.float32),
        "t850": np.asarray(grids["t_850"].values, dtype=np.float32) - 273.15,
        "z500": np.asarray(grids["fi_500"].values, dtype=np.float32) / 9.80665 / 10.0,
    }
    u = np.asarray(grids["u_10m"].values, dtype=np.float32)
    v = np.asarray(grids["v_10m"].values, dtype=np.float32)
    arrays["wind"] = np.hypot(u, v).astype(np.float32)
    arrays["_u10"] = u
    arrays["_v10"] = v

    shape = arrays["t2m"].shape
    for key, array in arrays.items():
        if array.shape != shape:
            raise RuntimeError(f"Grid mismatch for {key}: {array.shape} != {shape}")
    return arrays, lats, lons


def rgb_hex(rgb) -> str:
    values = np.clip(np.asarray(rgb[:3]) * 255.0, 0, 255).astype(int)
    return "#" + "".join(f"{value:02x}" for value in values)


def color_stops(spec: dict, count: int = 7) -> list[dict]:
    cmap = matplotlib.colormaps[spec["cmap"]]
    values = np.linspace(spec["vmin"], spec["vmax"], count)
    return [
        {"value": float(value), "color": rgb_hex(cmap(i / (count - 1)))}
        for i, value in enumerate(values)
    ]


def render_fill(array: np.ndarray, spec: dict, output: Path) -> None:
    finite = np.isfinite(array)
    normalized = np.clip((array - spec["vmin"]) / (spec["vmax"] - spec["vmin"]), 0.0, 1.0)
    rgba = (matplotlib.colormaps[spec["cmap"]](normalized) * 255.0).astype(np.uint8)
    rgba[..., 3] = np.where(finite, 255, 0).astype(np.uint8)
    image = Image.fromarray(rgba, mode="RGBA")
    image = image.resize(
        (image.width * 2, image.height * 2),
        resample=Image.Resampling.BILINEAR,
    )
    image.save(output, "WEBP", quality=88, method=6)


def contour_geojson(
    lons: np.ndarray,
    lats: np.ndarray,
    array: np.ndarray,
    spec: dict,
    output: Path,
) -> None:
    finite = array[np.isfinite(array)]
    if finite.size == 0:
        output.write_text('{"type":"FeatureCollection","features":[]}\n', encoding="utf-8")
        return
    lo, hi = float(np.nanmin(finite)), float(np.nanmax(finite))
    levels = [float(level) for level in spec["contours"] if lo <= float(level) <= hi]
    features = []
    if levels:
        fig, ax = plt.subplots(figsize=(2, 2), dpi=50)
        contour = ax.contour(lons, lats, array, levels=levels)
        for level, segments in zip(contour.levels, contour.allsegs):
            ranked = sorted((segment for segment in segments if len(segment) >= 2), key=len, reverse=True)
            for index, segment in enumerate(ranked):
                step = max(1, len(segment) // 1200)
                sampled = segment[::step]
                if not np.array_equal(sampled[-1], segment[-1]):
                    sampled = np.vstack([sampled, segment[-1]])
                coords = [[round(float(x), 5), round(float(y), 5)] for x, y in sampled]
                features.append({
                    "type": "Feature",
                    "properties": {
                        "level": float(level),
                        "label": index == 0,
                        "text": f"{level:.{spec['decimals']}f} {spec['unit']}",
                    },
                    "geometry": {"type": "LineString", "coordinates": coords},
                })
        plt.close(fig)
    payload = {"type": "FeatureCollection", "features": features}
    output.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")


def write_grid(array: np.ndarray, output: Path) -> None:
    contiguous = np.ascontiguousarray(array.astype("<f4", copy=False))
    with gzip.open(output, "wb", compresslevel=6) as handle:
        handle.write(contiguous.tobytes(order="C"))
def wind_vectors_geojson(
    lons: np.ndarray,
    lats: np.ndarray,
    u: np.ndarray,
    v: np.ndarray,
    output: Path,
    spacing_degrees: float = 2.0,
) -> None:
    lon_step = abs(float(np.median(np.diff(lons))))
    lat_step = abs(float(np.median(np.diff(lats))))
    xs = max(1, round(spacing_degrees / lon_step))
    ys = max(1, round(spacing_degrees / lat_step))
    features = []
    for iy in range(0, len(lats), ys):
        for ix in range(0, len(lons), xs):
            uu, vv = float(u[iy, ix]), float(v[iy, ix])
            if not math.isfinite(uu) or not math.isfinite(vv):
                continue
            speed = math.hypot(uu, vv)
            to_degrees = (math.degrees(math.atan2(uu, vv)) + 360.0) % 360.0
            features.append({
                "type": "Feature",
                "properties": {
                    "u": round(uu, 2), "v": round(vv, 2),
                    "speed": round(speed, 2), "to_degrees": round(to_degrees, 1),
                },
                "geometry": {
                    "type": "Point",
                    "coordinates": [round(float(lons[ix]), 5), round(float(lats[iy]), 5)],
                },
            })
    output.write_text(
        json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
def interactive_metadata(
    arrays: dict[str, np.ndarray],
    lats: np.ndarray,
    lons: np.ndarray,
    output_dir: Path,
    run: datetime,
    lead: int,
    public_prefix: str = "model",
) -> dict:
    south, north = float(np.min(lats)), float(np.max(lats))
    west, east = float(np.min(lons)), float(np.max(lons))
    fields = {}
    layers = []
    lon_spacing = abs(float(np.median(np.diff(lons))))
    lat_spacing = abs(float(np.median(np.diff(lats))))
    raster_bounds = [
        [south - lat_spacing / 2.0, west - lon_spacing / 2.0],
        [north + lat_spacing / 2.0, east + lon_spacing / 2.0],
    ]

    defaults = {
        "t2m": {"fill": True, "contours": True},
        "pmsl": {"fill": False, "contours": True},
        "wind": {"fill": False, "contours": False},
    }
    for field_id, spec in DISPLAY_SPECS.items():
        array = arrays[field_id]
        fill_file = f"{field_id}-fill.webp"
        contour_file = f"{field_id}-contours.geojson"
        grid_file = f"{field_id}.f32.gz"
        render_fill(array, spec, output_dir / fill_file)
        contour_geojson(lons, lats, array, spec, output_dir / contour_file)
        write_grid(array, output_dir / grid_file)

        fields[field_id] = {
            "label": spec["label"],
            "unit": spec["unit"],
            "decimals": spec["decimals"],
            "grid_file": f"{public_prefix}/{grid_file}",
            "fill_file": f"{public_prefix}/{fill_file}",
            "contour_file": f"{public_prefix}/{contour_file}",
            "range": [spec["vmin"], spec["vmax"]],
            "color_stops": color_stops(spec),
            "shape": [int(array.shape[0]), int(array.shape[1])],
            "lat_start": float(lats[0]), "lat_step": float(np.median(np.diff(lats))),
            "lon_start": float(lons[0]), "lon_step": float(np.median(np.diff(lons))),
        }
        enabled = defaults.get(field_id, {})
        layers.extend([
            {
                "id": f"{field_id}_fill", "field": field_id, "kind": "raster",
                "label": f"{spec['label']} · colour", "group": "ICON-EU fields",
                "file": f"{public_prefix}/{fill_file}", "bounds": raster_bounds,
                "default": bool(enabled.get("fill")), "opacity": 0.55,
                "display_resampling": "bilinear_2x",
            },
            {
                "id": f"{field_id}_contours", "field": field_id, "kind": "contours",
                "label": f"{spec['label']} · isolines", "group": "ICON-EU fields",
                "file": f"{public_prefix}/{contour_file}", "line_color": spec["line_color"],
                "default": bool(enabled.get("contours")), "opacity": 0.9,
            },
        ])

    vectors_file = "wind-vectors.geojson"
    wind_vectors_geojson(lons, lats, arrays["_u10"], arrays["_v10"], output_dir / vectors_file)
    layers.append({
        "id": "wind_vectors", "field": "wind", "kind": "vectors",
        "label": "10 m wind · vectors", "group": "ICON-EU fields",
        "file": f"{public_prefix}/{vectors_file}", "default": True, "opacity": 0.85,
    })
    sat_west, sat_south, sat_east, sat_north = syn.BBOX
    satellite_bounds = [[sat_south, sat_west], [sat_north, sat_east]]
    layers[0:0] = [
        {
            "id": "satellite_geocolour", "kind": "satellite",
            "label": "MTG/FCI Geo Colour", "group": "Satellite",
            "file": "satellite/geocolour-raw.webp", "bounds": satellite_bounds,
            "default": True, "opacity": 0.65,
        },
        {
            "id": "satellite_ir105", "kind": "satellite",
            "label": "MTG/FCI IR 10.5 µm", "group": "Satellite",
            "file": "satellite/ir105-raw.webp", "bounds": satellite_bounds,
            "default": False, "opacity": 0.65,
        },
    ]

    return {
        "version": 1,
        "run_at": run.isoformat().replace("+00:00", "Z"),
        "forecast_hour": lead,
        "valid_at": (run + timedelta(hours=lead)).isoformat().replace("+00:00", "Z"),
        "bounds": satellite_bounds,
        "native_grid": {
            "shape": [int(len(lats)), int(len(lons))],
            "spacing_degrees": float(abs(np.median(np.diff(lons)))),
        },
        "sampling_modes": ["bilinear", "nearest"],
        "fields": fields,
        "layers": layers,
        "notes": {
            "precip": "TOT_PREC is accumulated precipitation from model initialization to valid time.",
            "fills": "Colour rasters are bilinear-resampled 2x display products; queried values come from the native numerical Float32 grids.",
        },
    }
def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="model/output")
    parser.add_argument("--background", default="satellite/output/geocolour.webp")
    parser.add_argument("--satellite-meta", default="satellite/output/latest.json")
    parser.add_argument("--time-radius", type=int, default=1, help="Forecast steps before/after nearest current valid time")
    args = parser.parse_args()
    if args.time_radius < 0 or args.time_radius > 4:
        raise SystemExit("--time-radius must be between 0 and 4")

    now = datetime.now(timezone.utc)
    run, selections, current_index = discover_time_series(now, radius=args.time_radius)
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)
    background = Path(args.background)
    if not background.exists():
        raise RuntimeError(f"Satellite background missing: {background}")

    satellite_observed_at = None
    satellite_generated_at = None
    satellite_meta_path = Path(args.satellite_meta)
    if satellite_meta_path.exists():
        satellite_meta = json.loads(satellite_meta_path.read_text(encoding="utf-8"))
        satellite_observed_at = (
            satellite_meta.get("products", {}).get("geocolour", {}) or {}
        ).get("observed_at")
        satellite_generated_at = satellite_meta.get("generated_at")

    time_steps = []
    current_raw = None
    current_urls = None
    current_lead = selections[current_index][0]
    with tempfile.TemporaryDirectory(prefix="read-sensor-icon-") as temporary:
        workdir = Path(temporary)
        for index, (lead, urls) in enumerate(selections):
            raw = {name: syn.open_grib(url, workdir) for name, url in urls.items()}
            arrays, lats, lons = prepared_fields(raw)
            step_key = f"f{lead:03d}"
            step_dir = output_dir / "times" / step_key
            step_dir.mkdir(parents=True, exist_ok=True)
            step_meta = interactive_metadata(
                arrays, lats, lons, step_dir, run, lead,
                public_prefix=f"model/times/{step_key}",
            )
            step_meta["satellite_observed_at"] = satellite_observed_at
            step_meta["dimensions"] = {
                "time": {"forecast_hour": lead, "valid_at": step_meta["valid_at"]},
                "horizontal": {"coordinates": ["latitude", "longitude"]},
                "pressure_level_hpa": {"temperature": [850], "geopotential_height": [500]},
            }
            meta_file = step_dir / "meta.json"
            meta_file.write_text(json.dumps(step_meta, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            time_steps.append({
                "forecast_hour": lead,
                "valid_at": step_meta["valid_at"],
                "meta_file": f"model/times/{step_key}/meta.json",
            })
            if index == current_index:
                current_raw = raw
                current_urls = urls
                current_meta = step_meta

        if current_raw is None or current_urls is None:
            raise RuntimeError("Current multidimensional time step was not generated")
        static_meta = syn.render(
            current_raw["t_2m"], current_raw["pmsl"], current_raw["u_10m"], current_raw["v_10m"],
            background, output_dir / "synoptic.webp", run, current_lead,
        )

    timeline = {
        "version": 1,
        "run_at": run.isoformat().replace("+00:00", "Z"),
        "current_index": current_index,
        "steps": time_steps,
        "dimensions": {
            "time": len(time_steps),
            "field": len(DISPLAY_SPECS),
            "latitude": int(current_meta["native_grid"]["shape"][0]),
            "longitude": int(current_meta["native_grid"]["shape"][1]),
        },
        "policy": "previous / latest-valid-not-after-now / next complete valid time from one ICON-EU run",
    }
    (output_dir / "timeline.json").write_text(
        json.dumps(timeline, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    current_meta["timeline_file"] = "model/timeline.json"
    current_meta["timeline"] = timeline
    static_meta["interactive"] = current_meta
    static_meta["generated_at"] = now.replace(microsecond=0).isoformat().replace("+00:00", "Z")
    static_meta["satellite_observed_at"] = satellite_observed_at
    static_meta["satellite_generated_at"] = satellite_generated_at
    static_meta["files"] = current_urls
    (output_dir / "latest.json").write_text(
        json.dumps(static_meta, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({
        "run_at": static_meta["run_at"],
        "forecast_hour": current_lead,
        "valid_at": static_meta["valid_at"],
        "timeline_steps": [step["forecast_hour"] for step in time_steps],
        "interactive_fields": sorted(static_meta["interactive"]["fields"]),
        "interactive_layers": len(static_meta["interactive"]["layers"]),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
