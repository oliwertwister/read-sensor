#!/usr/bin/env python3
"""Build a recent worldwide SYNOP layer for the interactive map."""

from __future__ import annotations

import argparse
import bz2
import concurrent.futures
import json
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.request import Request, urlopen

from monitor.telemetry import record_transfer

INTL_BASE = "https://opendata.dwd.de/weather/weather_reports/synoptic/international/"
DE_BASE = "https://opendata.dwd.de/weather/weather_reports/synoptic/germany/json/"
USER_AGENT = "read-sensor/1.4 SYNOP live map"
LOOKBACK = timedelta(hours=2, minutes=20)
INTL_FILE_RE = re.compile(r'href="(gda01-synop-(\d{12})\.txt)"')
DE_FILE_RE = re.compile(r'href="([^\"]*_(\d{14})_[^\"]+\.json\.bz2)"')
AAXX_RE = re.compile(r"\bAAXX\s+(\d{5})\b")
SECTION_RE = re.compile(r"\b(?:AAXX|BBXX|OOXX)\b")


def fetch_bytes(url: str, timeout: int = 30) -> bytes:
    request = Request(url, headers={"User-Agent": USER_AGENT})
    started = time.perf_counter()
    with urlopen(request, timeout=timeout) as response:
        payload = response.read()
    record_transfer(url, len(payload), time.perf_counter() - started)
    return payload


def iso_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def observation_time(timecode: str, file_time: datetime) -> datetime:
    day = int(timecode[:2])
    hour = int(timecode[2:4])
    candidates = []
    for month_delta in (-1, 0, 1):
        month_index = file_time.month - 1 + month_delta
        year = file_time.year + month_index // 12
        month = month_index % 12 + 1
        try:
            candidates.append(datetime(year, month, day, hour, tzinfo=timezone.utc))
        except ValueError:
            pass
    return min(candidates, key=lambda candidate: abs((candidate - file_time).total_seconds()))


def decode_temperature(groups: list[str]) -> float | None:
    section = 1
    for group in groups:
        if group in {"222", "333", "444", "555"}:
            section = int(group[0])
            continue
        if section == 1 and re.fullmatch(r"1[01]\d{3}", group):
            sign = -1 if group[1] == "1" else 1
            return sign * int(group[2:]) / 10
    return None


def parse_international(text: str, file_time: datetime, catalog: dict[str, dict]) -> list[dict]:
    clean = text.replace("\r", "\n").replace("\x01", "\n").replace("\x03", "\n")
    reports = []
    headers = list(AAXX_RE.finditer(clean))
    for header in headers:
        timecode = header.group(1)
        next_section = SECTION_RE.search(clean, header.end())
        segment = clean[header.end(): next_section.start() if next_section else len(clean)]
        observed = observation_time(timecode, file_time)
        for part in segment.split("="):
            normalized = " ".join(part.split())
            match = re.match(r"^(\d{5})\s+(.+)$", normalized)
            if not match:
                continue
            wmo = match.group(1)
            station = catalog.get(wmo)
            if not station:
                continue
            groups = match.group(2).split()
            if not groups or groups[0] == "NIL":
                continue
            reports.append({
                **station,
                "observation_time": iso_utc(observed),
                "temperature_c": decode_temperature(groups),
                "raw": f"AAXX {timecode} {normalized}=",
                "source": "DWD international SYNOP",
            })
    return reports


def key_value_pairs(obj):
    if isinstance(obj, dict):
        if "key" in obj and "value" in obj:
            yield obj["key"], obj.get("value")
        for value in obj.values():
            yield from key_value_pairs(value)
    elif isinstance(obj, list):
        for value in obj:
            yield from key_value_pairs(value)


def bufr_subsets(payload: dict) -> list[dict[str, list]]:
    subsets = []
    current = None
    for key, value in key_value_pairs(payload):
        if key == "subsetNumber":
            if current:
                subsets.append(current)
            current = {}
        if current is not None:
            current.setdefault(key, []).append(value)
    if current:
        subsets.append(current)
    return subsets


def first_value(record: dict[str, list], key: str):
    return next((value for value in record.get(key, []) if value is not None), None)


