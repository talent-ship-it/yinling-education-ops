import assert from "node:assert/strict";
import test from "node:test";

import { lpRevisionDocumentUrl } from "../app/lp-workflow-fields.tsx";
import type { LpRevision } from "../lib/lp-workflows.ts";

function revision(documentUrl: unknown): LpRevision {
  return {
    id: "REV-002",
    workflowId: "LP-001",
    number: 2,
    changedAt: "2026-08-12T08:00:00.000Z",
    changedBy: "Nixon",
    before: {},
    after: { documentUrl: documentUrl as never },
  };
}

test("returns a link only for http and https revision documents", () => {
  assert.equal(lpRevisionDocumentUrl(revision("https://docs.qq.com/doc/example")), "https://docs.qq.com/doc/example");
  assert.equal(lpRevisionDocumentUrl(revision("http://example.com/version/2")), "http://example.com/version/2");
  assert.equal(lpRevisionDocumentUrl(revision("javascript:alert(1)")), null);
  assert.equal(lpRevisionDocumentUrl(revision("not a URL")), null);
  assert.equal(lpRevisionDocumentUrl(revision({ url: "https://example.com" })), null);
});
