from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def record_transfer(
    url: str,
    byte_count: int,
    elapsed_seconds: float | None = None,
    *,
    source: str | None = None,
    category: str = "download",
) -> None:
    path_text = os.environ.get("READ_SENSOR_TRANSFER_LOG", "").strip()
    if not path_text:
        return
    parsed = urlparse(url)
    host = parsed.netloc or source or "unknown"
    record = {
        "timestamp": utc_now(),
        "url_host": host,
        "source": source or host,
        "category": category,
        "bytes": max(0, int(byte_count)),
        "elapsed_seconds": round(float(elapsed_seconds or 0.0), 3),
    }
    path = Path(path_text)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, separators=(",", ":")) + "\n")
