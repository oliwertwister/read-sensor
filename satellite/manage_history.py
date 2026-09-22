#!/usr/bin/env python3
"""Hydrate and retain a small immutable history of complete satellite snapshots."""

from __future__ import annotations

import argparse
import json
import shutil
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from monitor.telemetry import record_transfer

DEFAULT_MAX_SNAPSHOTS = 4
INDEX_RELATIVE = Path("history/index.json")


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def safe_snapshot_id(value: str) -> str:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    return parsed.strftime("%Y%m%dT%H%M%SZ")


def observation_time(meta: dict) -> str:
    products = meta.get("products") or {}
    for key in ("ir105", "geocolour"):
        value = (products.get(key) or {}).get("observed_at")
        if value:
            return value
    value = meta.get("generated_at")
    if not value:
        raise RuntimeError("Satellite metadata has no observation/generated timestamp")
    return value


def root_snapshot_files(output: Path) -> list[Path]:
    return sorted(
        path for path in output.iterdir()
        if path.is_file() and not path.name.endswith((".tmp", ".download"))
    )


def snapshot_record(snapshot_id: str, meta: dict, directory: Path) -> dict:
    files = []
    total = 0
    for path in sorted(directory.iterdir()):
        if not path.is_file():
            continue
        size = path.stat().st_size
        total += size
        files.append({"name": path.name, "bytes": size})
    return {
        "id": snapshot_id,
        "observed_at": observation_time(meta),
        "generated_at": meta.get("generated_at"),
        "backend": meta.get("backend") or "eumetview-wms",
        "metadata": f"history/{snapshot_id}/latest.json",
        "bytes": total,
        "file_count": len(files),
        "files": files,
    }


def load_index(output: Path) -> dict:
    path = output / INDEX_RELATIVE
    if not path.exists():
        return {"version": 1, "snapshots": []}
    try:
        data = read_json(path)
    except Exception:
        return {"version": 1, "snapshots": []}
    if not isinstance(data.get("snapshots"), list):
        data["snapshots"] = []
    return data


def write_index(output: Path, snapshots: list[dict], max_snapshots: int) -> None:
    history = output / "history"
    history.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": 1,
        "max_snapshots": max_snapshots,
        "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "snapshots": snapshots,
    }
    temp = history / "index.json.tmp"
    temp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temp.replace(history / "index.json")


def archive(output: Path, max_snapshots: int) -> dict:
    meta_path = output / "latest.json"
    if not meta_path.exists():
        raise RuntimeError(f"Missing satellite metadata: {meta_path}")
    meta = read_json(meta_path)
    observed_at = observation_time(meta)
    snapshot_id = safe_snapshot_id(observed_at)
    history = output / "history"
    snapshot_dir = history / snapshot_id
    if snapshot_dir.exists():
        shutil.rmtree(snapshot_dir)
    snapshot_dir.mkdir(parents=True, exist_ok=True)
    for source in root_snapshot_files(output):
        shutil.copy2(source, snapshot_dir / source.name)

    current = snapshot_record(snapshot_id, meta, snapshot_dir)
    prior = [item for item in load_index(output).get("snapshots", []) if item.get("id") != snapshot_id]
    snapshots = [current, *prior]
    snapshots.sort(key=lambda item: item.get("observed_at") or "", reverse=True)
    keep = snapshots[:max_snapshots]
    keep_ids = {item["id"] for item in keep}
    if history.exists():
        for path in history.iterdir():
            if path.is_dir() and path.name not in keep_ids:
                shutil.rmtree(path)
    write_index(output, keep, max_snapshots)
    return current


def fetch_bytes(url: str, timeout: int = 30) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "read-sensor-satellite-history/1.0"})
    started = time.perf_counter()
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = response.read()
    record_transfer(
        url,
        len(payload),
        time.perf_counter() - started,
        source="read-sensor GitHub Pages",
        category="satellite history hydration",
    )
    return payload


def hydrate(output: Path, base_url: str, max_snapshots: int, exclude_id: str | None = None) -> list[dict]:
    output.mkdir(parents=True, exist_ok=True)
    base = base_url.rstrip("/")
    try:
        remote_index = json.loads(fetch_bytes(f"{base}/history/index.json").decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError) as error:
        print(f"No deployed satellite history to hydrate: {error}")
        return []

    snapshots = []
    for item in remote_index.get("snapshots") or []:
        if len(snapshots) >= max_snapshots:
            break
        snapshot_id = str(item.get("id") or "")
        if exclude_id and snapshot_id == exclude_id:
            continue
        try:
            valid_id = safe_snapshot_id(item.get("observed_at") or "")
        except (TypeError, ValueError):
            valid_id = ""
        if not snapshot_id or valid_id != snapshot_id:
            print(f"Skipping invalid history entry: {snapshot_id!r}")
            continue
        files = item.get("files") or []
        if not files:
            continue
        destination = output / "history" / snapshot_id
        temp = output / "history" / f".{snapshot_id}.download"
        if temp.exists():
            shutil.rmtree(temp)
        temp.mkdir(parents=True, exist_ok=True)
        try:
            for file_meta in files:
                name = str(file_meta.get("name") or "")
                if not name or Path(name).name != name:
                    raise RuntimeError(f"Invalid satellite history file name: {name!r}")
                payload = fetch_bytes(f"{base}/history/{snapshot_id}/{name}")
                expected = int(file_meta.get("bytes") or 0)
                if expected and len(payload) != expected:
                    raise RuntimeError(
                        f"History size mismatch for {snapshot_id}/{name}: {len(payload)} != {expected}"
                    )
                (temp / name).write_bytes(payload)
            if destination.exists():
                shutil.rmtree(destination)
            temp.replace(destination)
            snapshots.append(snapshot_record(snapshot_id, read_json(destination / "latest.json"), destination))
        except Exception as error:
            shutil.rmtree(temp, ignore_errors=True)
            print(f"Skipping incomplete history snapshot {snapshot_id}: {error}")

    snapshots.sort(key=lambda item: item.get("observed_at") or "", reverse=True)
    write_index(output, snapshots[:max_snapshots], max_snapshots)
    print(f"Hydrated {len(snapshots[:max_snapshots])} satellite history snapshots")
    return snapshots[:max_snapshots]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    archive_parser = subparsers.add_parser("archive", help="Archive the current satellite output")
    archive_parser.add_argument("--output", default="satellite/output")
    archive_parser.add_argument("--max-snapshots", type=int, default=DEFAULT_MAX_SNAPSHOTS)

    hydrate_parser = subparsers.add_parser("hydrate", help="Restore previously published history")
    hydrate_parser.add_argument("--output", default="satellite/output")
    hydrate_parser.add_argument("--base-url", required=True)
    hydrate_parser.add_argument("--max-snapshots", type=int, default=DEFAULT_MAX_SNAPSHOTS)
    hydrate_parser.add_argument(
        "--exclude-current",
        action="store_true",
        help="Exclude the observation currently described by OUTPUT/latest.json",
    )

    args = parser.parse_args()
    if not 1 <= args.max_snapshots <= 12:
        raise SystemExit("--max-snapshots must be between 1 and 12")
    output = Path(args.output)
    if args.command == "archive":
        record = archive(output, args.max_snapshots)
        print(json.dumps(record, indent=2, sort_keys=True))
    else:
        exclude_id = None
        if args.exclude_current:
            current_meta = read_json(output / "latest.json")
            exclude_id = safe_snapshot_id(observation_time(current_meta))
        hydrate(output, args.base_url, args.max_snapshots, exclude_id=exclude_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
