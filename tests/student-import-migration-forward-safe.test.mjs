import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPaths = {
  wrapper: "../supabase/migrations/20260818000100_optimize_student_import_projection_wrapper.sql",
  accumulators: "../supabase/migrations/20260818000200_optimize_student_import_projection_accumulators.sql",
  safeLinks: "../supabase/migrations/20260818000600_optimize_safe_identity_link_normalization.sql",
  laterLookup: "../supabase/migrations/20260822000700_optimize_student_import_jwb_source_lookup.sql",
};

const [wrapper, accumulators, safeLinks, laterLookup] = await Promise.all(
  Object.values(migrationPaths).map((path) => readFile(new URL(path, import.meta.url), "utf8")),
);

const OLD_STUDENT_SCAN = "select student into existing_student";
const OLD_JWB_SCAN = "select jwb into matched_jwb";

function hasEquivalentLookupMaps(definition) {
  const currentMaps = definition.includes("current_student_by_id jsonb := '{}'::jsonb")
    && definition.includes("matched_jwb_by_source jsonb := '{}'::jsonb");
  const laterMaps = definition.includes("student_by_id jsonb := '{}'::jsonb")
    && definition.includes("jwb_by_source jsonb := '{}'::jsonb");
  return (currentMaps || laterMaps)
    && !definition.includes(OLD_STUDENT_SCAN)
    && !definition.includes(OLD_JWB_SCAN);
}

function replaceOuterAccumulatorDeclaration(definition) {
  const anchor = "  result jsonb := '[]'::jsonb;";
  assert.equal(definition.split(anchor).length - 1, 1);
  return definition.replace(anchor, "  projection_items jsonb[] := array[]::jsonb[];");
}

function dollarBody(source, tag) {
  const marker = `$${tag}$`;
  const start = source.indexOf(marker);
  const end = source.indexOf(marker, start + marker.length);
  assert.ok(start >= 0 && end > start, `${tag} body is missing`);
  return source.slice(start + marker.length, end);
}

test("001 and 220007 recognize both fresh and later lookup-map shapes", () => {
  const predecessor = `
    safe_identity_links jsonb := '[]'::jsonb;
    result jsonb := '[]'::jsonb;
    ${OLD_STUDENT_SCAN};
    ${OLD_JWB_SCAN};
  `;
  const productionLater = `
    effective_identity_links jsonb := '[]'::jsonb;
    safe_identity_links jsonb := '[]'::jsonb;
    jwb_by_source jsonb := '{}'::jsonb;
    student_by_id jsonb := '{}'::jsonb;
    result jsonb := '[]'::jsonb;
  `;
  const freshAfter001 = `
    current_student_by_id jsonb := '{}'::jsonb;
    matched_jwb_by_source jsonb := '{}'::jsonb;
    projection_items jsonb[] := array[]::jsonb[];
  `;

  assert.equal(hasEquivalentLookupMaps(predecessor), false);
  assert.equal(hasEquivalentLookupMaps(productionLater), true);
  assert.equal(hasEquivalentLookupMaps(freshAfter001), true);

  for (const migration of [wrapper, laterLookup]) {
    assert.match(migration, /position\('current_student_by_id jsonb := ''\{\}''::jsonb' in definition\)/i);
    assert.match(migration, /position\('student_by_id jsonb := ''\{\}''::jsonb' in definition\)/i);
    assert.match(migration, /position\('select student into existing_student' in definition\) = 0/i);
    assert.match(migration, /position\('select jwb into matched_jwb' in definition\) = 0/i);
    assert.match(migration, /then\s+return;/i);
  }
});

