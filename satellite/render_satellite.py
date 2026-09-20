#!/usr/bin/env python3
"""Render autonomous MTG/FCI satellite products for the dashboard."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

from PIL import Image, ImageDraw, ImageFont

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


def fetch_bytes(url: str) -> bytes:
    req = Request(url, headers={"User-Agent": "read-sensor-satellite/1.0"})
    with urlopen(req, timeout=90) as response:
        return response.read()


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
    return Image.open(BytesIO(fetch_bytes(f"{WMS}?{urlencode(params)}"))).convert("RGB")


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
    return Image.alpha_composite(canvas, overlay).convert("RGB")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="satellite/output")
    args = parser.parse_args()
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)

    times = latest_times()
    countries = json.loads(fetch_bytes(COUNTRIES_URL).decode("utf-8"))
    if not countries.get("features"):
        raise RuntimeError("Natural Earth Admin-0 geometry is empty")
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
    }
    for key, cfg in PRODUCTS.items():
        observed_at = times.get(key)
        if not observed_at:
            raise RuntimeError(f"No current time advertised for {cfg['layer']}")
        image = decorate(wms_image(cfg["layer"], observed_at), countries)
        filename = f"{key}.webp"
        image.save(output / filename, "WEBP", quality=88, method=6)
        metadata["products"][key] = {
            "file": filename,
            "layer": cfg["layer"],
            "title": cfg["title"],
            "subtitle": cfg["subtitle"],
            "observed_at": observed_at,
        }

    (output / "latest.json").write_text(
        json.dumps(metadata, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(metadata, indent=2))


if __name__ == "__main__":
    main()
