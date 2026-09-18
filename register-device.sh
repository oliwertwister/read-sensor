#!/bin/zsh
set -eu

ROOT="${0:A:h}"
DEVICE="${1:-}"
API="${2:-}"
CONFIG_PATH="${3:-}"

if [[ ! "$DEVICE" =~ '^[A-Za-z0-9_.:-]{1,64}$' ]]; then
  echo "Usage: $0 DEVICE_ID HTTPS_API_BASE [CONFIG_PATH]" >&2
  exit 2
fi
if [[ "$API" != https://* || "$API" == *[' ']* ]]; then
  echo "API base must be an HTTPS URL without spaces." >&2
  exit 2
fi
if [[ -n "$CONFIG_PATH" && -e "$CONFIG_PATH" ]]; then
  echo "Refusing to overwrite existing config: $CONFIG_PATH" >&2
  exit 2
fi

TOKEN="$(openssl rand -hex 32)"
TOKEN_HASH="$(printf %s "$TOKEN" | openssl dgst -sha256 -r | awk '{print $1}')"
TEMP_CONFIG=""

cleanup() {
  if [[ -n "$TEMP_CONFIG" && -f "$TEMP_CONFIG" ]]; then
    rm -f "$TEMP_CONFIG"
  fi
}
trap cleanup EXIT

if [[ -n "$CONFIG_PATH" ]]; then
  CONFIG_DIR="${CONFIG_PATH:h}"
  mkdir -p "$CONFIG_DIR"
  chmod 700 "$CONFIG_DIR"
  TEMP_CONFIG="$(mktemp "$CONFIG_DIR/.collector.env.XXXXXX")"
  chmod 600 "$TEMP_CONFIG"
  printf 'READ_SENSOR_API=%s\nREAD_SENSOR_DEVICE=%s\nREAD_SENSOR_TOKEN=%s\n' \
    "${API%/}" "$DEVICE" "$TOKEN" > "$TEMP_CONFIG"
fi

SQL="INSERT INTO devices(device_id, label, token_hash) VALUES('$DEVICE', '$DEVICE', '$TOKEN_HASH')"
(
  cd "$ROOT/worker"
  npx --no-install wrangler d1 execute read-sensor --remote --command "$SQL"
)

if [[ -n "$CONFIG_PATH" ]]; then
  mv "$TEMP_CONFIG" "$CONFIG_PATH"
  TEMP_CONFIG=""
  chmod 600 "$CONFIG_PATH"
  echo "Registered $DEVICE and wrote mode-600 config to $CONFIG_PATH."
else
  echo "Registered $DEVICE. Store this token now; it will not be shown again:"
  echo "$TOKEN"
fi
