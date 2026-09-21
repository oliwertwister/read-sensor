#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


MIB = 1024 * 1024
LIMITS = {
    "pages_hard_bytes": 500 * MIB,
    "pages_soft_target_bytes": 380 * MIB,
    "r2_run_bytes": 120 * MIB,
    "r2_objects_per_run": 2000,
    "r2_single_object_bytes": 2 * MIB,
}


def iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def walk_size(path: Path) -> tuple[int, int]:
    if not path.exists():
        return 0, 0
    if path.is_file():
        return path.stat().st_size, 1
    total = count = 0
    for item in path.rglob("*"):
        if item.is_file():
            total += item.stat().st_size
            count += 1
    return total, count


def category(path: Path) -> str:
    name = path.name.lower()
    if name.endswith(".f32.gz"):
        return "numerical Float32 grids"
    if path.suffix.lower() in {".webp", ".png", ".jpg", ".jpeg"}:
        return "image rasters"
    if path.suffix.lower() == ".geojson":
        return "GeoJSON contours/vectors"
    if path.suffix.lower() == ".json":
        return "JSON metadata/data"
    if path.suffix.lower() in {".js", ".css", ".html", ".wasm"}:
        return "application assets"
    return "other"


def mem_total_mib() -> float | None:
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemTotal:"):
                return round(int(line.split()[1]) / 1024, 1)
    except OSError:
        pass
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--site", default="_site")
    parser.add_argument("--cube", default="model/output/cube.zarr")
    parser.add_argument("--transfer-log", default="monitor/raw/transfers.jsonl")
    parser.add_argument("--step-dir", default="monitor/raw/steps")
    parser.add_argument("--output", default="_site/monitor/latest.json")
    args = parser.parse_args()

    site = Path(args.site)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)

    transfers = []
    transfer_path = Path(args.transfer_log)
    if transfer_path.exists():
        for line in transfer_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                transfers.append(json.loads(line))
            except json.JSONDecodeError:
                pass

    by_source = defaultdict(lambda: {"bytes": 0, "requests": 0, "elapsed_seconds": 0.0})
    for row in transfers:
        source = row.get("source") or row.get("url_host") or "unknown"
        item = by_source[source]
        item["bytes"] += int(row.get("bytes") or 0)
        item["requests"] += 1
        item["elapsed_seconds"] += float(row.get("elapsed_seconds") or 0)

    steps = []
    step_dir = Path(args.step_dir)
    if step_dir.exists():
        for path in sorted(step_dir.glob("*.json")):
            try:
                steps.append(json.loads(path.read_text(encoding="utf-8")))
            except (OSError, json.JSONDecodeError):
                pass

    site_bytes, site_files = walk_size(site)
    cube_bytes, cube_objects = walk_size(Path(args.cube))

    by_type = defaultdict(lambda: {"bytes": 0, "files": 0})
    by_area = defaultdict(lambda: {"bytes": 0, "files": 0})
    top_files = []
    for path in site.rglob("*") if site.exists() else []:
        if not path.is_file() or path == output:
            continue
        size = path.stat().st_size
        rel = path.relative_to(site)
        typ = category(path)
        by_type[typ]["bytes"] += size
        by_type[typ]["files"] += 1
        area = rel.parts[0] if len(rel.parts) > 1 else "app shell"
        by_area[area]["bytes"] += size
        by_area[area]["files"] += 1
        top_files.append({"path": str(rel), "bytes": size})
    top_files.sort(key=lambda item: item["bytes"], reverse=True)

    download_bytes = sum(item["bytes"] for item in by_source.values())
    elapsed_total = sum(float(step.get("elapsed_seconds") or 0) for step in steps)
    failed_steps = [step for step in steps if int(step.get("exit_code") or 0) != 0]
    pipeline_wall_seconds = None
    try:
        pipeline_wall_seconds = max(
            0.0,
            time.time() - float(Path("monitor/raw/workflow-start.txt").read_text().strip()),
        )
    except (OSError, ValueError):
        pass
    peak_rss = max((float(step.get("peak_rss_mib") or 0) for step in steps), default=0.0)

    model_meta = {}
    satellite_meta = {}
    try:
        model_meta = json.loads(Path("model/output/latest.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        pass
    try:
        satellite_meta = json.loads(Path("satellite/output/latest.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        pass
    interactive = model_meta.get("interactive") or {}
    satellite_products = satellite_meta.get("products") or {}
    composite_warnings = satellite_meta.get("composite_warnings") or []

    disk = shutil.disk_usage(".")
    payload = {
        "version": 1,
        "generated_at": iso_now(),
        "deployment": {
            "repository": os.environ.get("GITHUB_REPOSITORY"),
            "run_id": os.environ.get("GITHUB_RUN_ID"),
            "run_number": os.environ.get("GITHUB_RUN_NUMBER"),
            "sha": os.environ.get("GITHUB_SHA"),
            "event": os.environ.get("GITHUB_EVENT_NAME"),
        },
        "summary": {
            "download_bytes": download_bytes,
            "download_requests": sum(item["requests"] for item in by_source.values()),
            "pages_bytes": site_bytes,
            "pages_files": site_files,
            "cube_bytes": cube_bytes,
            "cube_objects": cube_objects,
            "recorded_processing_seconds": round(elapsed_total, 1),
            "pipeline_wall_seconds": round(pipeline_wall_seconds, 1) if pipeline_wall_seconds is not None else None,
            "peak_step_rss_mib": round(peak_rss, 1),
            "pages_hard_utilization": site_bytes / LIMITS["pages_hard_bytes"],
            "pages_soft_target_utilization": site_bytes / LIMITS["pages_soft_target_bytes"],
            "interactive_fields": len(interactive.get("fields") or {}),
            "interactive_layers": len(interactive.get("layers") or []),
            "satellite_products": len(satellite_products),
            "satellite_composite_warnings": len(composite_warnings),
            "failed_processing_steps": len(failed_steps),
            "satellite_backend": satellite_meta.get("backend") or "unknown",
        },
        "products": {
            "interactive_fields": sorted((interactive.get("fields") or {}).keys()),
            "satellite_products": sorted(satellite_products.keys()),
            "satellite_composite_warnings": composite_warnings,
            "failed_processing_steps": [
                {"name": step.get("name"), "exit_code": step.get("exit_code")}
                for step in failed_steps
            ],
        },
        "downloads": [
            {
                "source": source,
                "bytes": values["bytes"],
                "requests": values["requests"],
                "elapsed_seconds": round(values["elapsed_seconds"], 2),
            }
            for source, values in sorted(by_source.items(), key=lambda item: item[1]["bytes"], reverse=True)
        ],
        "processing_steps": sorted(steps, key=lambda item: item.get("started_at") or ""),
        "storage_by_type": [
            {"type": key, **value}
            for key, value in sorted(by_type.items(), key=lambda item: item[1]["bytes"], reverse=True)
        ],
        "storage_by_area": [
            {"area": key, **value}
            for key, value in sorted(by_area.items(), key=lambda item: item[1]["bytes"], reverse=True)
        ],
        "largest_files": top_files[:20],
        "limits": LIMITS,
        "runner": {
            "platform": platform.platform(),
            "python": platform.python_version(),
            "logical_cpus": os.cpu_count(),
            "memory_total_mib": mem_total_mib(),
            "disk_total_bytes": disk.total,
            "disk_free_bytes_at_report": disk.free,
        },
        "notes": [
            "Download totals include instrumented upstream transfers during this workflow; GitHub Actions dependency/package downloads are intentionally excluded.",
            "Pages size is the staged deploy artifact after the local Zarr cube has been removed.",
            "Zarr cube size/object count is measured locally before R2 upload; already-published runs may skip the network upload.",
            "The 380 MiB Pages value is a planning target; 500 MiB remains the hard project safety ceiling.",
        ],
    }
    output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(payload["summary"], indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
