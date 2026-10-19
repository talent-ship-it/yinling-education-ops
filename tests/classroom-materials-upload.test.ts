import assert from "node:assert/strict";
import test from "node:test";
import { createMaterialUploadFolderResolver, materialDropFiles, MaterialUploadResumeStore, materialUploadFingerprint, ResumableMaterialUpload, type MaterialUploadResumeRecord } from "../lib/classroom-materials-upload.ts";

const chunk = 6 * 1024 * 1024;
const session = { endpoint: "https://materials.storage.supabase.co/storage/v1/upload/resumable/sign", bucket: "classroom-materials", objectPath: "synthetic/教材.pdf", token: "synthetic-upload-signature", headers: { apikey: "synthetic-public-key" } };
const location = `${session.endpoint}/synthetic-upload`;
const created = () => new Response(null, { status: 201, headers: { Location: location } });
const uploaded = (offset: number) => new Response(null, { status: 204, headers: { "Upload-Offset": String(offset) } });
const metadata = (contentType = "application/octet-stream", objectPath = session.objectPath) => Object.entries({ bucketName: session.bucket, objectName: objectPath, contentType }).map(([key, value]) => `${key} ${Buffer.from(value).toString("base64")}`).join(",");

test("folder uploads preserve nested paths and reuse shared directories beneath the selected parent", async () => {
  const calls: Array<{ parentId: string | null; name: string }> = [];
  const resolve = createMaterialUploadFolderResolver("selected", async (parentId, name) => {
    calls.push({ parentId, name });
    return `${parentId}/${name}`;
  });
  assert.equal(await resolve({ name: "loose.pdf", webkitRelativePath: "" }), "selected");
  const targets = await Promise.all([
    resolve({ name: "one.pdf", webkitRelativePath: "教材/一级/one.pdf" }),
    resolve({ name: "two.pdf", webkitRelativePath: "教材/一级/two.pdf" }),
    resolve({ name: "three.pdf", webkitRelativePath: "教材/二级/three.pdf" }),
  ]);
  assert.deepEqual(targets, ["selected/教材/一级", "selected/教材/一级", "selected/教材/二级"]);
  assert.deepEqual(calls, [{ parentId: "selected", name: "教材" }, { parentId: "selected/教材", name: "一级" }, { parentId: "selected/教材", name: "二级" }]);
});

test("invalid directory paths and excessive nesting never create or flatten folders", async () => {
  let calls = 0;
  const create = async () => { calls += 1; return "synthetic"; };
  const resolve = createMaterialUploadFolderResolver(null, create);
  for (const path of ["教材/../one.pdf", "/one.pdf", "教材//one.pdf", "教材/ . /one.pdf", "教材\\一级/one.pdf", "教材/wrong.pdf", `${"a/".repeat(33)}one.pdf`]) {
    await assert.rejects(resolve({ name: "one.pdf", webkitRelativePath: path }), /路径无效/);
  }
  const deep = createMaterialUploadFolderResolver("selected", create, 32);
  await assert.rejects(deep({ name: "one.pdf", webkitRelativePath: "教材/one.pdf" }), /路径无效/);
  assert.equal(calls, 0);
});

test("failed folder creation stays visible and a later file can retry that path", async () => {
  let fail = true;
  const resolve = createMaterialUploadFolderResolver(null, async () => {
    if (fail) { fail = false; throw new Error("synthetic directory permission denied"); }
    return "created-folder";
  });
  const file = { name: "one.pdf", webkitRelativePath: "教材/one.pdf" };
  await assert.rejects(resolve(file), /directory permission denied/);
  assert.equal(await resolve(file), "created-folder");
});

test("dragged directories are explicitly rejected while ordinary files remain available", () => {
  const file = new File(["synthetic"], "one.pdf");
  const transfer = (entry: { isDirectory: boolean } | null) => ({ items: [{ kind: "file", webkitGetAsEntry: () => entry }], files: [file] }) as unknown as DataTransfer;
  assert.deepEqual(materialDropFiles(transfer({ isDirectory: false })), [file]);
  assert.throws(() => materialDropFiles(transfer({ isDirectory: true })), /上传文件夹/);
  assert.throws(() => materialDropFiles(transfer(null)), /使用上传按钮/);
});

