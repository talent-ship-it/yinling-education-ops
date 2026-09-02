# WeCom CLI bridge

This small private service is the first-phase bridge between the operations site and the official [`wecom-cli`](https://github.com/WecomTeam/wecom-cli). It only performs one fixed action: send a confirmed Markdown text message to a preconfigured recipient. It cannot read group history, collect attachments, or run arbitrary CLI commands.

## Before running it

1. On the private bridge host, install the official CLI and complete its one-time authorization:

   ```bash
   npm install -g @wecom/cli
   wecom-cli --version
   wecom-cli auth show --status
   # Only if the status is "unauthorized":
   wecom-cli auth init --noninteractive
   wecom-cli auth show --status
   ```

   This is the CLI's QR-code/Bot authorization flow, not the separate 会话内容存档 API application.
2. Put the bridge behind private networking/TLS. It binds to `127.0.0.1` by default and must never be exposed directly to browsers.
3. Store the CLI's local credentials and the values below in the bridge host's secrets manager or protected environment. Do not commit any values to this repository.

```bash
WECOM_CLI_BRIDGE_TOKEN="at-least-32-random-characters"
WECOM_CLI_HOST="127.0.0.1"
WECOM_CLI_PORT="8787"
WECOM_CLI_DEDUP_FILE="/var/lib/yinling-wecom/deliveries.json"
WECOM_CLI_RECIPIENTS_JSON='{
  "staff-tara": {"chatName": "Tara（内部提醒）", "chatType": "single"}
}'
node services/wecom-cli-bridge/server.mjs
```

On **every** delivery, the bridge runs `wecom-cli message aibot sessions list` and requires exactly one current session to match the configured `chatName` and `chatType`. It uses only that command's fresh in-memory `chat_id` for the immediately following send; it never stores a `chat_id` in configuration or the delivery log. If the recipient is absent or ambiguous, delivery fails closed.

The CLI itself limits delivery to recent bot conversations. Start a current test conversation with the bot before adding its exact name/type to the bridge map; a name, user ID, or old chat ID is not a bypass.

## Website configuration

The Next.js application needs only the bridge URL/token and a non-sensitive public recipient label map. Never put a bot secret, CLI credential, bridge token, or any internal chat identifier in `NEXT_PUBLIC_*` variables.

```bash
WECOM_DISPATCH_PASSWORD="separate-short-lived-approval-password"
WECOM_DISPATCH_SESSION_SECRET="at-least-32-random-characters"
WECOM_CLI_BRIDGE_URL="https://private-bridge.example.internal"
WECOM_CLI_BRIDGE_TOKEN="same-bridge-token-as-above"
WECOM_CLI_PUBLIC_RECIPIENTS_JSON='{
  "staff-tara": {"label": "Tara（内部提醒）"}
}'
```

The website asks for the separate dispatch password before an actual send and issues a 15-minute, HttpOnly approval cookie. It sends only a stored queue item by ID/version; the browser cannot supply CLI commands, recipients, or raw chat IDs.

## Scope and safety boundary

- Messages must be manually confirmed in the website before they are sent.
- The bridge resolves a target from the current official CLI session list immediately before each send; it does not persist or accept a chat ID from configuration, the browser, or an earlier delivery.
- One `deliveryId` is written to a durable file before the CLI is called. A duplicate request returns the original result rather than sending twice.
- A command timeout or uncertain delivery stays durable as `in_flight` and returns a 5xx outcome to the website; it must be checked on the bridge host before any manual resend.
- This phase supports text notifications only. It does **not** satisfy the meeting's automatic “信息交接表” extraction or image storage requirements. Those remain dependent on 企业微信会话内容存档 / 数据与智能专区 permissions and a separate inbound worker.
