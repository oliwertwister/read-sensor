#!/usr/bin/env python3
"""Render a compact ICON-EU synoptic overlay for the read-sensor dashboard.

The renderer discovers the freshest available regular-lat/lon ICON-EU run,
selects the forecast step with valid time closest to the current UTC time,
downloads T_2M, PMSL, U_10M and V_10M GRIB2 fields, and overlays isotherms,
isobars and thinned wind vectors on the current satellite image.
"""

from __future__ import annotations

import argparse
import bz2
import json
import math
import re
import tempfile
import time
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
from urllib.request import Request, urlopen

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import xarray as xr
from PIL import Image

from monitor.telemetry import record_transfer

BASE = "https://opendata.dwd.de/weather/nwp/icon-eu/grib"
CYCLES = ("00", "06", "12", "18")
BBOX = (-25.0, 30.0, 45.0, 72.0)  # west, south, east, north
FIELDS = {
    "t_2m": "T_2M",
    "pmsl": "PMSL",
    "u_10m": "U_10M",
    "v_10m": "V_10M",
}
FILE_RE = re.compile(
    r'href="(icon-eu_europe_regular-lat-lon_single-level_(\d{10})_(\d{3})_([A-Z0-9_]+)\.grib2\.bz2)"'
)
USER_AGENT = "read-sensor-icon/1.0"


def fetch_bytes(url: str, timeout: int = 90) -> bytes:
    request = Request(url, headers={"User-Agent": USER_AGENT})
    started = time.perf_counter()
    with urlopen(request, timeout=timeout) as response:
        payload = response.read()
    record_transfer(url, len(payload), time.perf_counter() - started)
    return payload


def list_field(cycle: str, field: str) -> list[dict]:
    text = fetch_bytes(f"{BASE}/{cycle}/{field}/", timeout=30).decode("utf-8", errors="replace")
    suffix = FIELDS[field]
    rows = []
    for filename, run_text, lead_text, variable in FILE_RE.findall(text):
        if variable != suffix:
            continue
        run = datetime.strptime(run_text, "%Y%m%d%H").replace(tzinfo=timezone.utc)
        lead = int(lead_text)
        rows.append({
            "filename": filename,
            "run": run,
            "lead": lead,
            "valid": run + timedelta(hours=lead),
            "url": f"{BASE}/{cycle}/{field}/{filename}",
        })
    return rows


def discover_selection(now: datetime) -> tuple[datetime, int, dict[str, str]]:
    # T_2M is used as the discovery field; all four required fields must exist
    # for the selected run/lead before it is accepted.
    candidates = []
    listings: dict[tuple[str, str], list[dict]] = {}
    for cycle in CYCLES:
        rows = list_field(cycle, "t_2m")
        listings[(cycle, "t_2m")] = rows
        candidates.extend((cycle, row) for row in rows)
    if not candidates:
        raise RuntimeError("No ICON-EU T_2M products advertised by DWD")

    # Prefer valid times nearest to now; on ties prefer the newer initialization.
    candidates.sort(key=lambda item: (
        abs((item[1]["valid"] - now).total_seconds()),
        -item[1]["run"].timestamp(),
        item[1]["lead"],
    ))

    for cycle, selected in candidates:
        run = selected["run"]
        lead = selected["lead"]
        urls = {"t_2m": selected["url"]}
        complete = True
        for field in ("pmsl", "u_10m", "v_10m"):
            key = (cycle, field)
            if key not in listings:
                listings[key] = list_field(cycle, field)
            match = next((row for row in listings[key] if row["run"] == run and row["lead"] == lead), None)
            if not match:
                complete = False
                break
            urls[field] = match["url"]
        if complete:
            return run, lead, urls
    raise RuntimeError("Could not find a complete ICON-EU T/P/U/V field set")


def open_grib(url: str, workdir: Path) -> xr.DataArray:
    compressed = fetch_bytes(url)
    raw = bz2.decompress(compressed)
    path = workdir / (Path(url).name.removesuffix(".bz2"))
    path.write_bytes(raw)
    ds = xr.open_dataset(path, engine="cfgrib", backend_kwargs={"indexpath": ""})
    try:
        if not ds.data_vars:
            raise RuntimeError(f"No data variable decoded from {url}")
        data = ds[next(iter(ds.data_vars))].load()
    finally:
        ds.close()
    return data


def normalize_grid(data: xr.DataArray) -> xr.DataArray:
    lat_name = "latitude" if "latitude" in data.coords else "lat"
    lon_name = "longitude" if "longitude" in data.coords else "lon"
    lon = ((data[lon_name] + 180) % 360) - 180
    data = data.assign_coords({lon_name: lon}).sortby(lon_name)
    west, south, east, north = BBOX
    lat = data[lat_name]
    lat_slice = slice(south, north) if lat[0] < lat[-1] else slice(north, south)
    return data.sel({lat_name: lat_slice, lon_name: slice(west, east)})


def levels_covering(lo: float, hi: float, step: float) -> np.ndarray:
    start = math.floor(lo / step) * step
    stop = math.ceil(hi / step) * step
    return np.arange(start, stop + step * 0.5, step)


