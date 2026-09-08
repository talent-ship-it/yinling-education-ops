#!/bin/sh
set -eu
umask 077
APP=/home/codex/.local/wecom-receiver
DATA=/home/codex/.local/share/wecom-receiver
CONFIG=${WECOM_RECEIVER_CONFIG_FILE:-/home/codex/.config/wecom-receiver-sync.env}
mkdir -p "$DATA"
[ ! -f "$DATA/paused" ] || exit 0
if [ -f "$CONFIG" ]; then
  set -a
  . "$CONFIG"
  set +a
fi
export WECOM_RECEIVER_DATA="$DATA"
cd "$APP"
exec /usr/bin/flock -n "$DATA/sync.lock" /usr/bin/node sync.mjs