test("resumable material upload uses signed direct chunks and UTF-8 metadata", async (t) => {
  const file = new Blob([new Uint8Array(chunk + 17)], { type: "application/pdf" });
  const methods: string[] = [];
  let offset = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("x-signature"), session.token);
    assert.equal(headers.get("authorization"), null);
    assert.equal(headers.get("apikey"), session.headers.apikey);
    assert.equal(headers.get("x-upsert"), "false");
    assert.equal(headers.get("Tus-Resumable"), "1.0.0");
    methods.push(init.method || "");
    if (init.method === "POST") {
      assert.equal(url, session.endpoint);
      assert.equal(headers.get("Upload-Length"), String(file.size));
      const metadata = new Map(headers.get("Upload-Metadata")!.split(",").map((pair) => pair.split(" ")));
      assert.equal(Buffer.from(metadata.get("objectName")!, "base64").toString("utf8"), session.objectPath);
      return created();
    }
    assert.equal(url, location);
    assert.equal(headers.get("Upload-Offset"), String(offset));
    const body = init.body as Blob;
    assert.equal(body.size, offset === 0 ? chunk : 17);
    offset += body.size;
    return uploaded(offset);
  });
  const progress: number[] = [];
  await new ResumableMaterialUpload(file, session).run(new AbortController().signal, (bytes) => progress.push(bytes));
  assert.deepEqual(methods, ["POST", "PATCH", "PATCH"]);
  assert.deepEqual(progress, [0, chunk, file.size]);
});

test("retry reconciles the server offset after an uncertain PATCH response", async (t) => {
  const file = new Blob([new Uint8Array(chunk + 12)]);
  let offset = 0;
  let fail = true;
  let creates = 0;
  let heads = 0;
  const offsets: number[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    if (init.method === "POST") { creates += 1; return created(); }
    if (init.method === "HEAD") {
      heads += 1;
      return new Response(null, { headers: { "Upload-Offset": String(offset), "Upload-Length": String(file.size), "Upload-Metadata": metadata("application/pdf") } });
    }
    offsets.push(Number(new Headers(init.headers).get("Upload-Offset")));
    offset += (init.body as Blob).size;
    if (fail) { fail = false; throw new TypeError("synthetic interrupted response"); }
    return uploaded(offset);
  });
  const uploader = new ResumableMaterialUpload(file, session, "application/pdf");
  await assert.rejects(uploader.run(new AbortController().signal, () => {}), /interrupted/);
  uploader.refreshSession({ ...session, token: "synthetic-refreshed-signature" });
  await uploader.run(new AbortController().signal, () => {});
  assert.equal(offset, file.size);
  assert.equal(creates, 1);
  assert.equal(heads, 1);
  assert.deepEqual(offsets, [0, chunk]);
});

test("paused uploads preserve their URL and resume from a partial stored chunk", async (t) => {
  const file = new Blob([new Uint8Array(chunk + 24)]);
  const controller = new AbortController();
  let paused = false;
  let offset = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    if (init.method === "POST") return created();
    if (init.method === "HEAD") return new Response(null, { headers: { "Upload-Offset": String(offset), "Upload-Length": String(file.size), "Upload-Metadata": metadata() } });
    if (!paused) {
      paused = true; offset = 10; controller.abort(); throw new DOMException("synthetic pause", "AbortError");
    }
    assert.equal(Number(new Headers(init.headers).get("Upload-Offset")), offset);
    offset += (init.body as Blob).size;
    return uploaded(offset);
  });
  const uploader = new ResumableMaterialUpload(file, session);
  await assert.rejects(uploader.run(controller.signal, () => {}), { name: "AbortError" });
  const progress: number[] = [];
  await uploader.run(new AbortController().signal, (bytes) => progress.push(bytes));
  assert.deepEqual(progress, [10, chunk + 10, file.size]);
});

test("upload tokens are never sent to a redirected or foreign upload location", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return new Response(null, { status: 201, headers: { Location: "https://untrusted.example/upload" } });
  });
  const uploader = new ResumableMaterialUpload(new Blob(["synthetic"]), session);
  await assert.rejects(uploader.run(new AbortController().signal, () => {}), /无效的上传地址/);
  assert.equal(calls, 1);
  assert.throws(() => uploader.refreshSession({ ...session, objectPath: "different/file.pdf" }), /上传目标已改变/);
  assert.throws(() => new ResumableMaterialUpload(new Blob(), { ...session, endpoint: session.endpoint.replace("https:", "http:") }), /上传地址无效/);
});

