import { createHash } from "node:crypto";

import { canonicalJson } from "./jiaowubao-direct-import-preflight";
import type { JiaowubaoDirectSequentialImportPlan } from "./jiaowubao-direct-import-projection";

const REVISION = /^sha256:[a-f0-9]{64}$/u;
const ACTOR_MAX_LENGTH = 120;

function sqlDollarLiteral(value: string, purpose: string) {
  const digest = createHash("sha256").update(`${purpose}\u0000${value}`).digest("hex").slice(0, 24);
  let suffix = 0;
  while (true) {
    const tag = `jwb_${purpose}_${digest}${suffix ? `_${suffix}` : ""}`;
    const delimiter = `$${tag}$`;
    if (!value.includes(delimiter)) return `${delimiter}${value}${delimiter}`;
    suffix += 1;
  }
}

function jsonbLiteral(value: unknown, purpose: string) {
  return `${sqlDollarLiteral(canonicalJson(value), purpose)}::jsonb`;
}

/**
 * Build the only approved production writer shape: one client-owned SQL
 * transaction with begin → every bounded stage → complete. The generated SQL
 * contains source evidence and must therefore live only in an owner-only
 * temporary file which the caller deletes after execution.
 */
export function buildJiaowubaoDirectImportTransactionSql(
  plan: JiaowubaoDirectSequentialImportPlan,
) {
  const actor = plan?.begin?.actor;
  const envelope = plan?.begin?.envelope;
  if (!actor || actor !== actor.trim() || actor.length > ACTOR_MAX_LENGTH
    || !envelope || !REVISION.test(envelope.revision)
    || plan.complete.actor !== actor
    || !Array.isArray(plan.stages) || plan.stages.length !== envelope.chunkCount
    || plan.stages.length < 1 || plan.stages.length > 512) {
    throw new Error("The reviewed Jiaowubao direct-import plan is invalid.");
  }

  const revision = sqlDollarLiteral(envelope.revision, "revision");
  const actorLiteral = sqlDollarLiteral(actor, "actor");
  const runIdSql = `(select run_state.id from internal.jiaowubao_direct_import_runs run_state where run_state.source_id = 'jiaowubao-static-excel' and run_state.revision = ${revision} and run_state.state in ('staging', 'complete'))`;
  const statements: string[] = [
    "\\set VERBOSITY verbose",
    "set session role postgres;",
    "begin;",
    "set local lock_timeout = '5s';",
    "set local statement_timeout = '0';",
    "do $jiaowubao_direct_transport_guard$",
    "begin",
    "  if session_user !~ '^cli_login_[a-zA-Z0-9_]+$'",
    "     or current_user <> 'postgres'",
    "     or not pg_catalog.pg_has_role(session_user, 'postgres', 'SET') then",
    "    raise exception using errcode = '42501', message = 'jiaowubao_direct_import_transport_role_invalid';",
    "  end if;",
    "end;",
    "$jiaowubao_direct_transport_guard$;",
    "create temporary table pg_temp.jiaowubao_direct_ops_sentinel on commit drop as",
    "select state_row.entity, state_row.version,",
    "  encode(extensions.digest(state_row.payload::text, 'sha256'), 'hex') as payload_sha256",
    "from public.ops_state state_row",
    "where state_row.entity in ('students', 'teachers', 'bookings');",
    "do $jiaowubao_direct_ops_sentinel_start$",
    "begin",
    "  if (select count(*) from pg_temp.jiaowubao_direct_ops_sentinel) <> 3 then",
    "    raise exception using errcode = '55000', message = 'jiaowubao_direct_import_ops_sentinel_missing';",
    "  end if;",
    "end;",
    "$jiaowubao_direct_ops_sentinel_start$;",
    `select internal.begin_jiaowubao_direct_import(${jsonbLiteral(envelope, "envelope")}, ${actorLiteral});`,
  ];

  for (const [index, stage] of plan.stages.entries()) {
    if (stage.chunk.chunk.index !== index || stage.chunk.chunk.count !== plan.stages.length) {
      throw new Error("The reviewed Jiaowubao chunk sequence is not contiguous.");
    }
    statements.push(
      `select internal.stage_jiaowubao_direct_import_chunk(${runIdSql}, ${jsonbLiteral(stage.chunk, `chunk_${index}`)}, ${jsonbLiteral(stage.projection, `projection_${index}`)}, ${actorLiteral});`,
    );
  }

  statements.push(
    `select internal.complete_jiaowubao_direct_import(${runIdSql}, ${actorLiteral});`,
    "do $jiaowubao_direct_ops_sentinel_end$",
    "begin",
    "  if exists (",
    "    select 1",
    "    from pg_temp.jiaowubao_direct_ops_sentinel saved",
    "    full join (",
    "      select state_row.entity, state_row.version,",
    "        encode(extensions.digest(state_row.payload::text, 'sha256'), 'hex') as payload_sha256",
    "      from public.ops_state state_row",
    "      where state_row.entity in ('students', 'teachers', 'bookings')",
    "    ) current_state using (entity)",
    "    where saved.entity is null or current_state.entity is null",
    "       or saved.version is distinct from current_state.version",
    "       or saved.payload_sha256 is distinct from current_state.payload_sha256",
    "  ) then",
    "    raise exception using errcode = '55000', message = 'jiaowubao_direct_import_changed_operational_state';",
    "  end if;",
    "end;",
    "$jiaowubao_direct_ops_sentinel_end$;",
    "select jsonb_build_object(",
    "  'runId', run_state.id,",
    "  'state', run_state.state,",
    "  'revision', run_state.revision,",
    "  'payloadSha256', run_state.payload_sha256,",
    "  'chunkCount', (select count(*) from internal.jiaowubao_direct_import_chunks chunk where chunk.run_id = run_state.id),",
    "  'supplementalRecords', (select count(*) from internal.jiaowubao_direct_supplemental_records record where record.run_id = run_state.id),",
    "  'scheduleEvents', (select count(*) from internal.jiaowubao_direct_schedule_events event where event.run_id = run_state.id),",
    "  'scheduleParticipants', (select count(*) from internal.jiaowubao_direct_schedule_event_participants participant join internal.jiaowubao_direct_schedule_events event on event.id = participant.event_id where event.run_id = run_state.id),",
    "  'leaveMakeups', (select count(*) from internal.jiaowubao_direct_leave_makeup_events incident where incident.run_id = run_state.id)",
    ") as import_receipt",
    "from internal.jiaowubao_direct_import_runs run_state",
    `where run_state.source_id = 'jiaowubao-static-excel' and run_state.revision = ${revision} and run_state.state in ('staging', 'complete');`,
    "commit;",
    "",
  );
  return statements.join("\n");
}