def parse_germany(payload: dict, catalog: dict[str, dict]) -> list[dict]:
    reports = []
    for record in bufr_subsets(payload):
        block = first_value(record, "blockNumber")
        station_number = first_value(record, "stationNumber")
        if not isinstance(block, (int, float)) or not isinstance(station_number, (int, float)):
            continue
        wmo = f"{int(block):02d}{int(station_number):03d}"
        station = catalog.get(wmo)
        if not station:
            continue
        values = {key: first_value(record, key) for key in ("year", "month", "day", "hour", "minute")}
        if not all(isinstance(values[key], (int, float)) for key in values):
            continue
        observed = datetime(
            int(values["year"]), int(values["month"]), int(values["day"]),
            int(values["hour"]), int(values["minute"]), tzinfo=timezone.utc,
        )
        temp_k = first_value(record, "airTemperature")
        temp_c = round(float(temp_k) - 273.15, 1) if isinstance(temp_k, (int, float)) else None
        reports.append({
            **station,
            "observation_time": iso_utc(observed),
            "temperature_c": temp_c,
            "raw": None,
            "source": "DWD Germany SYNOP BUFR",
        })
    return reports


def recent_files(index: str, regex: re.Pattern, stamp_format: str, now: datetime) -> list[tuple[str, datetime]]:
    cutoff = now - LOOKBACK
    upper = now + timedelta(minutes=10)
    rows = []
    for name, stamp in regex.findall(index):
        try:
            timestamp = datetime.strptime(stamp, stamp_format).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if cutoff <= timestamp <= upper:
            rows.append((name, timestamp))
    return rows


def newest_by_station(reports: list[dict]) -> dict[str, dict]:
    newest = {}
    for report in reports:
        previous = newest.get(report["wmo"])
        if not previous or report["observation_time"] > previous["observation_time"]:
            newest[report["wmo"]] = report
        elif previous and report["observation_time"] == previous["observation_time"]:
            if not previous.get("raw") and report.get("raw"):
                newest[report["wmo"]] = report
    return newest


def build_live(catalog_path: Path, now: datetime) -> dict:
    catalog_payload = json.loads(catalog_path.read_text(encoding="utf-8"))
    catalog = {station["wmo"]: station for station in catalog_payload["stations"]}

    intl_index = fetch_bytes(INTL_BASE).decode("utf-8", errors="replace")
    de_index = fetch_bytes(DE_BASE).decode("utf-8", errors="replace")
    intl_files = recent_files(intl_index, INTL_FILE_RE, "%Y%m%d%H%M", now)
    de_files = recent_files(de_index, DE_FILE_RE, "%Y%m%d%H%M%S", now)

    reports = []

    def fetch_intl(entry):
        name, stamp = entry
        text = fetch_bytes(INTL_BASE + name, timeout=25).decode("ascii", errors="replace")
        return parse_international(text, stamp, catalog)

    def fetch_de(entry):
        name, _ = entry
        raw = fetch_bytes(DE_BASE + name, timeout=25)
        return parse_germany(json.loads(bz2.decompress(raw).decode("utf-8", errors="replace")), catalog)

    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        futures = [executor.submit(fetch_intl, entry) for entry in intl_files]
        futures += [executor.submit(fetch_de, entry) for entry in de_files]
        for future in concurrent.futures.as_completed(futures):
            try:
                reports.extend(future.result())
            except Exception as exc:
                print(f"warning: live SYNOP source failed: {type(exc).__name__}: {exc}")

    newest = newest_by_station(reports)
    stations = sorted(newest.values(), key=lambda station: station["wmo"])
    return {
        "generated_at": iso_utc(now),
        "lookback_minutes": int(LOOKBACK.total_seconds() // 60),
        "station_count": len(stations),
        "temperature_count": sum(station.get("temperature_c") is not None for station in stations),
        "stations": stations,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", default="synop/stations.json")
    parser.add_argument("--output", default="synop/output/live.json")
    args = parser.parse_args()
    payload = build_live(Path(args.catalog), datetime.now(timezone.utc))
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
