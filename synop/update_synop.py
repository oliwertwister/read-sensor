#!/usr/bin/env python3
"""Refresh the worldwide operational WMO SYNOP station catalog from OSCAR/Surface."""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

OSCAR_SEARCH_URL = "https://oscar.wmo.int/surface/rest/api/search/station"
USER_AGENT = "read-sensor/1.3 SYNOP dashboard"
WMO_WIGOS_RE = re.compile(r"^0-20000-0-(\d{5})$")


def iso_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def fetch_json(url: str, timeout: int = 90) -> dict:
    request = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(request, timeout=timeout) as response:
        return json.load(response)


def wmo_index(station: dict) -> str | None:
    identifiers = station.get("wigosStationIdentifiers") or []
    for require_primary in (True, False):
        for item in identifiers:
            if require_primary and not item.get("primary"):
                continue
            match = WMO_WIGOS_RE.fullmatch(str(item.get("wigosStationIdentifier") or ""))
            if match:
                return match.group(1)
    return None


def parse_oscar_stations(payload: dict) -> list[dict]:
    by_wmo: dict[str, dict] = {}
    for item in payload.get("stationSearchResults") or []:
        if str(item.get("declaredStatus") or "").casefold() != "operational":
            continue
        wmo = wmo_index(item)
        if not wmo:
            continue
        lat = item.get("latitude")
        lon = item.get("longitude")
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            continue
        name = str(item.get("name") or wmo).strip() or wmo
        station = {
            "wmo": wmo,
            "name": name,
            "territory": item.get("territory") or None,
            "region": item.get("region") or None,
            "lat": round(float(lat), 6),
            "lon": round(float(lon), 6),
            "elev_m": item.get("elevation") if isinstance(item.get("elevation"), (int, float)) else None,
        }
        existing = by_wmo.get(wmo)
        if existing is None or len(station["name"]) > len(existing["name"]):
            by_wmo[wmo] = station
    return sorted(by_wmo.values(), key=lambda station: (station["territory"] or "", station["name"].casefold(), station["wmo"]))


def fetch_world_catalog() -> list[dict]:
    query = urlencode({
        "facilityType": "landFixed,seaFixed",
        "items": "50000",
        "page": "1",
    })
    payload = fetch_json(f"{OSCAR_SEARCH_URL}?{query}")
    if int(payload.get("pageCount") or 1) != 1:
        raise RuntimeError("OSCAR station result unexpectedly requires pagination")
    return parse_oscar_stations(payload)


def build_payload(now: datetime, stations: list[dict]) -> dict:
    territories = sorted({station["territory"] for station in stations if station.get("territory")})
    return {
        "generated_at": iso_utc(now),
        "source": "WMO OSCAR/Surface",
        "source_url": OSCAR_SEARCH_URL,
        "station_count": len(stations),
        "territory_count": len(territories),
        "stations": stations,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="synop/stations.json")
    args = parser.parse_args()
    stations = fetch_world_catalog()
    if len(stations) < 5000:
        raise RuntimeError(f"OSCAR catalog unexpectedly small: {len(stations)} stations")
    payload = build_payload(datetime.now(timezone.utc), stations)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