/**
 * Build the production resumable transport protocol.
 *
 * The session remains authenticated for the whole import, but every bounded
 * stage call is committed independently.  A connection loss therefore loses
 * at most the current chunk; rerunning this exact SQL protocol calls `begin`
 * again and asks PostgreSQL to replay-check each persisted chunk before it
 * moves on.  Until the final short completion transaction, internal readers
 * intentionally exclude this staging run.
 *
 * The JSON values selected after each COMMIT are a small, non-PII progress
 * protocol for the trusted CLI.  They are deliberately not database data
 * readers and must be whitelist-validated before the CLI prints them.
 */
export function buildJiaowubaoDirectImportResumableSql(
  plan: JiaowubaoDirectSequentialImportPlan,
) {
  const actor = plan?.begin?.actor;
  const envelope = plan?.begin?.envelope;
  if (!actor || actor !== actor.trim() || actor.length > ACTOR_MAX_LENGTH
    || !envelope || !REVISION.test(envelope.revision)
    || plan.complete.actor !== actor
    || !Array.isArray(plan.stages) || plan.stages.length !== envelope.chunkCount
    || plan.stages.length < 1 || plan.stages.length > 512) {
    throw new Error("The reviewed Jiaowubao direct-import plan is invalid.");
  }

  const revision = sqlDollarLiteral(envelope.revision, "resumable_revision");
  const actorLiteral = sqlDollarLiteral(actor, "resumable_actor");
  const runId = ":'jiaowubao_direct_run_id'::uuid";
  const statements: string[] = [
    "\\set VERBOSITY verbose",
    "set session role postgres;",
    "do $jiaowubao_direct_transport_guard$",
    "begin",
    "  if session_user !~ '^cli_login_[a-zA-Z0-9_]+$'",
    "     or current_user <> 'postgres'",
    "     or not pg_catalog.pg_has_role(session_user, 'postgres', 'SET') then",
    "    raise exception using errcode = '42501', message = 'jiaowubao_direct_import_transport_role_invalid';",
    "  end if;",
    "end;",
    "$jiaowubao_direct_transport_guard$;",
    "begin;",
    "set local lock_timeout = '5s';",
    "set local statement_timeout = '0';",
    `select internal.begin_jiaowubao_direct_import(${jsonbLiteral(envelope, "resumable_envelope")}, ${actorLiteral}) as jiaowubao_direct_run_id \\gset`,
    "commit;",
    "select jsonb_build_object(",
    "  'event', 'beginCommitted',",
    `  'runId', ${runId},`,
    `  'revision', ${revision}`,
    ") as jiaowubao_direct_progress;",
  ];

  for (const [index, stage] of plan.stages.entries()) {
    if (stage.chunk.chunk.index !== index || stage.chunk.chunk.count !== plan.stages.length) {
      throw new Error("The reviewed Jiaowubao chunk sequence is not contiguous.");
    }
    statements.push(
      "begin;",
      "set local lock_timeout = '5s';",
      "set local statement_timeout = '0';",
      `select internal.stage_jiaowubao_direct_import_chunk(${runId}, ${jsonbLiteral(stage.chunk, `resumable_chunk_${index}`)}, ${jsonbLiteral(stage.projection, `resumable_projection_${index}`)}, ${actorLiteral}) as jiaowubao_direct_stage_receipt \\gset`,
      "commit;",
      "select jsonb_build_object(",
      "  'event', 'chunkCommitted',",
      `  'runId', ${runId},`,
      `  'chunkIndex', ${index},`,
      `  'chunkCount', ${plan.stages.length},`,
      "  'stageReceipt', :'jiaowubao_direct_stage_receipt'::jsonb",
      ") as jiaowubao_direct_progress;",
    );
  }

  statements.push(
    "begin;",
    "set local lock_timeout = '5s';",
    "set local statement_timeout = '0';",
    `select internal.complete_jiaowubao_direct_import(${runId}, ${actorLiteral}) as jiaowubao_direct_completion_result \\gset`,
    "select jsonb_build_object(",
    `  'runId', ${runId},`,
    "  'state', run_state.state,",
    "  'revision', run_state.revision,",
    "  'payloadSha256', run_state.payload_sha256,",
    "  'chunkCount', (select count(*) from internal.jiaowubao_direct_import_chunks chunk where chunk.run_id = run_state.id),",
    "  'supplementalRecords', (select count(*) from internal.jiaowubao_direct_supplemental_records record where record.run_id = run_state.id),",
    "  'scheduleEvents', (select count(*) from internal.jiaowubao_direct_schedule_events event where event.run_id = run_state.id),",
    "  'scheduleParticipants', (select count(*) from internal.jiaowubao_direct_schedule_event_participants participant join internal.jiaowubao_direct_schedule_events event on event.id = participant.event_id where event.run_id = run_state.id),",
    "  'leaveMakeups', (select count(*) from internal.jiaowubao_direct_leave_makeup_events incident where incident.run_id = run_state.id)",
    ") as jiaowubao_direct_complete_receipt",
    "from internal.jiaowubao_direct_import_runs run_state",
    `where run_state.id = ${runId} \\gset`,
    "commit;",
    "select jsonb_build_object(",
    "  'event', 'complete',",
    "  'receipt', :'jiaowubao_direct_complete_receipt'::jsonb",
    ") as jiaowubao_direct_progress;",
    "",
  );
  return statements.join("\n");
}