test("invalid or unacknowledged upload offsets never report completion", async (t) => {
  const file = new Blob(["synthetic"]);
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    if (init.method === "POST") return created();
    if (init.method === "HEAD") return new Response(null, { headers: { "Upload-Offset": "-1", "Upload-Length": String(file.size) } });
    return uploaded(1);
  });
  const uploader = new ResumableMaterialUpload(file, session);
  const progress: number[] = [];
  await assert.rejects(uploader.run(new AbortController().signal, (bytes) => progress.push(bytes)), /未确认完整分片/);
  await assert.rejects(uploader.run(new AbortController().signal, (bytes) => progress.push(bytes)), /无法确认上传进度/);
  assert.deepEqual(progress, [0]);
});

test("a reselected file restores its target with a fresh signature before uploading", async (t) => {
  const file = new Blob(["synthetic file"]);
  const methods: string[] = [];
  const fresh = { ...session, token: "synthetic-fresh-signature" };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, location);
    assert.equal(new Headers(init.headers).get("x-signature"), fresh.token);
    methods.push(init.method || "");
    if (init.method === "HEAD") return new Response(null, { headers: { "Upload-Offset": "4", "Upload-Length": String(file.size), "Upload-Metadata": metadata() } });
    assert.equal(new Headers(init.headers).get("Upload-Offset"), "4");
    return uploaded(file.size);
  });
  const uploader = new ResumableMaterialUpload(file, fresh);
  uploader.restore({ endpoint: session.endpoint, bucket: session.bucket, objectPath: session.objectPath, location });
  await uploader.run(new AbortController().signal, () => {});
  assert.deepEqual(methods, ["HEAD", "PATCH"]);
});

test("restored material uploads reject a different object even if its length matches", async (t) => {
  const file = new Blob(["synthetic"]);
  t.mock.method(globalThis, "fetch", async () => new Response(null, { headers: { "Upload-Offset": "0", "Upload-Length": String(file.size), "Upload-Metadata": metadata("application/octet-stream", "another/file.pdf") } }));
  const uploader = new ResumableMaterialUpload(file, session);
  uploader.restore({ ...uploader.checkpoint(), endpoint: session.endpoint, bucket: session.bucket, objectPath: session.objectPath, location });
  await assert.rejects(uploader.run(new AbortController().signal, () => {}), /存储记录不匹配/);
});

test("resume storage scopes accounts and never persists a signature or signed resource URL", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const first = new MaterialUploadResumeStore("a".repeat(64), storage);
  const second = new MaterialUploadResumeStore("b".repeat(64), storage);
  const record: MaterialUploadResumeRecord = { fingerprint: "c".repeat(64), requestKey: "12345678-1234-1234-1234-123456789abc", expiresAt: Date.now() + 60_000, upload: { ...session, location: `${location}?token=synthetic-private-token` } };
  first.save({ ...record, token: "synthetic-unexpected-token" } as MaterialUploadResumeRecord);
  assert.equal(second.get(record.fingerprint), undefined);
  assert.equal(first.get(record.fingerprint)?.requestKey, record.requestKey);
  assert.equal(first.get(record.fingerprint)?.upload, undefined);
  assert.equal([...values.values()].join("").includes("token"), false);
  first.save({ ...record, upload: { ...session, location } });
  assert.equal(first.get(record.fingerprint)?.upload?.location, location);
  assert.equal([...values.values()].join("").includes(session.token), false);
  assert.equal([...values.values()].join("").includes(session.headers.apikey), false);
  first.remove(record.fingerprint);
  assert.equal(first.get(record.fingerprint), undefined);
});

test("the resume fingerprint distinguishes folders, metadata, and sampled file content", async () => {
  const first = new File(["synthetic A"], "textbook.pdf", { lastModified: 10 });
  const same = new File(["synthetic A"], "textbook.pdf", { lastModified: 10 });
  const changed = new File(["synthetic B"], "textbook.pdf", { lastModified: 10 });
  assert.equal(await materialUploadFingerprint(first, null), await materialUploadFingerprint(same, null));
  assert.notEqual(await materialUploadFingerprint(first, null), await materialUploadFingerprint(changed, null));
  assert.notEqual(await materialUploadFingerprint(first, null), await materialUploadFingerprint(first, "another-folder"));
});
