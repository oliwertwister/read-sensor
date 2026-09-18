#!/usr/bin/env python3
"""Fetch recent raw FM-12 SYNOP reports for the dashboard."""

from __future__ import annotations

import argparse
import csv
import io
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

OGIMET = "https://www.ogimet.com/cgi-bin/getsynop"
FETCH_HOURS = 36
STATIONS = {
    "10385": "Berlin Brandenburg",
    "10384": "Berlin-Tempelhof",
    "10381": "Berlin-Dahlem (FU)",
    "10379": "Potsdam",
}


def iso_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_records(text: str) -> list[dict]:
    """Extract the selected stations from an OGIMET getsynop CSV response."""
    records = []
    for row in csv.reader(io.StringIO(text)):
        if len(row) < 7:
            continue
        wmo = row[0].strip()
        if wmo not in STATIONS:
            continue
        try:
            observed = datetime(
                int(row[1]), int(row[2]), int(row[3]),
                int(row[4]), int(row[5]), tzinfo=timezone.utc,
            )
        except (TypeError, ValueError):
            continue
        raw = ",".join(row[6:]).strip()
        if not raw.startswith("AAXX "):
            continue
        records.append({
            "wmo": wmo,
            "name": STATIONS[wmo],
            "observation_time": iso_utc(observed),
            "raw": raw,
        })
    return records


def fetch_reports(now: datetime) -> list[dict]:
    # One three-digit block request covers all four stations and avoids placing
    # unnecessary load on OGIMET's volunteer-operated service.
    begin = now - timedelta(hours=FETCH_HOURS)
    query = urlencode({
        "block": "103",
        "begin": begin.strftime("%Y%m%d%H%M"),
        "end": now.strftime("%Y%m%d%H%M"),
        "header": "yes",
        "lang": "eng",
    })
    request = Request(
        f"{OGIMET}?{query}",
        headers={"User-Agent": "read-sensor/1.0 SYNOP dashboard"},
    )
    with urlopen(request, timeout=20) as response:
        text = response.read().decode("utf-8", errors="replace")
    return parse_records(text)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="synop/output/latest.json")
    args = parser.parse_args()
    now = datetime.now(timezone.utc)
    latest: dict[str, dict] = {}
    errors = []
    try:
        for record in fetch_reports(now):
            previous = latest.get(record["wmo"])
            if not previous or record["observation_time"] > previous["observation_time"]:
                latest[record["wmo"]] = record
    except Exception as exc:
        errors.append(f"{type(exc).__name__}: {exc}")

    stations = []
    for wmo, name in STATIONS.items():
        stations.append(latest.get(wmo) or {
            "wmo": wmo,
            "name": name,
            "observation_time": None,
            "raw": None,
            "error": "No recent raw SYNOP report returned",
        })

    payload = {
        "generated_at": iso_utc(now),
        "source": "OGIMET getsynop",
        "source_url": "https://www.ogimet.com/getsynop_help.phtml.en",
        "license_url": "https://www.ogimet.com/license.phtml",
        "informational_only": True,
        "errors": errors,
        "stations": stations,
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
