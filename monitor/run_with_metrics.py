#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import resource
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


def iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def safe_name(value: str) -> str:
    return "".join(ch.lower() if ch.isalnum() else "-" for ch in value).strip("-") or "step"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--name", required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        raise SystemExit("missing command")

    started_at = iso_now()
    start = time.perf_counter()
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    proc = subprocess.run(command)
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    elapsed = time.perf_counter() - start

    max_rss = float(after.ru_maxrss)
    if sys.platform == "darwin":
        max_rss_mib = max_rss / 1024 / 1024
    else:
        max_rss_mib = max_rss / 1024

    payload = {
        "name": args.name,
        "command": command,
        "started_at": started_at,
        "ended_at": iso_now(),
        "elapsed_seconds": round(elapsed, 3),
        "user_cpu_seconds": round(after.ru_utime - before.ru_utime, 3),
        "system_cpu_seconds": round(after.ru_stime - before.ru_stime, 3),
        "peak_rss_mib": round(max_rss_mib, 1),
        "exit_code": proc.returncode,
    }
    out_dir = Path(os.environ.get("MONITOR_STEP_DIR", "monitor/raw/steps"))
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{safe_name(args.name)}.json"
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return proc.returncode


if __name__ == "__main__":
    raise SystemExit(main())
