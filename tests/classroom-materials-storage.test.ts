import assert from "node:assert/strict";
import { test } from "node:test";

import { ClassroomMaterialsError, MATERIALS_PROJECT_REF, verifyMaterialObject } from "../lib/classroom-materials.ts";
import { createMaterialsStorage } from "../lib/classroom-materials-storage.ts";

const configuration = { url: `https://${MATERIALS_PROJECT_REF}.supabase.co`, key: "synthetic-server-secret", publishableKey: "synthetic-public-key" };
const material = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", bucketId: "classroom-materials",
  objectPath: "materials/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/source.pdf", fileName: "lesson.pdf", mimeType: "application/pdf", byteSize: 12,
};

function fixture(responses: unknown[]) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    assert.notEqual(response, undefined, "unexpected provider request");
    return new Response(JSON.stringify(response), { status: 200 });
  }) as typeof fetch;
  return { client: createMaterialsStorage(configuration, fetcher), requests };
}

const bucket = { id: "classroom-materials", public: false };

test("signed TUS creation keeps server credentials out of the browser descriptor", async () => {
  const { client, requests } = fixture([bucket, { url: `/object/upload/sign/classroom-materials/${material.objectPath}?token=upload-only-token` }]);
  const descriptor = await client.uploadDescriptor(material);
  assert.equal(descriptor.endpoint, `https://${MATERIALS_PROJECT_REF}.storage.supabase.co/storage/v1/upload/resumable/sign`);
  assert.deepEqual(descriptor.headers, { apikey: configuration.publishableKey, "x-signature": "upload-only-token", "x-upsert": "false" });
  assert.equal(descriptor.chunkSize, 6291456);
  assert.equal(descriptor.metadata.objectName, material.objectPath);
  assert.equal(JSON.stringify(descriptor).includes(configuration.key), false);
  assert.equal(requests[1].url, `${configuration.url}/storage/v1/object/upload/sign/classroom-materials/${material.objectPath}`);
  assert.equal(requests[1].init.method, "POST");
  assert.equal(requests[1].init.body, "{}");
  assert.equal(new Headers(requests[1].init.headers).get("Authorization"), `Bearer ${configuration.key}`);
  assert.equal(new Headers(requests[1].init.headers).has("x-upsert"), false);
  assert.equal(requests[1].init.cache, "no-store");
});

test("provider object info and download signatures stay on the authorized path", async () => {
  const info = { bucket_id: material.bucketId, name: material.objectPath, size: 12, content_type: "application/pdf" };
  const { client, requests } = fixture([bucket, info, bucket, { signedURL: `/object/sign/classroom-materials/${material.objectPath}?token=read-only-token` }]);
  verifyMaterialObject(await client.objectInfo(material), material);
  const url = new URL(await client.readUrl(material, true));
  assert.equal(url.origin, configuration.url);
  assert.equal(url.searchParams.get("download"), material.fileName);
  assert.equal(requests[3].init.body, '{"expiresIn":300}');
  assert.equal(requests[1].url.endsWith(`/object/info/classroom-materials/${material.objectPath}`), true);
});

test("storage fails closed on public buckets, foreign URLs, invalid paths, and network errors", async () => {
  await assert.rejects(fixture([{ ...bucket, public: true }]).client.uploadDescriptor(material), ClassroomMaterialsError);
  await assert.rejects(fixture([{ ...bucket, file_size_limit: 11 }]).client.uploadDescriptor(material), (error: unknown) => error instanceof ClassroomMaterialsError && error.status === 413);
  await assert.rejects(fixture([bucket, { url: "https://attacker.com/object/upload/sign/a?token=t" }]).client.uploadDescriptor(material), ClassroomMaterialsError);
  await assert.rejects(fixture([bucket, { signedURL: "https://attacker.com/object/sign/a?token=t" }]).client.readUrl(material), ClassroomMaterialsError);
  await assert.rejects(fixture([bucket]).client.objectInfo({ ...material, objectPath: "../other" }), ClassroomMaterialsError);
  await assert.rejects(fixture([bucket]).client.objectInfo({ ...material, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }), ClassroomMaterialsError);
  await assert.rejects(fixture([bucket, { signedURL: "/object/sign/classroom-materials/other.pdf?token=t" }]).client.readUrl(material), ClassroomMaterialsError);
  await assert.rejects(fixture([new Error("synthetic provider failure")]).client.readUrl(material), ClassroomMaterialsError);
  assert.throws(() => createMaterialsStorage({ ...configuration, url: "https://other.supabase.co" }), ClassroomMaterialsError);
});
