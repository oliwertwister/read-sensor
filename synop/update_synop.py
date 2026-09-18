#!/usr/bin/env python3
"""Build the searchable German SYNOP station catalog from DWD Open Data."""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

STATION_LIST_URL = "https://opendata.dwd.de/weather/weather_reports/stationlist_synoptic_germany.csv"
USER_AGENT = "read-sensor/1.2 SYNOP dashboard"


def iso_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def fetch_bytes(url: str, timeout: int = 30) -> bytes:
    request = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(request, timeout=timeout) as response:
        return response.read()


def parse_station_list(text: str) -> list[dict]:
    stations = []
    reader = csv.DictReader(io.StringIO(text), delimiter=";")
    for row in reader:
        wmo = (row.get("Kennung") or "").strip()
        name = (row.get("Stationsname") or "").strip()
        try:
            lat = float((row.get("Geog_Breite") or "").strip())
            lon = float((row.get("Geog_Laenge") or "").strip())
            elev = float((row.get("Stationshoehe") or "").strip())
        except ValueError:
            continue
        if not re.fullmatch(r"\d{5}", wmo) or not name:
            continue
        stations.append({
            "wmo": wmo,
            "name": name,
            "lat": lat,
            "lon": lon,
            "elev_m": elev,
        })
    stations.sort(key=lambda station: (station["name"].casefold(), station["wmo"]))
    return stations


def build_payload(now: datetime) -> dict:
    raw = fetch_bytes(STATION_LIST_URL)
    stations = parse_station_list(raw.decode("cp1252", errors="replace"))
    return {
        "generated_at": iso_utc(now),
        "source": "DWD Open Data",
        "station_list_url": STATION_LIST_URL,
        "station_count": len(stations),
        "stations": stations,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="synop/output/latest.json")
    args = parser.parse_args()
    payload = build_payload(datetime.now(timezone.utc))
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
