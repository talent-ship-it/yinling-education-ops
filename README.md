# Yinling Education Operations

Internal operations MVP for Insider Leads / 吟领教育教务.

The app is a Next.js site backed by Supabase shared state. It is currently an internal demo with password-selected work views so the team can review the operating logic before full account management is added.

## Current Shape

- Student CRM with owner-scoped views, status updates, file index, LP needs, exam and renewal fields.
- Teacher resource library with subject filters, AVA display, manual structured AVA entry, and availability-based scheduling checks.
- Scheduling, LP workflows, exception handling, renewals, and a month-based payroll workspace with Excel export, teacher onboarding, rate maintenance, review locks, and audit history.
- Per-account display preferences support Chinese or English interface labels, locale-aware date/time formats, timezone selection, and text sizing. English mode translates system-controlled UI while preserving names and source records as entered.
- Supabase is the write target for in-app changes.
- Tencent Docs sources are read-only mirrors. The app does not write back to Tencent Docs.
- External message sending is not connected yet; message actions only create or mark internal records.

## Access Model

The login password determines the demo work view:

- The Admin password opens the global management workspace and can switch into every staff view.
- The limited Admin password opens a global operations workspace except all payroll data and payroll pages.
- A staff member enters their own name as the demo password and can only see their own work view.
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

- `NIXON_PASSWORD_HASH` optional; the internal Admin password hash has a fallback for the current demo
- `LIMITED_ADMIN_PASSWORD_HASH` optional; the limited Admin password hash has a fallback for the current demo
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `OPS_API_SECRET`

Do not commit real data snapshots or secrets to GitHub.
