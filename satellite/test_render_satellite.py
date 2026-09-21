#!/usr/bin/env python3
"""Regression tests for resilient satellite refresh fallback."""
from __future__ import annotations

import hashlib
import json
import sys
import tempfile
from pathlib import Path

from PIL import Image

import render_satellite as sat


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="read-sensor-satellite-test-") as tmp:
        output = Path(tmp)
        previous = {
            "generated_at": "2026-09-21T10:00:00Z",
            "source": "EUMETSAT EUMETView WMS",
            "platform": "MTG-I",
            "instrument": "FCI",
            "bbox": sat.BBOX,
            "nominal_cadence_minutes": 10,
            "products": {},
        }
        for index, (key, cfg) in enumerate(sat.PRODUCTS.items()):
            raw = f"{key}-raw.webp"
            decorated = f"{key}.webp"
            Image.new("RGB", (24, 16), (40 + index * 30, 80, 120)).save(output / raw, "WEBP")
            Image.new("RGB", (24, 16), (80 + index * 30, 100, 140)).save(output / decorated, "WEBP")
            previous["products"][key] = {
                "file": decorated,
                "raw_file": raw,
                "layer": cfg["layer"],
                "title": cfg["title"],
                "subtitle": cfg["subtitle"],
                "observed_at": "2026-09-21T09:50:00Z",
            }
        (output / "latest.json").write_text(json.dumps(previous), encoding="utf-8")
        tracked = ["geocolour.webp", "geocolour-raw.webp", "ir105.webp", "ir105-raw.webp"]
        before = {name: digest(output / name) for name in tracked}

        old_latest_times = sat.latest_times
        old_fetch_bytes = sat.fetch_bytes
        old_wms_image = sat.wms_image
        old_argv = sys.argv[:]
        try:
            sat.latest_times = lambda: {key: previous["products"][key]["observed_at"] for key in sat.PRODUCTS}
            sat.fetch_bytes = lambda url, **kwargs: json.dumps({
                "type": "FeatureCollection",
                "features": [{
                    "geometry": {"type": "Polygon", "coordinates": [[[0, 40], [1, 40], [1, 41], [0, 40]]]},
                }],
            }).encode() if url == sat.COUNTRIES_URL else (_ for _ in ()).throw(RuntimeError("simulated upstream failure"))
            sat.wms_image = lambda layer, observed_at: (_ for _ in ()).throw(RuntimeError("simulated malformed WMS image"))
            sys.argv = ["render_satellite.py", "--output", str(output)]
            sat.main()
        finally:
            sat.latest_times = old_latest_times
            sat.fetch_bytes = old_fetch_bytes
            sat.wms_image = old_wms_image
            sys.argv = old_argv

        after = {name: digest(output / name) for name in tracked}
        metadata = json.loads((output / "latest.json").read_text(encoding="utf-8"))
        assert before == after, "Fallback must preserve last known-good image bytes"
        assert metadata["degraded"] is True
        assert all(product.get("stale") is True for product in metadata["products"].values())
        assert len(metadata["warnings"]) == len(sat.PRODUCTS)
        print("satellite fallback regression test: OK")


if __name__ == "__main__":
    main()
