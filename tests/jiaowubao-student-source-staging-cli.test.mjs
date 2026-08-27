import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const {
  callSupabaseRpc,
  candidateManifestSha256,
  parseArguments,
  parseSupabaseApiKey,
  parseSupabaseUrl,
  readSupabaseApiKeyFromEnvironment,
} = await import("../scripts/jiaowubao-student-source-staging.ts");

const source = await readFile(new URL(
  "../scripts/jiaowubao-student-source-staging.ts",
  import.meta.url,
), "utf8");

test("student source CLI has an explicit local-input, HTTPS API, and secret boundary", () => {
  assert.match(source, /--input/);
  assert.match(source, /--manifest/);
  assert.match(source, /--supabase-url/);
  assert.match(source, /--supabase-key-file/);
  assert.match(source, /--supabase-key-env/);
  assert.match(source, /orvsgisjjrzgtxuwwsms\.supabase\.co/);
  assert.match(source, /parsed\.protocol !== "https:"/);
  assert.match(source, /JIAOWUBAO_OPS_SECRET/);
  assert.match(source, /JIAOWUBAO_OPS_SECRET.*required/s);
  assert.match(source, /negativeAdjustmentPolicy.*aggregate-only/s);
  assert.match(source, /source_only_identity_review_pending/);
  assert.match(source, /masterRevisionPinned: false/);
  assert.doesNotMatch(source, /console\.log\([^)]*input|console\.log\([^)]*payload/iu);
});

test("planner closures are mapped explicitly and every chunk is replayed", () => {
  assert.match(source, /export function plannerChunkPayload/);
  assert.match(source, /closure\.row/);
  assert.match(source, /closure\.rowCanonicalJson/);
  assert.match(source, /closure\.rowSha256/);
  assert.match(source, /closure\.closureCanonicalJson/);
  assert.match(source, /closure\.closureSha256/);
  assert.match(source, /for \(let index = 0; index < plan\.chunks\.length; index \+= 1\)/);
  assert.match(source, /Always replay every chunk from index zero/);
});