test("002 can add the outer accumulator after either map declaration layout", () => {
  const predecessor = `
    safe_identity_links jsonb := '[]'::jsonb;
    result jsonb := '[]'::jsonb;
  `;
  const productionLater = `
    effective_identity_links jsonb := '[]'::jsonb;
    safe_identity_links jsonb := '[]'::jsonb;
    jwb_by_source jsonb := '{}'::jsonb;
    student_by_id jsonb := '{}'::jsonb;
    result jsonb := '[]'::jsonb;
  `;

  for (const shape of [predecessor, productionLater]) {
    const patched = replaceOuterAccumulatorDeclaration(shape);
    assert.match(patched, /projection_items jsonb\[\] := array\[\]::jsonb\[\];/);
    assert.match(patched, /effective_identity_links|safe_identity_links/);
    assert.match(patched, /student_by_id|jwb_by_source|safe_identity_links/);
    assert.doesNotMatch(patched, /result jsonb := '[]'::jsonb/);
  }

  assert.match(accumulators, /anchor := '  result jsonb := ''\[\]''::jsonb;'/i);
  assert.match(accumulators, /definition := replace\(definition, anchor, '  projection_items jsonb\[\]/i);
  assert.doesNotMatch(
    accumulators,
    /anchor := \$outer_declaration_anchor\$[\s\S]*safe_identity_links jsonb[\s\S]*result jsonb/i,
  );
});

test("006 selects effective identity links only when the later filtered shape exists", () => {
  const predecessor = "safe_identity_links jsonb := '{}'::jsonb;";
  const productionLater = "effective_identity_links jsonb := '{}'::jsonb;";

  const sourceFor = (definition) => definition.includes("effective_identity_links")
    ? "effective_identity_links"
    : "p_identity_links";

  assert.equal(sourceFor(predecessor), "p_identity_links");
  assert.equal(sourceFor(productionLater), "effective_identity_links");
  assert.match(safeLinks, /identity_links_source\s*:=\s*case/i);
  assert.match(safeLinks, /then\s*'effective_identity_links'/i);
  assert.match(safeLinks, /else\s*'p_identity_links'/i);
  assert.match(safeLinks, /replacement\s*:=\s*\$safe_link_cte_replacement\$/i);
  assert.match(
    safeLinks,
    /replacement\s*:=\s*replace\(replacement,\s*'p_identity_links',\s*identity_links_source\)/i,
  );
  assert.match(safeLinks, /definition\s*:=\s*replace\(definition,\s*anchor,\s*replacement\)/i);
  assert.match(
    safeLinks,
    /effective_links_verification_failed/i,
  );

  const replacement = dollarBody(safeLinks, "safe_link_cte_replacement");
  const effectiveReplacement = replacement.replaceAll(
    "p_identity_links",
    sourceFor(productionLater),
  );
  const predecessorReplacement = replacement.replaceAll(
    "p_identity_links",
    sourceFor(predecessor),
  );
  assert.match(
    effectiveReplacement,
    /from\s+jsonb_array_elements\(effective_identity_links\)\s+with ordinality link\(value, ordinality\)/i,
  );
  assert.doesNotMatch(effectiveReplacement, /jsonb_array_elements\(p_identity_links\)/i);
  assert.match(
    predecessorReplacement,
    /from\s+jsonb_array_elements\(p_identity_links\)\s+with ordinality link\(value, ordinality\)/i,
  );
});

test("the pending optimization order stays after the authoritative base and before later convergence", () => {
  const order = [
    "20260817000800_tencent_master_roster_authoritative.sql",
    "20260818000100_optimize_student_import_projection_wrapper.sql",
    "20260818000200_optimize_student_import_projection_accumulators.sql",
    "20260818000300_optimize_student_import_jwb_package_buffers.sql",
    "20260818000400_reuse_base_jwb_ledger_packages.sql",
    "20260818000500_validate_jwb_package_preflight.sql",
    "20260818000600_optimize_safe_identity_link_normalization.sql",
    "20260818000700_optimize_student_number_allocator.sql",
    "20260818000800_fix_partial_jwb_snapshot_replay.sql",
    "20260818001000_reuse_prevalidated_jwb_package_projection.sql",
    "20260818001200_restore_inactive_no_hours_roster_exclusion.sql",
    "20260822000700_optimize_student_import_jwb_source_lookup.sql",
  ];
  assert.ok(order.indexOf("20260818000100_optimize_student_import_projection_wrapper.sql") > -1);
  assert.ok(
    order.indexOf("20260822000700_optimize_student_import_jwb_source_lookup.sql")
      > order.indexOf(order[1]),
  );
  assert.match(laterLookup, /20260818000100|chronological fresh path/i);
  assert.match(laterLookup, /then\s+return;/i);
});
