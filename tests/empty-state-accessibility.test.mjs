import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const client = await readFile(new URL("../app/operations-client.tsx", import.meta.url), "utf8");

test("shared empty states announce dynamic filter and data changes", () => {
  const start = client.indexOf("function EmptyState(");
  const end = client.indexOf("function AuthStatusScreen(", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const emptyState = client.slice(start, end);

  assert.match(emptyState, /className="collection-empty" role="status" aria-live="polite"/);
  assert.match(emptyState, /aria-hidden="true"/);
});
