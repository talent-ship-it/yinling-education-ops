import assert from "node:assert/strict";
import test from "node:test";

import { JiaowubaoDirectImportDbFailureClassifier } from "../lib/jiaowubao-direct-import-failure";

function category(chunks: readonly (string | Uint8Array)[], timedOut = false) {
  const classifier = new JiaowubaoDirectImportDbFailureClassifier();
  for (const chunk of chunks) classifier.feed(chunk);
  if (timedOut) classifier.markTimeout();
  return classifier.category();
}

test("database failure classification emits only a split custom import token", () => {
  assert.equal(category([
    "ERROR: customer data and jiaowubao_direct_im",
    "port_schedule_time_proof_invalid\nDETAIL: more private data",
  ]), "jiaowubao_direct_import_schedule_time_proof_invalid");
});

test("database failure classification recognises SQLSTATE without echoing diagnostics", () => {
  assert.equal(category([
    "ERROR: a source value that must never be echoed\n",
    "server response (SQLST",
    "ATE 22023) and another private value",
  ]), "database_sqlstate_22023");
  assert.equal(category(["SQLSTATE 22023X private"]), "database_failure");
  assert.equal(category([
    "psql:apply.sql:123: ERROR:  22",
    "P02: invalid private source value\n",
  ]), "database_sqlstate_22P02");
  assert.equal(category(["ERROR: customer private value"]), "database_failure");
});

test("timeout is classified ahead of SQLSTATE but behind a safe custom token", () => {
  assert.equal(category(["SQLSTATE 57014 private"], true), "database_timeout");
  assert.equal(
    category(["jiaowubao_direct_import_master_source_changed private SQLSTATE 40900"], true),
    "jiaowubao_direct_import_master_source_changed",
  );
});

test("arbitrary stderr and malformed lookalikes collapse to the generic category", () => {
  assert.equal(category(["a student's name and phone only"]), "database_failure");
  assert.equal(category(["JIAOWUBAO_DIRECT_IMPORT_NOT_LOWERCASE"]), "database_failure");
  assert.equal(category(["jiaowubao_direct_import_"]), "database_failure");
  assert.equal(category(["prefix jiaowubao_direct_import_bad-value suffix"]), "database_failure");
});

test("database failure classification ignores private helper names from PostgreSQL context", () => {
  assert.equal(category([
    "ERROR: operator does not exist\n",
    "CONTEXT: PL/pgSQL function internal.jiaowubao_direct_import_assert_envelope(jsonb)\n",
    "SQLSTATE 42883\n",
  ]), "database_sqlstate_42883");
  assert.equal(category([
    "ERROR: jiaowubao_direct_import_envelope_shape_invalid\n",
    "CONTEXT: PL/pgSQL function internal.jiaowubao_direct_import_assert_envelope(jsonb)\n",
  ]), "jiaowubao_direct_import_envelope_shape_invalid");
  assert.equal(category([
    "ERROR: native database failure\nSQLSTATE 42883\n",
    "CONTEXT: PL/pgSQL function internal.stage_jiaowubao_direct_import_chunk(uuid,jsonb,jsonb,text)\n",
  ]), "database_sqlstate_42883");
});

test("relation identifiers cannot mask a SQLSTATE or timeout", () => {
  assert.equal(category([
    "ERROR:  42702: native database failure\n",
    "QUERY: select count(*) from internal.jiaowubao_direct_import_chunks chunk\n",
  ]), "database_sqlstate_42702");
  assert.equal(category([
    "connection closed while scanning internal.jiaowubao_direct_import_chunks\n",
  ], true), "database_timeout");
});
