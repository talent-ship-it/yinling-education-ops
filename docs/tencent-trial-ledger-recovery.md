# Tencent ledger recovery rollout

The mirror retains the existing 13 visible columns. The database now pins the
original `students` / `lpItems` source snapshot until Tencent read-back and the
immutable LP-to-record mapping commit. A failed or expired worker receives that
same source on retry. New source versions remain queued; after recovery, they
update the known Tencent record instead of creating an additional row.

## Release order

1. Verify the approved Insider Leads project `orvsgisjjrzgtxuwwsms` and inspect
   the following aggregate preflight through the approved read-only route:

   ```sql
   select
     (select count(*) from internal.tencent_trial_ledger_sync_runs
       where status = 'processing') as active_runs,
     (select count(*) from internal.tencent_trial_ledger_outbox
       where status <> 'completed' and attempt_count > 0) as uncertain_legacy_events;
   ```

2. Drain active workers before the migration. If old uncertain events exist,
   reconcile their Tencent receipts before rollout. The old implementation did
   not retain the original values, so the migration intentionally refuses to
   guess them or silently discard pending work. This patch does not claim to
   identify or repair existing duplicate production rows.
3. With explicit production migration authorization, apply only
   `20260908050013_tencent_trial_ledger_durable_recovery.sql` in a transaction.
   It upgrades the existing claim for compatible workers and exposes a v2 claim
   for the new application. Source snapshots are stored in a private RLS table
   with all application-role table grants revoked.
4. Release application code through the reviewed GitHub production-branch
   merge. The new application requires the v2 RPC; it returns the existing
   contract-unavailable response if the migration is missing.
5. Verify a normal batch completes and any newer source versions remain pending
   until the original snapshot is acknowledged. Only aggregate receipts belong
   in logs; never print the pinned source rows.

After retry exhaustion, the snapshot remains retained and the claim raises
`tencent_trial_ledger_recovery_required`. A new source version cannot bypass an
uncertain write. An authorized operator must reconcile the retained batch and
requeue its existing outbox events, keeping the snapshot intact; do not delete
the snapshot or mark the uncertain batch completed merely to clear the error.

Changes to the mirror's transformation logic must likewise drain or reconcile
pending snapshots before release. This migration fixes operational source
changes during retries; it does not version different transformation code.

## Local verification

Run the real migration and its recovery fixture in an empty disposable local
PostgreSQL database; the fixture transaction rolls back all objects:

```sh
psql -X -v ON_ERROR_STOP=1 -d DISPOSABLE_DATABASE -f tests/sql/tencent-trial-ledger-recovery-runtime.sql
node --import tsx --test tests/tencent-trial-ledger*.test.ts tests/tencent-trial-ledger*.test.mjs
```

The SQL fixture exercises source changes after an uncertain add, retry backoff,
new-version isolation, durable mappings, lease expiry, retry exhaustion, and
table access restrictions. The planner regression verifies adoption followed
by updating the same record when the payment state changes.
