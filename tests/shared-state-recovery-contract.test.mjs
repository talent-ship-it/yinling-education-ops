import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [client, helper] = await Promise.all([
  readFile(new URL("../app/operations-client.tsx", import.meta.url), "utf8"),
  readFile(new URL("../lib/shared-state-recovery.ts", import.meta.url), "utf8"),
]);

test("generic shared writes recover unknown results from a complete authoritative entity read", () => {
  const hook = client.slice(client.indexOf("function useSharedState"), client.indexOf("function nowLabel"));
  assert.match(helper, /AbortController/);
  assert.match(helper, /SHARED_STATE_REQUEST_TIMEOUT_MS = 10_000/);
  assert.match(helper, /entities=\$\{encodeURIComponent\(input\.entity\)\}/);
  assert.match(helper, /outcome: "authoritative"/);
  assert.match(helper, /outcome: "baseline"/);
  assert.match(hook, /sentCommittedBaseline/);
  assert.match(hook, /fetchWithTimeout\(fetch, "\/api\/app-state"/);
  assert.match(hook, /recoverSharedStateAfterUnknownWrite\(/);
  assert.match(hook, /committedBaseline: sentCommittedBaseline/);
  assert.match(hook, /if \(body\.accessChanged \|\| current\.version <= versionRef\.current\) \{\s*throw new Error/);
  assert.doesNotMatch(hook, /if \(current\.version <= versionRef\.current\) return/);
  assert.match(hook, /setValue\(recoveredRow\.payload\)/);
  assert.match(hook, /committedRef\.current = JSON\.stringify\(recoveredRow\.payload\)/);
  assert.match(hook, /remoteGenerationRef\.current \+= 1/);
  assert.match(hook, /window\.clearTimeout\(timerRef\.current\)/);
  const recovery = hook.slice(hook.indexOf("const recoveryGeneration"), hook.indexOf("const applyRemote"));
  assert.doesNotMatch(recovery, /mergeConcurrentPayload/);
  assert.doesNotMatch(recovery, /fetch\(\"\/api\/app-state\",\s*\{\s*method:\s*\"PUT\"/);
});
