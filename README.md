# Yinling Education Operations

Internal operations MVP for Insider Leads / 吟领教育教务.

The app is a Next.js site backed by Supabase shared state. It is currently an internal demo with password-selected work views so the team can review the operating logic before full account management is added.

## Current Shape

- Student CRM with owner-scoped views, status updates, file index, LP needs, exam and renewal fields.
- Teacher resource library with subject filters, AVA display, manual structured AVA entry, and availability-based scheduling checks.
- Scheduling, LP workflows, exception handling, renewals, and a month-based payroll workspace with Excel export, teacher onboarding, rate maintenance, review locks, and audit history.
- Per-account display preferences support Chinese or English interface labels, locale-aware date/time formats, timezone selection, and text sizing. English mode translates system-controlled UI while preserving names and source records as entered.
- Supabase is the write target for in-app changes.
- Tencent roster and handbook sources remain read-only. The dedicated 13-column trial-review SmartSheet is a one-way, private projection written every 15 minutes by the production system through Tencent's MCP API; staff corrections are made in the app and then mirrored to Tencent. Codex is not part of the scheduled run path.
- WeCom conversation-archive ingestion is implemented as a disabled-by-default, post-cutoff server bridge. Once its independent token/cutoff and authorised WeCom worker are configured, exact student matches are projected into internal messages and private student files; unresolved matches stay in the admin inbox. External message sending remains disconnected, so message actions still only create or mark internal records.

## Access Model

The login password determines the demo work view:

- The Admin password opens the global management workspace and can switch into every staff view.
- The limited Admin password opens a global operations workspace except all payroll data and payroll pages.
- In local development, a staff member can enter their own name as the demo password and see only their own work view.
- Staff and teacher access temporarily uses the account name itself as the password in the internal review environment.
- Logging in as staff clears any prior Admin session in that browser, including payroll access.

This is intentional for the current internal MVP. It is not the final production authentication model.

## Development

```bash
npm install
npm run dev
npm run lint
npm run build
node --test tests/rendered-html.test.mjs
```

The local dev server uses a fixed port through `scripts/dev-fixed-port.mjs`.

## Required Environment

- `NIXON_PASSWORD_HASH` and `NIXON_PASSWORD_SALT` — Admin legacy bootstrap credential using the application's `scrypt-v1` format (128 lowercase hexadecimal hash and 32 lowercase hexadecimal salt); there is no source-code fallback
- `LIMITED_ADMIN_PASSWORD_HASH` and `LIMITED_ADMIN_PASSWORD_SALT` — limited Admin legacy bootstrap credential in the same `scrypt-v1` format; there is no source-code fallback
- `DEMO_SESSION_SECRET` — independent 256-bit key encoded as exactly 64 lowercase hexadecimal characters; signs only transitional legacy sessions
- `NIXON_SESSION_SECRET` — independent 256-bit key encoded as exactly 64 lowercase hexadecimal characters; signs session-bound Admin elevation markers
- `ACCOUNT_PASSWORD_COMMAND_SECRET` — independent 256-bit key encoded as exactly 64 lowercase hexadecimal characters; derives password-command salts
- `ACCOUNT_ISSUED_PASSWORD_SECRET` — independent 256-bit key encoded as exactly 64 lowercase hexadecimal characters; encrypts Admin-issued password escrow
- `ACCOUNT_AUTH_THROTTLE_SECRET` — independent 256-bit key encoded as exactly 64 lowercase hexadecimal characters; pseudonymizes authentication throttle dimensions
- `MFA_ENCRYPTION_KEY` — independent 256-bit key encoded as exactly 64 lowercase hexadecimal characters; encrypts TOTP secrets
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `OPS_API_SECRET` — database RPC authentication only; do not reuse it for any key above
- `STUDENT_IMPORT_IDENTITY_REVIEW_TOKEN_SECRET` — independent 256-bit key encoded as exactly 64 lowercase hexadecimal characters; never reuse `OPS_API_SECRET`
- `WECOM_ARCHIVE_BRIDGE_TOKEN` — independent high-entropy bearer token used only by the authorised conversation-archive worker
- `WECOM_ARCHIVE_STARTED_AT` — exact ISO timestamp; records before this post-join cutoff are rejected
- `WECOM_CALLBACK_TOKEN`, `WECOM_CALLBACK_ENCODING_AES_KEY`, `WECOM_CORP_ID` — optional standard app-callback verification values; these are separate from the conversation-archive data-zone keys

Do not commit real data snapshots or secrets to GitHub.
