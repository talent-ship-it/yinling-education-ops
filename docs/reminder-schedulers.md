# Production reminder schedulers

LP parent-progress and trial-payment reminders need a server clock even when no
operator is editing a booking. The handlers are deployed separately from their
Supabase pg_cron registrations; `vercel.json` intentionally has no cron entries.

| Job | Cron schedule | Protected GET route |
|---|---|---|
| `lp-parent-progress-5m` | `1-59/5 * * * *` | `/api/cron/lp-parent-progress` |
| `trial-payment-reminders-5m` | `3-59/5 * * * *` | `/api/cron/trial-payment` |

Both jobs target `https://app.insiderleadsedu.com` in Supabase project
`orvsgisjjrzgtxuwwsms`. Register only after explicit production-change approval,
fresh target verification, and successful deployment of these handlers.

Use a dedicated random credential in Vercel Production's sensitive environment
variable `OPS_REMINDER_CRON_SECRET` and Supabase Vault's
`yinling_ops_reminder_cron_secret`. Transfer values only through controlled memory
and stdin; never include them in source files, shell arguments, or local logs.
The existing Vercel `CRON_SECRET` remains accepted by these two routes. Other
cron handlers do not accept the new credential. Vercel sensitive values cannot
be exported later, so keep Vault as the recoverable copy for this integration.

The reviewed registration SQL is `scripts/activate-reminder-schedulers.sql`.
It refuses missing/duplicate credentials or existing target jobs and references
the Vault name in each command rather than embedding a secret. It does not run
as an application migration or build step. Credentials must be configured
before the GitHub merge that creates the production deployment.

After activation, verify HTTP results and the business ledgers
`internal.lp_parent_progress_scheduler_runs` and
`internal.trial_payment_reconcile_runs`. Check changed counts, task versions,
and the next scheduled execution for convergence. A cron `succeeded` receipt
only proves HTTP dispatch, not business completion. First execution may create
or update task reminders; these handlers do not send external messages.

To stop this integration, deactivate only these two named jobs. Preserve run
ledgers and existing tasks; do not delete or blindly replay production data.
