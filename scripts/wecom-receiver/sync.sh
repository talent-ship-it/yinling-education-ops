#!/bin/sh
set -eu
umask 077
APP=/home/codex/.local/wecom-receiver
DATA=/home/codex/.local/share/wecom-receiver
mkdir -p "$DATA"
[ ! -f "$DATA/paused" ] || exit 0
export WECOM_RECEIVER_DATA="$DATA"
cd "$APP"
exec /usr/bin/flock -n "$DATA/sync.lock" /usr/bin/node sync.mjs
