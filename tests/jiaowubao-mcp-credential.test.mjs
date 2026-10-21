import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const helper = fileURLToPath(new URL("../tools/jiaowubao_mcp_credential.py", import.meta.url));
const run = (program) => spawnSync("python3", ["-I", "-B", "-S", "-c", program, helper], {
  encoding: "utf8", timeout: 10000, env: { PATH: process.env.PATH, HOME: process.env.HOME },
});
const prelude = `import importlib.util, io, os, sys, contextlib
spec = importlib.util.spec_from_file_location('credential', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
`;

test("company MCP credential helper is silent by default and never reads another profile's item", () => {
  const result = run(prelude + `
m.read_secret = lambda: (_ for _ in ()).throw(AssertionError('must not read'))
assert m.main([]) == 2
os.environ['HERMES_HOME'] = '/unrelated-profile'
assert m.main(['--emit-env']) == 2
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("company MCP credential helper emits only one validated in-memory value to the requested source", () => {
  const result = run(prelude + `
os.environ['HERMES_HOME'] = m.PROFILE_HOME
m.read_secret = lambda: 'synthetic-company-mcp-token'
out = io.StringIO()
with contextlib.redirect_stdout(out):
    assert m.main(['--emit-env']) == 0
assert out.getvalue() == 'INSIDERLEADS_JWB_MCP_TOKEN=synthetic-company-mcp-token\\n'
out = io.StringIO()
with contextlib.redirect_stdout(out):
    assert m.main(['--check']) == 0
assert out.getvalue() == 'jiaowubao_mcp_credential=available\\n'
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("Keychain denial and malformed credential values do not expose a value or a native error", () => {
  const result = run(prelude + `
os.environ['HERMES_HOME'] = m.PROFILE_HOME
for value in ['', 'token\\nEXTRA=bad', 'token secret', 'token\\r']:
    m.read_secret = lambda: value
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        assert m.main(['--emit-env']) != 0
    assert not out.getvalue()
    assert value not in err.getvalue() if value else True
m.read_secret = lambda: (_ for _ in ()).throw(m.CredentialError('denied'))
out, err = io.StringIO(), io.StringIO()
with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
    assert m.main(['--emit-env']) == 1
assert not out.getvalue()
assert err.getvalue() == 'jiaowubao_mcp_credential=unavailable\\n'
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("credential helper preserves the approved native Keychain source and disables prompts only in its child", () => {
  const result = run(prelude + `
assert m.KEYCHAIN == '/Users/nixon/Library/Keychains/login.keychain-db'
assert m.SERVICE == b'insiderleads.jiaowubao.mcp'
assert m.ACCOUNT == b'insiderlead'
assert m.PROFILE_HOME == '/Users/nixon/.hermes/profiles/insiderleads'
assert sys.flags.isolated and sys.flags.no_site
`);
  assert.equal(result.status, 0, result.stderr);
});
