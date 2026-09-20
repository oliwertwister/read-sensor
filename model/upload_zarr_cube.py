#!/usr/bin/env python3
"""Upload an immutable Zarr run to the read-sensor Worker R2 gateway."""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import mimetypes
import os
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen


def put(url: str, token: str, path: str, data: bytes, content_type: str) -> tuple[str, int]:
    endpoint = url.rstrip("/") + "/" + "/".join(quote(part, safe="._=-") for part in path.split("/"))
    request = Request(endpoint, data=data, method="PUT", headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": content_type,
        "User-Agent": "read-sensor-zarr-publisher/1.0",
    })
    try:
        with urlopen(request, timeout=120) as response:
            return path, response.status
    except HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"Upload failed for {path}: HTTP {error.code}: {body}") from error


def content_type(path: Path) -> str:
    if path.name.endswith(".json") or path.name == "zarr.json":
        return "application/json"
    return mimetypes.guess_type(path.name)[0] or "application/octet-stream"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cube", default="model/output/cube.zarr")
    parser.add_argument("--manifest", default="model/output/cube-manifest.json")
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()

    base_url = os.environ.get("MODEL_CUBE_UPLOAD_URL", "").strip()
    token = os.environ.get("MODEL_UPLOAD_TOKEN", "").strip()
    if not base_url or not token:
        print("Zarr R2 upload skipped: MODEL_CUBE_UPLOAD_URL / MODEL_UPLOAD_TOKEN not configured")
        return 0

    cube = Path(args.cube)
    manifest_path = Path(args.manifest)
    if not cube.is_dir() or not manifest_path.is_file():
        raise SystemExit("Zarr cube or manifest missing")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    run_key = manifest["run_at"].replace("-", "").replace(":", "").replace("Z", "Z")
    run_key = run_key.replace("T", "T")

    objects: list[tuple[str, Path]] = []
    for path in cube.rglob("*"):
        if path.is_file():
            relative = path.relative_to(cube).as_posix()
            objects.append((f"runs/{run_key}/cube.zarr/{relative}", path))
    objects.append((f"runs/{run_key}/cube-manifest.json", manifest_path))

    total_bytes = sum(path.stat().st_size for _, path in objects)
    print(f"Uploading {len(objects)} immutable objects / {total_bytes / 1024 / 1024:.1f} MiB for {run_key}")
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(args.workers, 16))) as pool:
        futures = [pool.submit(put, base_url, token, key, path.read_bytes(), content_type(path)) for key, path in objects]
        for future in concurrent.futures.as_completed(futures):
            key, status = future.result()
            if status not in (200, 201):
                raise RuntimeError(f"Unexpected upload status {status} for {key}")

    latest = {
        "version": 1,
        "run_at": manifest["run_at"],
        "cube_url": f"runs/{run_key}/cube.zarr",
        "manifest_url": f"runs/{run_key}/cube-manifest.json",
        "shape": manifest["shape"],
        "variables": manifest["variables"],
    }
    payload = (json.dumps(latest, indent=2, sort_keys=True) + "\n").encode()
    put(base_url, token, "latest.json", payload, "application/json")
    print(f"Published latest.json -> {latest['cube_url']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