test("Supabase RPC calls are independently bounded and never spawn a child", () => {
  assert.match(source, /fetch\(`\$\{supabaseUrl\}\/rest\/v1\/rpc\/\$\{rpc\}`/);
  assert.match(source, /method: "POST"/);
  assert.match(source, /apikey: apiKey/);
  assert.match(source, /authorization: `Bearer \$\{apiKey\}`/);
  assert.match(source, /p_secret: secret/);
  assert.match(source, /MAX_RPC_REQUEST_BYTES/);
  assert.match(source, /MAX_RPC_RESPONSE_BYTES/);
  assert.match(source, /AbortController/);
  assert.doesNotMatch(source, /from "node:child_process"/);
  assert.doesNotMatch(source, /spawn\(/);
  assert.match(source, /mode: 0o600/);
});

test("resume receipt is aggregate-only and atomically replaced", () => {
  assert.match(source, /writeReceipt/);
  assert.match(source, /rename\(temporary, path\)/);
  assert.match(source, /runId: string/);
  assert.match(source, /normalizedRowsSha256: string/);
  assert.match(source, /const receipt = receiptFrom\(plan, runId, "staging"/);
  assert.doesNotMatch(source, /process\.stdout\.write\([^;]*chunk\.rows/iu);
  assert.match(source, /readResumeReceipt/);
  assert.match(source, /priorReceipt\.runId !== runId/);
  assert.match(source, /get_jiaowubao_student_source_ingest_status/);
  assert.match(source, /receiptFromServerStatus/);
  assert.match(source, /network timeout may happen after a database transaction commits/i);
  assert.match(source, /completed staging run cannot be aborted/);
  assert.match(source, /schema version is unsupported/);
});

test("Supabase endpoint and owner-only key parsing are strict", () => {
  assert.equal(parseSupabaseUrl("https://orvsgisjjrzgtxuwwsms.supabase.co/"), "https://orvsgisjjrzgtxuwwsms.supabase.co");
  assert.throws(() => parseSupabaseUrl("http://orvsgisjjrzgtxuwwsms.supabase.co"), /must be https/);
  assert.throws(() => parseSupabaseUrl("https://example.supabase.co"), /must be https/);
  assert.equal(parseSupabaseApiKey("sb_publishable_test-key"), "sb_publishable_test-key");
  assert.throws(() => parseSupabaseApiKey("service_role"), /publishable or anon/);
  assert.throws(() => parseSupabaseApiKey("sb_secret_test-key"), /publishable or anon/);
});

test("Supabase key source accepts an existing environment variable, exclusively", () => {
  const common = [
    "--input", "/tmp/input.json",
    "--manifest", "/tmp/manifest.json",
    "--supabase-url", "https://orvsgisjjrzgtxuwwsms.supabase.co",
    "--resume", "/tmp/resume.json",
    "--source-id", "source",
    "--revision", `sha256:${"a".repeat(64)}`,
    "--actor", "Nixon",
  ];
  const parsed = parseArguments([...common, "--supabase-key-env", "SUPABASE_PUBLISHABLE_KEY"]);
  assert.equal(parsed.supabaseKeyEnv, "SUPABASE_PUBLISHABLE_KEY");
  assert.equal(parsed.supabaseKeyFile, undefined);
  assert.throws(() => parseArguments([...common, "--supabase-key-file", "/tmp/key", "--supabase-key-env", "SUPABASE_PUBLISHABLE_KEY"]), /exactly one/);
  assert.throws(() => parseArguments([...common, "--supabase-key-env", "bad-name"]), /uppercase environment variable name/);
});

test("environment key lookup validates without exposing the key", () => {
  const key = readSupabaseApiKeyFromEnvironment("SUPABASE_PUBLISHABLE_KEY", {
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test-key",
  });
  assert.equal(key, "sb_publishable_test-key");
  assert.throws(() => readSupabaseApiKeyFromEnvironment("SUPABASE_PUBLISHABLE_KEY", {}), /not set/);
  assert.throws(() => readSupabaseApiKeyFromEnvironment("BAD-NAME", { "BAD-NAME": "sb_publishable_test-key" }), /invalid/);
});

test("candidate manifest hash binds parsed semantics, not JSON whitespace or key order", () => {
  const compact = Buffer.from(JSON.stringify({
    students: [], contracts: [], courseBalances: [], negativeAdjustmentPolicy: "aggregate-only",
  }));
  const reformatted = Buffer.from(JSON.stringify({
    negativeAdjustmentPolicy: "aggregate-only", courseBalances: [], contracts: [], students: [],
  }, null, 2));
  assert.equal(candidateManifestSha256(compact), candidateManifestSha256(reformatted));
});

test("Supabase RPC sends only bounded JSON aggregate calls", async () => {
  const originalFetch = globalThis.fetch;
  let received;
  globalThis.fetch = async (input, init) => {
    received = { input: String(input), init };
    return new Response(JSON.stringify({ state: "staging", runId: "safe" }), { status: 200 });
  };
  try {
    const result = await callSupabaseRpc(
      "https://orvsgisjjrzgtxuwwsms.supabase.co",
      "sb_publishable_test-key",
      "operator-secret",
      "begin_jiaowubao_student_source_ingest",
      { p_envelope: { expectedRowCount: 1 }, p_actor: "Nixon" },
      "begin",
    );
    assert.deepEqual(result, { state: "staging", runId: "safe" });
    assert.equal(received.input, "https://orvsgisjjrzgtxuwwsms.supabase.co/rest/v1/rpc/begin_jiaowubao_student_source_ingest");
    const body = JSON.parse(received.init.body);
    assert.equal(body.p_secret, "operator-secret");
    assert.equal(received.init.headers.apikey, "sb_publishable_test-key");
    assert.equal(received.init.headers.authorization, "Bearer sb_publishable_test-key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
