#!/bin/sh
set -eu
umask 077
APP=/home/codex/.local/wecom-receiver
DATA=/home/codex/.local/share/wecom-receiver
mkdir -p "$DATA"
[ ! -f "$DATA/paused" ] || exit 0
export WECOM_RECEIVER_DATA="$DATA"
export WECOM_CLI_CONFIG_DIR=/home/codex/.config/wecom
cd "$APP"
exec /usr/bin/flock -n "$DATA/receiver.lock" /usr/bin/node receiver.mjs
