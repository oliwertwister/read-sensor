#!/usr/bin/env python3
"""Read one CPU temperature sample and send it outbound over HTTPS."""

import argparse
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

NAME_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")
TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{32,256}$")
CONFIG_KEYS = {
    "READ_SENSOR_API",
    "READ_SENSOR_DEVICE",
    "READ_SENSOR_TOKEN",
    "READ_SENSOR_STATE_DIR",
}


class ConfigurationError(ValueError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never forward the bearer credential to a redirect target."""

    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        return None


def parse_config(path):
    config_path = Path(path).expanduser()
    try:
        mode = stat.S_IMODE(config_path.stat().st_mode)
    except FileNotFoundError as error:
        raise ConfigurationError(f"missing config: {config_path}") from error
    if mode & 0o077:
        raise ConfigurationError(f"config must be mode 600: {config_path}")

    values = {}
    for line_number, raw_line in enumerate(config_path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise ConfigurationError(f"invalid config line {line_number}")
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if key not in CONFIG_KEYS or not value:
            raise ConfigurationError(f"invalid config key/value on line {line_number}")
        values[key] = value
    return values


def validated_settings(config):
    api = os.getenv("READ_SENSOR_API", config.get("READ_SENSOR_API", "")).rstrip("/")
    device = os.getenv("READ_SENSOR_DEVICE", config.get("READ_SENSOR_DEVICE", ""))
    token = os.getenv("READ_SENSOR_TOKEN", config.get("READ_SENSOR_TOKEN", ""))
    state_dir = os.getenv(
        "READ_SENSOR_STATE_DIR",
        config.get("READ_SENSOR_STATE_DIR", str(Path.home() / ".local/state/read-sensor")),
    )

    parsed = urllib.parse.urlsplit(api)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ConfigurationError("READ_SENSOR_API must be an HTTPS origin or base path")
    if not NAME_RE.fullmatch(device):
        raise ConfigurationError("READ_SENSOR_DEVICE is invalid")
    if not TOKEN_RE.fullmatch(token):
        raise ConfigurationError("READ_SENSOR_TOKEN must be a 32-256 character token")
    return api, device, token, Path(state_dir).expanduser()


def cpu_temperature():
    candidates = [shutil.which("osx-cpu-temp"), "/usr/local/bin/osx-cpu-temp"]
    executable = next((candidate for candidate in candidates if candidate and Path(candidate).is_file()), None)
    if not executable:
        raise RuntimeError("osx-cpu-temp is not installed")

    output = subprocess.check_output(
        [executable], stderr=subprocess.STDOUT, text=True, timeout=10
    ).strip()
    match = re.search(r"(-?\d+(?:\.\d+)?)", output)
    if not match:
        raise RuntimeError("temperature command returned no numeric value")
    value = float(match.group(1))
    if not -20 <= value <= 125:
        raise RuntimeError("temperature command returned an implausible value")
    return value


def publish(api, token, record):
    endpoint = f"{api}/api/v1/ingest"
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(record, separators=(",", ":")).encode("utf-8"),
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "read-sensor-node/1.0",
        },
        method="POST",
    )
    opener = urllib.request.build_opener(NoRedirect())
    with opener.open(request, timeout=15) as response:
        if response.status not in (200, 201):
            raise RuntimeError(f"ingest returned HTTP {response.status}")
        return response.status


def write_state(state_dir, state):
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(state_dir, 0o700)
    destination = state_dir / "sensor-latest.json"
    temporary = state_dir / ".sensor-latest.json.tmp"
    temporary.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(destination)


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config",
        default=str(Path.home() / ".config/read-sensor/collector.env"),
        help="mode-600 collector configuration file",
    )
    parser.add_argument(
        "--sensor-only",
        action="store_true",
        help="read and print the sensor without loading credentials or using the network",
    )
    args = parser.parse_args()

    if args.sensor_only:
        try:
            print(json.dumps({"cpu_c": cpu_temperature()}))
            return 0
        except Exception as error:
            print(json.dumps({"error": str(error)}), file=sys.stderr)
            return 2

    try:
        api, device, token, state_dir = validated_settings(parse_config(args.config))
    except ConfigurationError as error:
        print(json.dumps({"published": False, "error": str(error)}), file=sys.stderr)
        return 2

    recorded_at = utc_now()
    try:
        temperature = cpu_temperature()
    except Exception as error:
        state = {
            "device_id": device,
            "metric": "cpu_temperature",
            "recorded_at": recorded_at,
            "published": False,
            "error": str(error),
        }
        write_state(state_dir, state)
        print(json.dumps(state), file=sys.stderr)
        return 2

    record = {
        "device_id": device,
        "metric": "cpu_temperature",
        "value": temperature,
        "unit": "C",
        "recorded_at": recorded_at,
    }
    try:
        status = publish(api, token, record)
        state = {**record, "published": True, "http_status": status}
        write_state(state_dir, state)
        print(json.dumps(state))
        return 0
    except urllib.error.HTTPError as error:
        message = f"ingest returned HTTP {error.code}"
    except Exception as error:
        message = str(error)

    state = {**record, "published": False, "error": message}
    write_state(state_dir, state)
    print(json.dumps(state), file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
