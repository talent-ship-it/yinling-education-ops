# Disposable SQL runtime fixtures

Use a dedicated local PostgreSQL cluster with synthetic data. Every destructive
fixture refuses a database unless its name matches `il_fixture_[a-z0-9_]+` and
its database comment is exactly `insiderleads-disposable-fixture`. Both checks
also run on each dblink connection before it executes test mutations.

```sh
createdb il_fixture_review
psql -d il_fixture_review -c "COMMENT ON DATABASE il_fixture_review IS 'insiderleads-disposable-fixture'"
psql -d il_fixture_review -f tests/sql/student-operation-atomic-runtime.sql
```

Single-connection fixtures roll back their complete setup and test changes.
`booking-projection-atomic-runtime.sql`, `lp-atomic-runtime.sql`, and
`trial-payment-reminders-runtime.sql` use multiple connections and intentionally
commit fixture state so those connections can see it. Use a fresh dedicated
database for each run; never mark an application database as disposable.

The student/operation concurrency fixture requires explicit persistent seeding:

```sh
psql -d il_fixture_review -v fixture_keep_state=true -f tests/sql/student-operation-atomic-runtime.sql
PGOPTIONS="-c student_operation.dsn=dbname=il_fixture_review" psql -d il_fixture_review -f tests/sql/student-operation-atomic-concurrency.sql
```

Add host, port, and user to both connection settings when using a separate local
cluster. An unmarked dblink destination is rejected even if the primary
database is marked. Do not use production credentials with these fixtures.

The WeCom lock-order regression rebuilds a synthetic schema and uses two real
connections. It reproduces the old deadlock before applying the new migration,
then checks archive and bot batches in opposite orders, including exact insert
and duplicate counts. It commits its fixture state for inspection:

```sh
createdb il_fixture_wecom
psql -d il_fixture_wecom -c "COMMENT ON DATABASE il_fixture_wecom IS 'insiderleads-disposable-fixture'"
PGDATABASE=il_fixture_wecom python3 tests/sql/wecom-batch-lock-order-runtime.py
```

Use the normal `PGHOST`, `PGPORT`, and `PGUSER` variables for a dedicated local
cluster. `PSQL` can select an absolute path to the PostgreSQL client binary.

The trial-handover identity fixture verifies that an initial WeChat-name-only
handover remains internal and awaits a student name, then a same-group identity
confirmation updates that exact case without creating operational state:

```sh
createdb il_fixture_wecom_identity
psql -d il_fixture_wecom_identity -c "COMMENT ON DATABASE il_fixture_wecom_identity IS 'insiderleads-disposable-fixture'"
psql -d il_fixture_wecom_identity -f tests/sql/wecom-trial-handover-identity-runtime.sql
```
