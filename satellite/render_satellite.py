#!/usr/bin/env python3
"""Render autonomous MTG/FCI satellite products for the dashboard."""

from __future__ import annotations

import argparse
import sys
import json
import os
import time
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

from PIL import Image, ImageDraw, ImageFont, UnidentifiedImageError

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from monitor.telemetry import record_transfer

# Natural Earth 1:50m Admin-0 country polygons (public-domain map geometry).
COUNTRIES_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson"


WMS = "https://view.eumetsat.int/geoserver/wms"
BBOX = (-25.0, 30.0, 45.0, 72.0)  # west, south, east, north
SIZE = (1400, 840)
PRODUCTS = {
    "geocolour": {
        "layer": "mtg_fd:rgb_geocolour",
        "title": "Geo Colour RGB",
        "subtitle": "day/night cloud and surface composite",
    },
    "ir105": {
        "layer": "mtg_fd:ir105_hrfi",
        "title": "IR 10.5 µm",
        "subtitle": "thermal infrared cloud-top view",
    },
}


def fetch_bytes(url: str, *, attempts: int = 4, expected_prefix: str | None = None) -> bytes:
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            req = Request(url, headers={
                "User-Agent": "read-sensor-satellite/1.0",
                "Accept": "image/png,image/*;q=0.9,application/xml;q=0.5,*/*;q=0.1",
            })
            started = time.perf_counter()
            with urlopen(req, timeout=90) as response:
                payload = response.read()
                content_type = (response.headers.get("Content-Type") or "").lower()
            record_transfer(url, len(payload), time.perf_counter() - started)
            if expected_prefix and not content_type.startswith(expected_prefix):
                preview = payload[:160].decode("utf-8", errors="replace").replace("\n", " ")
                raise RuntimeError(f"Unexpected Content-Type {content_type!r}: {preview}")
            if not payload:
                raise RuntimeError("Empty upstream response")
            return payload
        except (HTTPError, URLError, TimeoutError, RuntimeError) as error:
            last_error = error
            if attempt < attempts:
                time.sleep(min(2 ** (attempt - 1), 8))
    raise RuntimeError(f"Upstream fetch failed after {attempts} attempts: {last_error}") from last_error


def latest_times() -> dict[str, str]:
    query = urlencode({
        "service": "WMS",
        "version": "1.3.0",
        "request": "GetCapabilities",
    })
    root = ET.fromstring(fetch_bytes(f"{WMS}?{query}"))
    ns = {"wms": "http://www.opengis.net/wms"}
    wanted = {cfg["layer"]: key for key, cfg in PRODUCTS.items()}
    times: dict[str, str] = {}
    for layer in root.findall(".//wms:Layer", ns):
        name = layer.findtext("wms:Name", default="", namespaces=ns)
        if name not in wanted:
            continue
        for dim in layer.findall("wms:Dimension", ns):
            if dim.attrib.get("name") == "time" and dim.attrib.get("default"):
                times[wanted[name]] = dim.attrib["default"]
                break
    return times


def wms_image(layer: str, observed_at: str) -> Image.Image:
    params = {
        "service": "WMS", "version": "1.3.0", "request": "GetMap",
        "layers": layer, "styles": "", "crs": "CRS:84",
        "bbox": ",".join(str(value) for value in BBOX),
        "width": str(SIZE[0]), "height": str(SIZE[1]),
        "format": "image/png", "transparent": "false", "time": observed_at,
    }
    url = f"{WMS}?{urlencode(params)}"
    last_error: Exception | None = None
    for attempt in range(1, 4):
        try:
            payload = fetch_bytes(url, attempts=1, expected_prefix="image/")
            image = Image.open(BytesIO(payload))
            image.load()
            return image.convert("RGB")
        except (UnidentifiedImageError, OSError, RuntimeError) as error:
            last_error = error
            if attempt < 3:
                time.sleep(min(2 ** (attempt - 1), 4))
    raise RuntimeError(f"Invalid WMS image after 3 attempts for {layer} at {observed_at}: {last_error}") from last_error


def font(size: int, bold: bool = False):
    names = ["DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"]
    for name in names:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()


def label(draw: ImageDraw.ImageDraw, xy, text: str, anchor: str = "mm") -> None:
    fnt = font(18, True)
    box = draw.textbbox(xy, text, font=fnt, anchor=anchor)
    pad = 5
    bg = (7, 12, 18, 185)
    draw.rounded_rectangle(
        (box[0] - pad, box[1] - 3, box[2] + pad, box[3] + 3),
        radius=4, fill=bg,
    )
    draw.text(xy, text, font=fnt, fill=(245, 248, 252, 245), anchor=anchor)


def draw_boundaries(draw, x_of, y_of, countries: dict) -> None:
    # Admin-0 country polygons include shared international borders; a generic
    # land polygon would only trace coastlines/landmass outlines.
    for feature in countries.get("features", []):
        geom = feature.get("geometry") or {}
        coords = geom.get("coordinates") or []
        if geom.get("type") == "Polygon":
            polygons = [coords]
        elif geom.get("type") == "MultiPolygon":
            polygons = coords
        else:
            polygons = []
        for polygon in polygons:
            if not polygon:
                continue
            points = []
            for coordinate in polygon[0]:
                if len(coordinate) >= 2:
                    lon, lat = coordinate[:2]
                    points.append((x_of(lon), y_of(lat)))
            if len(points) > 1:
                draw.line(points, fill=(255, 255, 255, 220), width=2, joint="curve")


