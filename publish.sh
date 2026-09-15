#!/bin/zsh
set -eu

ROOT="${0:A:h}"
CONFIG="${READ_SENSOR_CONFIG:-$HOME/.config/read-sensor/collector.env}"

exec /usr/bin/python3 "$ROOT/collector.py" --config "$CONFIG"
