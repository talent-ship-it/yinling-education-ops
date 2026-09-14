# Yinling Education Operations

Internal operations MVP for Insider Leads / 吟领教育教务.

The app is a Next.js internal operations site backed by Supabase shared state. Each managed user signs in with an account/name and password; the server binds the resulting session to that account's role and data scope.

## Current Shape

- Student CRM with owner-scoped views, status updates, file index, LP needs, exam and renewal fields.
- Teacher resource library with subject filters, AVA display, manual structured AVA entry, and availability-based scheduling checks.
- Scheduling, LP workflows, exception handling, renewals, and a month-based payroll workspace with a six-sheet Open XML `.xlsx` export, teacher onboarding, rate maintenance, review locks, and audit history. The completed-month workbook keeps student consumption and role-specific teacher hours as distinct JiaoWuBao evidence sources.
- Per-account display preferences support Chinese or English interface labels, locale-aware date/time formats, timezone selection, and text sizing. English mode translates system-controlled UI while preserving names and source records as entered.
- Supabase is the write target for in-app changes.
- Tencent roster and handbook sources remain read-only. The dedicated 13-column trial-review SmartSheet is a one-way, private projection written every 15 minutes by the production system through Tencent's MCP API; staff corrections are made in the app and then mirrored to Tencent. Codex is not part of the scheduled run path.
- WeCom conversation-archive ingestion is implemented as a disabled-by-default, post-cutoff server bridge. Once its independent token/cutoff and authorised WeCom worker are configured, exact student matches are projected into internal messages and private student files; unresolved matches stay in the admin inbox. External message sending remains disconnected, so message actions still only create or mark internal records.

## Access Model

- Managed accounts use an account/name plus an independent password; passwords are verified server-side and are never stored in source control.
- Admin, limited-admin, staff, and teacher roles are bound to the authenticated account and determine the available pages and data scope. Limited administrators cannot access payroll.
- A full administrator can manage account status, issue/reset passwords, revoke sessions, and configure permissions. Password and access changes are audited.
- Users can change their own password, review active sessions, and configure MFA when their account has an independent password.
- A narrow legacy bootstrap remains only for accounts that have not yet adopted an independent password. Once migrated, the account/name field is required and the legacy password-only path is rejected.
- Signing out or changing a password invalidates the relevant server session; one browser session cannot inherit a prior administrator's payroll access.

## Development

```bash
npm ci
npm run dev
npm run lint
npm test
```

The local dev server uses a fixed port through `scripts/dev-fixed-port.mjs`.
`npm test` builds the app and then runs all unit/contract tests. Use
`npm run test:unit` to rerun tests against an existing build. The test runner
uses UTC and excludes inherited deployment credentials; tests supply their
own synthetic fixtures.

GitHub Actions runs install, lint, build, the full test suite, and a production
dependency audit on pull requests and pushes to `main` or `codex/**`.
The repository's `vercel.json` also requires lint and the complete build/test
command to succeed before a deployment can become ready. Its
[build command overrides the dashboard setting](https://vercel.com/docs/project-configuration/vercel-json#buildcommand).
Required GitHub status checks still depend on repository plan and protection
settings; this workflow does not change those settings. SQL runtime fixtures
run separately on explicitly marked disposable databases; see
[their instructions](tests/sql/README.md).

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
- `OPS_API_SECRET` — database RPC authentication only for new data. Password escrow created before `ACCOUNT_ISSUED_PASSWORD_SECRET` existed is decrypt-only compatible with this key and is atomically rewrapped under the dedicated key when an administrator reveals it.
- `STUDENT_IMPORT_IDENTITY_REVIEW_TOKEN_SECRET` — independent 256-bit key encoded as exactly 64 lowercase hexadecimal characters; never reuse `OPS_API_SECRET`
- `WECOM_ARCHIVE_BRIDGE_TOKEN` — independent high-entropy bearer token used only by the authorised conversation-archive worker
- `WECOM_ARCHIVE_STARTED_AT` — exact ISO timestamp; records before this post-join cutoff are rejected
- `WECOM_CALLBACK_TOKEN`, `WECOM_CALLBACK_ENCODING_AES_KEY`, `WECOM_CORP_ID` — optional standard app-callback verification values; these are separate from the conversation-archive data-zone keys
- `JIAOWUBAO_OPEN_API_SK` — server-only key for the documented 教务宝 gateway; never expose it with a `NEXT_PUBLIC_` prefix
- `JIAOWUBAO_COMPLETED_LESSON_SYNC_TOKEN` — independent high-entropy bearer used only by the monthly completed-lesson cron; the same value must exist exactly once in Supabase Vault as `jiaowubao_completed_lesson_sync_token`

Do not commit real data snapshots or secrets to GitHub.