def render(
    t2m: xr.DataArray,
    pmsl: xr.DataArray,
    u10: xr.DataArray,
    v10: xr.DataArray,
    background: Path,
    output: Path,
    run: datetime,
    lead: int,
) -> dict:
    t2m = normalize_grid(t2m) - 273.15
    pmsl = normalize_grid(pmsl) / 100.0
    u10 = normalize_grid(u10)
    v10 = normalize_grid(v10)

    lat_name = "latitude" if "latitude" in t2m.coords else "lat"
    lon_name = "longitude" if "longitude" in t2m.coords else "lon"
    lats = np.asarray(t2m[lat_name].values)
    lons = np.asarray(t2m[lon_name].values)
    tt = np.asarray(t2m.values)
    pp = np.asarray(pmsl.values)
    uu = np.asarray(u10.values)
    vv = np.asarray(v10.values)

    image = Image.open(background).convert("RGB")
    fig, ax = plt.subplots(figsize=(14, 8.4), dpi=100)
    west, south, east, north = BBOX
    ax.imshow(image, extent=[west, east, south, north], origin="upper", aspect="auto", zorder=0)

    pressure_levels = levels_covering(float(np.nanpercentile(pp, 1)), float(np.nanpercentile(pp, 99)), 4.0)
    temp_levels = levels_covering(float(np.nanpercentile(tt, 2)), float(np.nanpercentile(tt, 98)), 4.0)

    pressure = ax.contour(lons, lats, pp, levels=pressure_levels, linewidths=1.3, colors="white", alpha=0.95, zorder=4)
    pressure_labels = ax.clabel(
        pressure, inline=True, inline_spacing=5, fontsize=8, colors="white",
        fmt=lambda value: f"{value:.0f}",
    )
    for text in pressure_labels:
        text.set_bbox({"facecolor": "black", "edgecolor": "none", "alpha": 0.55, "pad": 0.5})

    # A subtle white underlay keeps the black 2 m isotherms readable over both
    # dark ocean and bright cloud tops without changing their black identity.
    ax.contour(
        lons, lats, tt, levels=temp_levels, linewidths=3.0,
        colors="white", alpha=0.45, zorder=4.5,
    )
    temperature = ax.contour(
        lons, lats, tt, levels=temp_levels, linewidths=1.8,
        colors="black", alpha=1.0, zorder=5,
    )
    temperature_labels = ax.clabel(
        temperature, inline=True, inline_spacing=5, fontsize=8, colors="black",
        fmt=lambda value: f"{value:.1f} degrees_celsius",
    )
    for text in temperature_labels:
        text.set_bbox({"facecolor": "white", "edgecolor": "none", "alpha": 0.72, "pad": 0.5})

    # Roughly 2-degree spacing keeps the wind layer legible on a Europe view.
    lon_stride = max(1, round(2.0 / abs(float(np.median(np.diff(lons))))))
    lat_stride = max(1, round(2.0 / abs(float(np.median(np.diff(lats))))))
    ax.quiver(
        lons[::lon_stride], lats[::lat_stride],
        uu[::lat_stride, ::lon_stride], vv[::lat_stride, ::lon_stride],
        color="white", alpha=0.72, scale=420, width=0.0016,
        headwidth=3.0, headlength=4.0, headaxislength=3.5, zorder=5,
    )

    valid = run + timedelta(hours=lead)
    ax.set_xlim(west, east)
    ax.set_ylim(south, north)

    lon_ticks = np.arange(-20, 41, 10)
    lat_ticks = np.arange(30, 71, 5)
    ax.set_xticks(lon_ticks)
    ax.set_yticks(lat_ticks)
    ax.set_xticklabels([
        f"{abs(int(value))}°W" if value < 0 else f"{int(value)}°E" if value > 0 else "0°"
        for value in lon_ticks
    ])
    ax.set_yticklabels([f"{int(value)}°N" for value in lat_ticks])
    ax.tick_params(
        axis="both", which="major", direction="out", pad=7,
        length=4, labelsize=9, top=False, right=False,
        labeltop=False, labelright=False,
    )
    ax.set_xlabel("")
    ax.set_ylabel("")
    ax.grid(False)
    fig.subplots_adjust(left=0.065, right=0.992, bottom=0.085, top=0.992)
    output.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output, format="webp", dpi=100, pil_kwargs={"quality": 90, "method": 6})
    plt.close(fig)

    return {
        "run_at": run.isoformat().replace("+00:00", "Z"),
        "forecast_hour": lead,
        "valid_at": valid.isoformat().replace("+00:00", "Z"),
        "bbox": list(BBOX),
        "grid_spacing_degrees": float(abs(np.median(np.diff(lons)))),
        "pressure_contour_interval_hpa": 4,
        "temperature_contour_interval_degrees_celsius": 4,
        "wind_vector_spacing_degrees_approx": 2,
        "source": "DWD ICON-EU regular-lat-lon GRIB2",
        "background": "EUMETSAT EUMETView MTG/FCI Geo Colour",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="model/output")
    parser.add_argument("--background", default="satellite/output/geocolour.webp")
    parser.add_argument("--satellite-meta", default="satellite/output/latest.json")
    args = parser.parse_args()

    now = datetime.now(timezone.utc)
    run, lead, urls = discover_selection(now)
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)
    background = Path(args.background)
    if not background.exists():
        raise RuntimeError(f"Satellite background missing: {background}")

    with tempfile.TemporaryDirectory(prefix="read-sensor-icon-") as temporary:
        workdir = Path(temporary)
        fields = {name: open_grib(url, workdir) for name, url in urls.items()}

    metadata = render(
        fields["t_2m"], fields["pmsl"], fields["u_10m"], fields["v_10m"],
        background, output_dir / "synoptic.webp", run, lead,
    )
    metadata["generated_at"] = now.replace(microsecond=0).isoformat().replace("+00:00", "Z")
    satellite_meta_path = Path(args.satellite_meta)
    if satellite_meta_path.exists():
        satellite_meta = json.loads(satellite_meta_path.read_text(encoding="utf-8"))
        metadata["satellite_observed_at"] = (satellite_meta.get("products", {}).get("geocolour", {}) or {}).get("observed_at")
        metadata["satellite_generated_at"] = satellite_meta.get("generated_at")
    metadata["files"] = {name: url for name, url in urls.items()}
    (output_dir / "latest.json").write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(metadata, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
