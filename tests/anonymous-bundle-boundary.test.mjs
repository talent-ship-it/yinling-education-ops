import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("anonymous login defers the operations workspace bundle until authentication succeeds", async () => {
  const [page, authClient, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/auth-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
  ]);

  assert.match(page, /import AuthClient from "\.\/auth-client"/);
  assert.doesNotMatch(page, /operations-client/);
  assert.match(authClient, /dynamic\(\(\) => import\("\.\/operations-client"\)/);
  assert.match(authClient, /ssr: false/);
  assert.match(authClient, /if \(!session\) return <AuthLoginScreen/);
  assert.match(authClient, /return <OperationsApp initialSession=\{session\} \/>/);
  assert.match(packageJson.scripts.build, /check-client-bundle-budget\.mjs/);
});
