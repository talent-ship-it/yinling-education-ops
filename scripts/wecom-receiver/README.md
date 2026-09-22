# WeCom long-connection receiver and commit acknowledgement

Independent VPS worker; does not change the web application. Uses the official SDK
1.0.7 and reads the existing CLI AES-GCM credential file in memory. It never
sends business responses, welcome messages, or notifications. The only outbound
traffic is a fixed acknowledgement for a callback that the web application has
already committed to the review queue.

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

## Commit acknowledgement

After a callback is saved, the receiver immediately sends the fixed stream placeholder
`正在收录，请稍候…` so the WeCom reply window is acknowledged. The sync worker creates a
short-lived acknowledgement file only after the private application route reports a
committed Supabase write. The receiver then replaces the same stream with
`已收录到系统审核队列。` and removes the file. If the receiver restarted or the stream
window has expired, it uses the callback's originating group/user as a controlled
active-message fallback. Temporary `response_url` values are never written to disk.
If WeCom rejects the initial stream reply, the receiver immediately sends the same
fixed placeholder to the originating group/user as a controlled active-message
fallback. `status.json` records only bounded provider error codes and delivery counts;
it never stores reply frames, provider messages, chat content, or credentials.

## Supabase review-queue sync

`sync.mjs` is a separate, once-per-run uploader. It reads the durable callback files,
strips temporary image capabilities, and sends callbacks to the private
`/api/integrations/wecom/bot-inbox` route. That route writes the existing
`internal.wecom_archive_messages` table through a server-side RPC. Text callbacks use
the same deterministic classifier as the archive worker, so an explicit “信息交接”
or “信息交接表” is stored as `handover` as soon as it arrives. It still remains pending and never
auto-matches a student or changes ordinary business state. Non-text callbacks are
recorded as pending type `other` until a reviewed media downloader is enabled.

The uploader is idempotent and records a local sync state file. A failed upload leaves
the source callback eligible for the next retry. A successful upload also writes a
0600 acknowledgement marker under `acknowledgements/`; the receiver consumes that
marker and sends the fixed confirmation described above. Configure these values only in the
VPS secret environment (never in GitHub, Vercel client variables, or chat):

```bash
WECOM_RECEIVER_DATA=/home/codex/.local/share/wecom-receiver
WECOM_BOT_INGEST_URL="https://<production-site>/api/integrations/wecom/bot-inbox"
# Optional override; otherwise derived from WECOM_BOT_INGEST_URL.
WECOM_RECEIVER_HEALTH_URL="https://<production-site>/api/integrations/wecom/receiver-health"
WECOM_ARCHIVE_BRIDGE_TOKEN="<same-private-worker-token-used-by-the-server>"
WECOM_ARCHIVE_STARTED_AT="2026-09-09T00:00:00.000Z"
```

For the cron installation, store the same values in
`/home/codex/.config/wecom-receiver-sync.env` with mode `0600`. `sync.sh` loads
that file automatically; an exported environment still works when the file is
absent. The file is local VPS configuration and must not be copied into the
repository.

Run it after the database migration and application route are live:

```cron
* * * * * /home/codex/.local/wecom-receiver/sync.sh \
  >>/home/codex/.local/share/wecom-receiver/sync.log 2>&1
```

The receiver's Bot ID/Secret is not a Supabase credential. The sync worker only
uses the independent archive bridge token to reach the private application route;
the website keeps `OPS_API_SECRET` server-side for the database RPC.
Each sync also publishes a sanitized heartbeat to the private receiver-health
route. The full-admin integration status can therefore show connection freshness,
delivery counters, stream fallback use, and bounded provider error codes without
exposing callbacks, chat identifiers, provider messages, or credentials.

Test: `npm test`. Stop: create the data directory's `paused` file and terminate the
identified worker PID. No credentials or received data belong in Git.

Storage is capped at 512 MiB, callbacks at 1 MiB, with 1 GiB disk free reserved.
Storage errors pause ingestion without deleting existing evidence. Monitor status.json;
resume only after resolving the capacity/error and removing the pause marker.