def decorate(image: Image.Image, countries: dict) -> Image.Image:
    canvas = image.convert("RGBA")
    overlay = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    west, south, east, north = BBOX
    width, height = canvas.size

    def x_of(lon):
        return (lon - west) / (east - west) * width

    def y_of(lat):
        return (north - lat) / (north - south) * height

    # Administrative geometry is projected with the exact same lon/lat-to-pixel
    # transform as the coordinate grid, so the two overlays stay registered.
    draw_boundaries(draw, x_of, y_of, countries)

    for lon in range(-20, 41, 10):
        x = x_of(lon)
        draw.line((x, 0, x, height), fill=(230, 238, 246, 95), width=1)
    for lat in range(30, 71, 5):
        y = y_of(lat)
        draw.line((0, y, width, y), fill=(230, 238, 246, 95), width=1)

    # Berlin raccoon marker uses the same WGS84/CRS:84 extent as the grid.
    berlin_lon, berlin_lat = 13.4050, 52.5200
    bx, by = x_of(berlin_lon), y_of(berlin_lat)
    draw.polygon([(bx - 13, by - 13), (bx - 20, by - 24), (bx - 5, by - 18)], fill=(145, 154, 166, 255))
    draw.polygon([(bx + 13, by - 13), (bx + 20, by - 24), (bx + 5, by - 18)], fill=(145, 154, 166, 255))
    draw.ellipse((bx - 16, by - 20, bx + 16, by + 12), fill=(235, 238, 242, 245), outline=(8, 13, 19, 245), width=2)
    draw.ellipse((bx - 13, by - 11, bx - 2, by - 1), fill=(45, 52, 61, 255))
    draw.ellipse((bx + 2, by - 11, bx + 13, by - 1), fill=(45, 52, 61, 255))
    draw.ellipse((bx - 8, by - 8, bx - 4, by - 4), fill="white")
    draw.ellipse((bx + 4, by - 8, bx + 8, by - 4), fill="white")
    draw.ellipse((bx - 3, by, bx + 3, by + 5), fill=(20, 24, 29, 255))
    label(draw, (bx, by + 27), "Berlin", anchor="ma")
    # Keep the source alpha mask. Native Satpy daytime/no-data areas are
    # transparent and must remain transparent in WebP/Leaflet rather than
    # being flattened to black.
    return Image.alpha_composite(canvas, overlay)


def load_previous_metadata(output: Path) -> dict:
    path = output / "latest.json"
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def fallback_available(output: Path, previous: dict, key: str) -> bool:
    product = (previous.get("products") or {}).get(key) or {}
    return bool(
        product.get("file") and product.get("raw_file")
        and (output / product["file"]).is_file()
        and (output / product["raw_file"]).is_file()
    )


def atomic_save_webp(image: Image.Image, path: Path) -> None:
    tmp = path.with_name(path.name + ".tmp")
    image.save(tmp, "WEBP", quality=88, method=6)
    os.replace(tmp, path)


def product_from_previous(previous: dict, key: str, reason: str) -> dict:
    product = dict((previous.get("products") or {}).get(key) or {})
    product["stale"] = True
    product["fallback_reason"] = reason
    return product


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="satellite/output")
    args = parser.parse_args()
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)

    previous = load_previous_metadata(output)
    warnings: list[str] = []
    try:
        times = latest_times()
    except Exception as error:
        times = {}
        warnings.append(f"GetCapabilities failed: {error}")

    try:
        countries = json.loads(fetch_bytes(COUNTRIES_URL, attempts=3).decode("utf-8"))
        if not countries.get("features"):
            raise RuntimeError("Natural Earth Admin-0 geometry is empty")
    except Exception as error:
        countries = {}
        warnings.append(f"Boundary geometry refresh failed: {error}")

    generated_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    metadata = {
        "generated_at": generated_at,
        "source": "EUMETSAT EUMETView WMS",
        "platform": "MTG-I",
        "instrument": "FCI",
        "bbox": BBOX,
        "nominal_cadence_minutes": 10,
        "boundary_overlay": "Image + grid + Natural Earth 1:50m Admin-0 country geometry fitted to CRS:84 extent",
        "products": {},
        "degraded": False,
        "warnings": warnings,
    }
    for key, cfg in PRODUCTS.items():
        observed_at = times.get(key)
        try:
            if not observed_at:
                raise RuntimeError(f"No current time advertised for {cfg['layer']}")
            if not countries:
                raise RuntimeError("Boundary geometry unavailable")
            raw_image = wms_image(cfg["layer"], observed_at)
            raw_filename = f"{key}-raw.webp"
            atomic_save_webp(raw_image, output / raw_filename)

            image = decorate(raw_image, countries)
            filename = f"{key}.webp"
            atomic_save_webp(image, output / filename)
            metadata["products"][key] = {
                "file": filename,
                "raw_file": raw_filename,
                "layer": cfg["layer"],
                "title": cfg["title"],
                "subtitle": cfg["subtitle"],
                "observed_at": observed_at,
                "stale": False,
            }
        except Exception as error:
            reason = str(error)
            if not fallback_available(output, previous, key):
                raise RuntimeError(f"{key} refresh failed and no previous product is available: {reason}") from error
            metadata["degraded"] = True
            metadata["warnings"].append(f"{key}: {reason}")
            metadata["products"][key] = product_from_previous(previous, key, reason)
            print(f"WARNING: keeping last known-good {key} product: {reason}")

    (output / "latest.json").write_text(
        json.dumps(metadata, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(metadata, indent=2))


if __name__ == "__main__":
    main()
