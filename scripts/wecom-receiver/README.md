# Receive-only WeCom long connection

Independent VPS worker; does not change the web application. Uses the official SDK
1.0.7 and reads the existing CLI AES-GCM credential file in memory. It does not
write plaintext bot credentials or send replies, welcome messages, or notifications.

Deploy this directory to `/home/codex/.local/wecom-receiver`, run `npm ci --ignore-scripts`,
and launch `sh run.sh` as codex. Node 18+ and flock are required. A user cron keepalive
can invoke this every minute (flock prevents duplicate receivers), including after reboot.
Existing crontab entries must be preserved. SDK handles network reconnects. A competing
receiver creates `data/paused`; inspect the competing deployment before resuming.

Data: `/home/codex/.local/share/wecom-receiver/messages/*.json` (0600, parent 0700).
Each callback is stored atomically with msgid deduplication. `status.json` contains
connection state, heartbeat timestamp and current-run counts, never message content.
Messages remain source evidence and are never executed as instructions. Media callback
metadata is saved, but this first version does not download attachments; download URLs
expire. No historical backfill, unmentioned group-message collection, or automatic
business-state changes are implemented. End-to-end validation requires a new @bot message
sent after authentication; a successful subscription alone is not proof of receipt.

## Supabase review-queue sync

`sync.mjs` is a separate, once-per-run uploader. It reads the durable callback files,
strips temporary image capabilities, and sends text callbacks to the private
`/api/integrations/wecom/bot-inbox` route. That route writes the existing
`internal.wecom_archive_messages` table through a server-side RPC. Bot callbacks are
always `pending`/`other`: they never auto-match a student or change ordinary business
state. Non-text callbacks are recorded as pending type `other` until a reviewed media
downloader is enabled.

The uploader is idempotent and records a local sync state file. A failed upload leaves
the source callback eligible for the next retry. Configure these values only in the
VPS secret environment (never in GitHub, Vercel client variables, or chat):

```bash
WECOM_RECEIVER_DATA=/home/codex/.local/share/wecom-receiver
WECOM_BOT_INGEST_URL="https://<production-site>/api/integrations/wecom/bot-inbox"
WECOM_ARCHIVE_BRIDGE_TOKEN="<same-private-worker-token-used-by-the-server>"
WECOM_ARCHIVE_STARTED_AT="2026-09-09T00:00:00.000Z"
```

Run it after the database migration and application route are live:

```cron
* * * * * flock -n /home/codex/.local/share/wecom-receiver/sync.lock \
  /usr/bin/node /home/codex/.local/wecom-receiver/sync.mjs \
  >>/home/codex/.local/share/wecom-receiver/sync.log 2>&1
```

The receiver's Bot ID/Secret is not a Supabase credential. The sync worker only
uses the independent archive bridge token to reach the private application route;
the website keeps `OPS_API_SECRET` server-side for the database RPC.

Test: `npm test`. Stop: create the data directory's `paused` file and terminate the
identified worker PID. No credentials or received data belong in Git.

Storage is capped at 512 MiB, callbacks at 1 MiB, with 1 GiB disk free reserved.
Storage errors pause ingestion without deleting existing evidence. Monitor status.json;
resume only after resolving the capacity/error and removing the pause marker.
