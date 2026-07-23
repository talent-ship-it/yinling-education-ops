# Yinling Education Operations

Internal operations MVP for Insider Leads / 吟领教育教务.

The app is a Next.js site backed by Supabase shared state. It is currently an internal demo using one shared password so the team can review the operating logic without individual accounts.

## Current Shape

- Student CRM with owner-scoped views, status updates, file index, LP needs, exam and renewal fields.
- Teacher resource library with subject filters, AVA display, manual structured AVA entry, and availability-based scheduling checks.
- Scheduling, LP workflows, exception handling, renewals, payroll preview, message queue, file index, reports, settings, and audit log.
- Supabase is the write target for in-app changes.
- Tencent Docs sources are read-only mirrors. The app does not write back to Tencent Docs.
- External message sending is not connected yet; message actions only create or mark internal records.

## Access Model

All reviewers use the same demo password. The internal MVP always accepts `admin`; `DEMO_PASSWORD` can additionally enable an environment-specific password in hosted environments. Inside the app, the top-right operator selector changes the visible working view:

- `Nixon` sees the global management workspace.
- Staff views show records and tasks tied to that person or their students.

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

- `DEMO_PASSWORD` optional; `admin` remains accepted for the current internal MVP
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `OPS_API_SECRET`

Do not commit real data snapshots or secrets to GitHub.
