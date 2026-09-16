#!/bin/zsh
set -euo pipefail
DEVICE="${1:-sensor-node-01}"
LABEL="${2:-Sensor node 01}"
TOKEN_FILE="${3:-/tmp/read-sensor-token}"
[[ -f "$TOKEN_FILE" ]] || { echo "Missing token file" >&2; exit 1; }
HASH="$(tr -d '\r\n' < "$TOKEN_FILE" | shasum -a 256 | awk '{print $1}')"
[[ ${#HASH} -eq 64 ]] || { echo "Hash failed" >&2; exit 1; }
SQL="INSERT INTO devices(device_id,label,token_hash,enabled) VALUES('$DEVICE','$LABEL','$HASH',1) ON CONFLICT(device_id) DO UPDATE SET label=excluded.label,token_hash=excluded.token_hash,enabled=1;"
npx wrangler d1 execute read-sensor --remote --command "$SQL"
unset HASH SQL
echo "Provisioned $DEVICE; raw token was not uploaded to D1."
