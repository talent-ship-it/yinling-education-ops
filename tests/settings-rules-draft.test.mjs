import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const client = await readFile(new URL("../app/operations-client.tsx", import.meta.url), "utf8");

test("settings clear the dirty state when a rule draft matches shared rules again", () => {
  const helperStart = client.indexOf("const updateRulesDraft");
  const helperEnd = client.indexOf("const renewalTaskProjectionSnapshot", helperStart);
  const helper = client.slice(helperStart, helperEnd);
  const settingsStart = client.indexOf("const renderSettings");
  const settingsEnd = client.indexOf("const renderAudit", settingsStart);
  const settings = client.slice(settingsStart, settingsEnd);

  assert.match(helper, /const changed = !rulesMatch\(nextRules, rules\)/);
  assert.match(helper, /setRulesDraftTouched\(changed\)/);
  assert.equal((settings.match(/updateRulesDraft\(\{/g) ?? []).length, 2);
  assert.doesNotMatch(settings, /setRulesDraftTouched\(true\)/);
});
