import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, closeSync, fstatSync, mkdtempSync, openSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { connect } from "node:net";
import * as reader from "../scripts/ava-calendar-reader.mjs";

function scratch(t) {
  assert.ok(process.env.TMPDIR, "TMPDIR must be the approved scratch directory");
  const directory = mkdtempSync(join(process.env.TMPDIR, "ava-reader-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
const TOKEN = "a".repeat(64); // Synthetic only; never a deployed credential.
const UPSTREAM = "https://app.insiderleadsedu.com/api/ava-calendar/service";
const config = () => ({ upstream: UPSTREAM, token: TOKEN, host: "127.0.0.1", port: 8769 });
const AUTH = `Bearer ${TOKEN}`;
const WINDOW_PATH = "/v1/calendar?start=2026-10-12T00%3A00%3A00.000Z&end=2026-10-19T00%3A00%3A00.000Z";
const dto = () => ({
  events: [{ eventId: "synthetic-event-1", startsAt: "2026-10-12T04:00:00.123456+00:00", endsAt: "2026-10-12T05:00:00.654321Z", teacherId: "synthetic-teacher-1", teacherName: "Synthetic Teacher", students: [{ studentId: "synthetic-student-1", studentName: "Synthetic Student", owner: "Synthetic Coordinator", ownerId: "synthetic-owner-1", color: "owner-1" }], trial: false, identityPending: false }],
  teachers: [{ id: "synthetic-teacher-1", name: "Synthetic Teacher" }],
  source: { revision: `sha256:${"b".repeat(64)}`, publishedAt: "2026-10-12T00:00:00.123456Z", freshness: "fresh", coverage: "complete" },
  availability: { readOnly: true, windows: [{ startsAt: "2026-10-12T06:00:00.000001Z", endsAt: "2026-10-12T07:00:00.000002Z" }] },
});

async function listen(t, server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  assert.equal(server.address().address, "127.0.0.1");
  return server;
}

function request(server, path = WINDOW_PATH, options = {}) {
  return new Promise((resolve, reject) => {
    const headers = Array.isArray(options.headers) ? [...options.headers, "Host", `127.0.0.1:${server.address().port}`] : options.headers;
    const req = httpRequest({ host: "127.0.0.1", port: server.address().port, path, method: "GET", headers: { Authorization: AUTH }, agent: false, ...options, ...(headers ? { headers } : {}) }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(2000, () => req.destroy(new Error("synthetic test request timed out")));
    req.end();
  });
}

async function waitUntil(predicate, milliseconds = 500) {
  const deadline = performance.now() + milliseconds;
  while (!predicate() && performance.now() < deadline) await delay(5);
  assert.ok(predicate(), "synthetic condition did not settle within its bound");
}

function privateResponse(response) {
  assert.equal(response.headers["cache-control"], "private, no-store, max-age=0");
  assert.equal(response.headers.vary, "Authorization");
  assert.equal(response.headers["access-control-allow-origin"], undefined);
  assert.equal(response.headers["set-cookie"], undefined);
}

async function harness(t, upstreamHandler, options = {}) {
  assert.equal(typeof reader.createReaderHandler, "function");
  const upstream = await listen(t, createServer(upstreamHandler));
  const observed = [];
  const fetchImpl = (url, init) => {
    observed.push({ url: String(url), init });
    const target = new URL(String(url));
    // Only this test adapter changes the transport, never runtime configuration.
    return fetch(`http://127.0.0.1:${upstream.address().port}${target.pathname}${target.search}`, init);
  };
  const server = await listen(t, reader.createReaderServer(config(), { fetchImpl, ...options }));
  return { server, upstream, observed };
}

test("authorized loopback requests preserve the full live DTO byte-for-byte", async (t) => {
  const body = `${JSON.stringify(dto(), null, 2)}\n`;
  let calls = 0;
  const { server, observed } = await harness(t, (req, res) => {
    calls++;
    assert.equal(req.url, WINDOW_PATH.replace("/v1/calendar", "/api/ava-calendar/service"));
    assert.equal(req.headers.authorization, AUTH);
    assert.equal(req.headers.cookie, undefined);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Set-Cookie": "synthetic=secret", "Cache-Control": "public, max-age=999" });
    res.end(body);
  });
  const response = await request(server, WINDOW_PATH, { headers: { Authorization: AUTH, Cookie: "synthetic-client=private" } });
  assert.equal(response.status, 200);
  assert.equal(response.body, body);
  privateResponse(response);
  assert.equal(calls, 1);
  assert.equal(observed[0].url, UPSTREAM + WINDOW_PATH.slice(WINDOW_PATH.indexOf("?")));
  assert.equal(observed[0].init.redirect, "manual");
  assert.equal(observed[0].init.cache, "no-store");
  assert.equal(observed[0].init.method, "GET");
});

test("Bearer authorization rejects missing wrong malformed or duplicate headers before upstream", async (t) => {
  const { server, observed } = await harness(t, (_req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(dto())); });
  const headers = [{}, { Authorization: "" }, { Authorization: `Bearer ${"c".repeat(64)}` }, { Authorization: `bearer ${TOKEN}` }, { Authorization: `Bearer  ${TOKEN}` }, { Authorization: TOKEN }, { Authorization: `${AUTH}, ${AUTH}` }, ["Authorization", AUTH, "authorization", AUTH], ["Authorization", AUTH, "Authorization", `Bearer ${"c".repeat(64)}`]];
  for (const value of headers) {
    const response = await request(server, WINDOW_PATH, { headers: value });
    assert.equal(response.status, 401);
    assert.deepEqual(JSON.parse(response.body), { error: "unauthorized" });
    privateResponse(response);
    assert.doesNotMatch(response.body, new RegExp(TOKEN));
  }
  assert.equal(observed.length, 0);
});

test("read-only routing rejects other methods and nonliteral paths without a cloud request", async (t) => {
  const { server, observed } = await harness(t, (_req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(dto())); });
  for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"]) {
    const response = await request(server, WINDOW_PATH, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.allow, "GET");
    privateResponse(response);
  }
  for (const path of ["/", "/v1/calendar/", "/api/ava-calendar/service", "/%76%31/calendar", "/other/../v1/calendar", "//example.test/v1/calendar", `http://example.test${WINDOW_PATH}`, "/v1/calendar#secret"]) {
    const response = await request(server, path);
    assert.equal(response.status, 404);
    privateResponse(response);
  }
  assert.equal(observed.length, 0);
});

test("query validation refuses extra duplicate missing empty oversized or credential parameters", async (t) => {
  const { server, observed } = await harness(t, (_req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(dto())); });
  for (const path of ["/v1/calendar", "/v1/calendar?start=x", "/v1/calendar?end=x", "/v1/calendar?start=&end=x", "/v1/calendar?start=x&end=", "/v1/calendar?start=x&start=y&end=z", "/v1/calendar?start=x&%73tart=y&end=z", "/v1/calendar?start=x&end=y&end=z", `${WINDOW_PATH}&teacher=any`, `${WINDOW_PATH}&upstream=http://127.0.0.1`, `${WINDOW_PATH}&token=${TOKEN}`, `/v1/calendar?start=${TOKEN}&end=x`, `/v1/calendar?start=x&end=${TOKEN}`, `/v1/calendar?start=${"%61".repeat(64)}&end=x`, `/v1/calendar?start=${"x".repeat(65)}&end=y`, `/v1/calendar?start=x&end=${"y".repeat(65)}`, `/v1/calendar?${"x".repeat(1025)}`]) {
    const response = await request(server, path);
    assert.equal(response.status, 400);
    privateResponse(response);
    assert.deepEqual(JSON.parse(response.body), { error: "invalid_window" });
  }
  for (const headers of [{ Authorization: AUTH, "Content-Length": "1" }, { Authorization: AUTH, "Transfer-Encoding": "chunked" }]) {
    const response = await request(server, WINDOW_PATH, { headers });
    assert.equal(response.status, 400);
    privateResponse(response);
  }
  assert.equal(observed.length, 0);
});

function upstreamFailureStatus(response, value) {
  assert.equal(response.status, value === 400 ? 400 : value === 409 ? 409 : 502);
}

function upstreamFailureBody(response, value) {
  assert.deepEqual(JSON.parse(response.body), { error: value === 400 ? "invalid_window" : value === 409 ? "source_changed" : "source_unavailable" });
}

test("upstream failure statuses and redirects fail closed without leaking the source body", async (t) => {
  let status = 400;
  let redirected = 0;
  const { server, observed } = await harness(t, (req, res) => {
    if (req.url.startsWith("/escape")) redirected++;
    res.writeHead(status, { "Content-Type": "application/json", Location: "/escape", "X-Private-Error": TOKEN });
    res.end(JSON.stringify({ error: `private-provider-error ${TOKEN} Synthetic Student`, stack: "private stack" }));
  });
  for (const value of [400, 401, 403, 409, 429, 500, 502, 503, 202, 206, 301, 302, 303, 307, 308]) {
    status = value;
    const response = await request(server);
    upstreamFailureStatus(response, value);
    upstreamFailureBody(response, value);
    privateResponse(response);
    assert.equal(response.headers.location, undefined);
    assert.equal(response.headers["x-private-error"], undefined);
  }
  assert.equal(observed.length, 15);
  assert.equal(redirected, 0);
});

test("upstream transport exceptions are redacted instead of becoming an unhandled error", async (t) => {
  const { server } = await harness(t, (_req, res) => res.end(), { fetchImpl: async () => { throw new Error(`secret ${TOKEN} Synthetic Student stack`); } });
  const response = await request(server);
  assert.equal(response.status, 502);
  assert.deepEqual(JSON.parse(response.body), { error: "source_unavailable" });
  privateResponse(response);
});

test("strict date-window validation remains authoritative at the fixed upstream", async (t) => {
  let query;
  const { server } = await harness(t, (req, res) => {
    query = new URL(req.url, "http://127.0.0.1").searchParams;
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end(`private upstream invalid date ${TOKEN}`);
  });
  const response = await request(server, "/v1/calendar?start=not-a-date&end=also-invalid");
  assert.equal(response.status, 400);
  assert.deepEqual([...query], [["start", "not-a-date"], ["end", "also-invalid"]]);
  assert.deepEqual(JSON.parse(response.body), { error: "invalid_window" });
  privateResponse(response);
});

function addMissingEventFields(variants) {
  for (const field of Object.keys(dto().events[0])) {
    const value = dto();
    delete value.events[0][field];
    variants.push(value);
  }
}

function addMissingStudentFields(variants) {
  for (const field of Object.keys(dto().events[0].students[0])) {
    const value = dto();
    delete value.events[0].students[0][field];
    variants.push(value);
  }
}

test("HTML malformed JSON and incomplete or inconsistent calendar DTOs never become empty success", async (t) => {
  let body;
  let contentType = "application/json";
  const { server } = await harness(t, (_req, res) => { if (contentType !== null) res.setHeader("Content-Type", contentType); res.end(body); });
  const variants = [null, [], {}, { events: [], teachers: [] }, { ...dto(), events: null }, { ...dto(), teachers: {} }, { ...dto(), source: null }, { ...dto(), source: { ...dto().source, revision: "not-a-receipt" } }, { ...dto(), source: { ...dto().source, publishedAt: "2026-02-30T00:00:00Z" } }, { ...dto(), source: { ...dto().source, freshness: "unknown" } }, { ...dto(), source: { ...dto().source, coverage: "partial" } }];
  addMissingEventFields(variants);
  addMissingStudentFields(variants);
  variants.push({ ...dto(), events: [{ ...dto().events[0], startsAt: "2026-10-12T04:00:00.000002Z", endsAt: "2026-10-12T04:00:00.000001Z" }] });
  variants.push({ ...dto(), events: [{ ...dto().events[0], startsAt: "2026-02-30T04:00:00Z" }] });
  variants.push({ ...dto(), events: [{ ...dto().events[0], trial: "false" }] });
  variants.push({ ...dto(), events: [{ ...dto().events[0], teacherId: "unknown" }] });
  variants.push({ ...dto(), events: [dto().events[0], dto().events[0]] });
  variants.push({ ...dto(), teachers: [{ id: "synthetic-teacher-1" }] });
  variants.push({ ...dto(), teachers: [dto().teachers[0], dto().teachers[0]] });
  for (const value of variants) {
    body = JSON.stringify(value);
    const response = await request(server);
    assert.equal(response.status, 502);
    assert.deepEqual(JSON.parse(response.body), { error: "source_unavailable" });
    privateResponse(response);
  }
  for (const value of ["<html>private provider error</html>", "{", ""]) {
    body = value;
    const response = await request(server);
    assert.equal(response.status, 502);
    privateResponse(response);
  }
  body = JSON.stringify(dto());
  for (const value of ["text/html", "application/jsonish", "text/json", null]) {
    contentType = value;
    assert.equal((await request(server)).status, 502);
  }
  contentType = "application/json";
  body = Buffer.concat([Buffer.from(JSON.stringify(dto()).replace("Synthetic Student", "bad")), Buffer.from([0xff])]);
  assert.equal((await request(server)).status, 502);
});

test("valid empty pending-identity and microsecond calendar data retains all extension fields", async (t) => {
  let value = { ...dto(), events: [], teachers: [] };
  const { server } = await harness(t, (_req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); });
  for (const next of [value, { ...dto(), events: [{ ...dto().events[0], teacherId: null, teacherName: null, students: [], identityPending: true }] }, { ...dto(), events: [{ ...dto().events[0], startsAt: "2026-10-12T04:00:00.000001Z", endsAt: "2026-10-12T04:00:00.000002Z", availability: { synthetic: true } }] }]) {
    value = next;
    const response = await request(server);
    assert.equal(response.status, 200);
    assert.equal(response.body, JSON.stringify(value));
    privateResponse(response);
  }
});

function writeOversizedChunks(res, oversized) {
  for (let index = 0; index < oversized.length; index += 64 * 1024) res.write(oversized.slice(index, index + 64 * 1024));
  res.end();
}

test("the 2 MiB response bound rejects declared chunked and decompressed overflow", async (t) => {
  const limit = 2 * 1024 * 1024;
  const base = { ...dto(), padding: "" };
  const exact = JSON.stringify({ ...base, padding: "p".repeat(limit - Buffer.byteLength(JSON.stringify(base))) });
  const oversized = `${exact} `;
  assert.equal(Buffer.byteLength(exact), limit);
  let mode = "declared";
  const { server } = await harness(t, (_req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (mode === "declared") {
      res.setHeader("Content-Length", limit + 1);
      res.end(oversized);
    } else if (mode === "chunked") {
      writeOversizedChunks(res, oversized);
    } else if (mode === "compressed") {
      res.setHeader("Content-Encoding", "gzip");
      res.end(gzipSync(oversized));
    } else res.end(exact);
  });
  for (const value of ["declared", "chunked", "compressed"]) {
    mode = value;
    const response = await request(server);
    assert.equal(response.status, 502);
    assert.deepEqual(JSON.parse(response.body), { error: "source_unavailable" });
    privateResponse(response);
  }
  mode = "exact";
  const response = await request(server);
  assert.equal(response.status, 200);
  assert.equal(response.body, exact);
  privateResponse(response);
});

test("one total deadline bounds stalled headers and a never-ending response body", async (t) => {
  let mode = "headers";
  const { server, observed } = await harness(t, (_req, res) => {
    if (mode === "body") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"events":[');
    }
  }, { timeoutMs: 100 });
  for (const value of ["headers", "body"]) {
    mode = value;
    const started = performance.now();
    const response = await request(server);
    assert.equal(response.status, 504);
    assert.deepEqual(JSON.parse(response.body), { error: "upstream_timeout" });
    privateResponse(response);
    assert.ok(performance.now() - started < 1000);
    assert.equal(observed.at(-1).init.signal.aborted, true);
  }
});

test("the deadline also terminates an injected fetch promise that ignores cancellation", async (t) => {
  let signal;
  const { server } = await harness(t, (_req, res) => res.end(), { timeoutMs: 50, fetchImpl: (_url, init) => { signal = init.signal; return new Promise(() => {}); } });
  for (let index = 0; index < 2; index++) {
    const response = await request(server);
    assert.equal(response.status, 504);
    assert.equal(signal.aborted, true);
    privateResponse(response);
  }
});

test("factory test hooks cannot increase security limits or accept invalid budgets", () => {
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: 50001 }, { timeoutMs: NaN }, { timeoutMs: "50" }, { maxResponseBytes: 0 }, { maxResponseBytes: 2 * 1024 * 1024 + 1 }, { maxConcurrent: 0 }, { maxConcurrent: 5 }, { maxConcurrent: 1.5 }, { fetchImpl: null }, { unknown: true }]) {
    assert.throws(() => reader.createReaderHandler(config(), options), { message: "invalid_options" });
  }
});

test("four in-flight upstream reads exhaust the cap without queuing a fifth", async (t) => {
  const pending = [];
  const { server, observed } = await harness(t, (_req, res) => {
    res.setHeader("Content-Type", "application/json");
    pending.push(res);
    if (pending.length > 4) res.end(JSON.stringify(dto()));
  }, { timeoutMs: 1000 });
  const initial = Array.from({ length: 4 }, () => {
    const promise = request(server);
    promise.catch(() => {});
    return promise;
  });
  await waitUntil(() => pending.length === 4);
  const busy = await request(server);
  assert.equal(busy.status, 503);
  assert.deepEqual(JSON.parse(busy.body), { error: "busy" });
  privateResponse(busy);
  assert.equal(observed.length, 4);
  for (const res of pending) res.end(JSON.stringify(dto()));
  for (const response of await Promise.all(initial)) {
    assert.equal(response.status, 200);
    privateResponse(response);
  }
  assert.equal((await request(server)).status, 200);
  assert.equal(observed.length, 5);
});

test("a never-settling request returns capacity after the deadline", async (t) => {
  let calls = 0;
  const { server } = await harness(t, (_req, res) => res.end(), { timeoutMs: 100, maxConcurrent: 1, fetchImpl: () => { calls++; return new Promise(() => {}); } });
  const initial = request(server);
  initial.catch(() => {});
  await waitUntil(() => calls === 1);
  const busy = await request(server);
  assert.equal(busy.status, 503);
  assert.equal(calls, 1);
  assert.equal((await initial).status, 504);
  assert.equal((await request(server)).status, 504);
  assert.equal(calls, 2);
});

test("a disconnected local client immediately aborts the pending cloud read and releases capacity", async (t) => {
  const signals = [];
  const { server } = await harness(t, (_req, res) => res.end(), { timeoutMs: 1000, maxConcurrent: 1, fetchImpl: (_url, init) => { signals.push(init.signal); return new Promise(() => {}); } });
  const client = httpRequest({ host: "127.0.0.1", port: server.address().port, path: WINDOW_PATH, headers: { Authorization: AUTH }, agent: false });
  client.on("error", () => {});
  t.after(() => client.destroy());
  client.end();
  await waitUntil(() => signals.length === 1);
  client.destroy();
  await waitUntil(() => signals[0].aborted, 300);
  const next = request(server);
  next.catch(() => {});
  await waitUntil(() => signals.length === 2);
  assert.equal((await next).status, 504);
});

test("health is authenticated process/config status and never claims to verify the cloud calendar", async (t) => {
  const { server, observed } = await harness(t, (_req, res) => res.end());
  const anonymous = await request(server, "/health", { headers: {} });
  assert.equal(anonymous.status, 401);
  privateResponse(anonymous);
  const response = await request(server, "/health");
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { status: "ready", scope: "process", config: "loaded" });
  privateResponse(response);
  const credentialQuery = await request(server, `/health?token=${TOKEN}`);
  assert.equal(credentialQuery.status, 400);
  privateResponse(credentialQuery);
  assert.equal(observed.length, 0);
});

test("server factory stays unbound until the caller explicitly listens", (t) => {
  assert.equal(typeof reader.createReaderServer, "function");
  const server = reader.createReaderServer(config(), { fetchImpl: async () => { assert.fail("factory must not fetch"); } });
  t.after(() => server.close());
  assert.equal(server.listening, false);
  assert.equal(server.address(), null);
  assert.equal(server.maxHeaderSize, 8192);
  assert.equal(server.headersTimeout, 10_000);
  assert.equal(server.requestTimeout, 10_000);
  assert.equal(server.maxConnections, 32);
  assert.equal(server.maxHeadersCount, 0);
});

function child(args, extraEnv = {}) {
  // Deliberately exclude all application/provider credentials from children.
  return spawnSync(process.execPath, args, { encoding: "utf8", timeout: 3000, env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, TZ: "UTC", NODE_ENV: "test", ...extraEnv } });
}

test("CLI fails safely on missing or unsafe synthetic config instead of silently exiting successfully", (t) => {
  const directory = scratch(t);
  const file = join(directory, "synthetic-cli.json");
  const script = fileURLToPath(new URL("../scripts/ava-calendar-reader.mjs", import.meta.url));
  let result = child([script], { ILE_CALENDAR_READER_CONFIG: file });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "calendar reader startup failed\n");
  writeFileSync(file, JSON.stringify({ ...config(), secret: TOKEN }), { mode: 0o600 });
  result = child([script], { ILE_CALENDAR_READER_CONFIG: file });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "calendar reader startup failed\n");
  assert.doesNotMatch(result.stderr, /synthetic|aaaaaaaa|Error:|stack|json/);
});

test("import has no bind fetch or configuration-read side effects", () => {
  const script = new URL("../scripts/ava-calendar-reader.mjs", import.meta.url).href;
  const result = child(["--input-type=module", "-e", `import http from 'node:http'; import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module'; http.Server.prototype.listen = () => { throw new Error('unexpected bind'); }; fs.lstatSync = () => { throw new Error('unexpected config read'); }; syncBuiltinESMExports(); globalThis.fetch = () => { throw new Error('unexpected fetch'); }; await import(${JSON.stringify(script)}); console.log('import-only');`]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "import-only\n");
  assert.equal(result.stderr, "");
});

test("CLI resolves the approved config override then passes only its loopback binding to Node", (t) => {
  const file = join(scratch(t), "synthetic-cli-approved.json");
  writeFileSync(file, JSON.stringify(config()), { mode: 0o600 });
  const script = new URL("../scripts/ava-calendar-reader.mjs", import.meta.url);
  const result = child(["--input-type=module", "-e", `import assert from 'node:assert/strict'; import http from 'node:http'; globalThis.fetch = () => { throw new Error('unexpected cloud access'); }; http.Server.prototype.listen = function(port, host, ready) { assert.equal(port, 8769); assert.equal(host, '127.0.0.1'); console.log('loopback-bind-verified'); ready(); return this; }; process.argv[1] = ${JSON.stringify(fileURLToPath(script))}; await import(${JSON.stringify(script.href)});`], { ILE_CALENDAR_READER_CONFIG: file });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "loopback-bind-verified\ncalendar reader ready\n");
  assert.equal(result.stderr, "");
  assert.equal(reader.DEFAULT_CONFIG_PATH, "/home/codex/.config/insiderleads/ava-calendar-reader.json");
});

function rawRequest(server, message) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = connect({ host: "127.0.0.1", port: server.address().port }, () => socket.write(message));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.setTimeout(2000, () => socket.destroy(new Error("synthetic raw socket timed out")));
  });
}

function privateRawResponse(value, status) {
  assert.match(value, new RegExp(`^HTTP/1.1 ${status} `));
  assert.match(value, /Cache-Control: private, no-store, max-age=0\r\n/i);
  assert.match(value, /Vary: Authorization\r\n/i);
  assert.doesNotMatch(value, /Access-Control-Allow-Origin|Set-Cookie|aaaaaaaa|Synthetic Student/i);
}

test("parser failures carry only redacted private no-store errors", async (t) => {
  const { server, observed } = await harness(t, (_req, res) => res.end());
  for (const headers of ["Broken header\r\n", `X-Wall: ${"x".repeat(9000)}\r\n`, "Content-Length: 1\r\nContent-Length: 2\r\n"]) {
    const response = await rawRequest(server, `GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n${headers}\r\n`);
    privateRawResponse(response, 400);
    assert.equal(response.split("\r\n\r\n")[1], '{"error":"invalid_request"}');
  }
  assert.equal(observed.length, 0);
});

async function deniedProtocolRequests(server, authenticated) {
  const auth = authenticated ? `Authorization: ${AUTH}\r\n` : "";
  const tunnel = await rawRequest(server, `CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\n${auth}\r\n`);
  privateRawResponse(tunnel, authenticated ? 405 : 401);
  const upgrade = await rawRequest(server, `GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${auth}\r\n`);
  privateRawResponse(upgrade, authenticated ? 400 : 401);
}

test("CONNECT and protocol upgrades are explicitly denied without opening a tunnel", async (t) => {
  const { server, observed } = await harness(t, (_req, res) => res.end());
  for (const authenticated of [false, true]) await deniedProtocolRequests(server, authenticated);
  assert.equal(observed.length, 0);
});

test("duplicate Authorization cannot hide after the normal Node header-count truncation", async (t) => {
  const { server, observed } = await harness(t, (_req, res) => res.end());
  const response = await rawRequest(server, `GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nAuthorization: ${AUTH}\r\n${"X:\r\n".repeat(2000)}Authorization: Bearer ${"c".repeat(64)}\r\n\r\n`);
  privateRawResponse(response, 401);
  assert.equal(observed.length, 0);
});

test("Expect headers cannot receive a default unprotected response or bypass authentication", async (t) => {
  const { server, observed } = await harness(t, (_req, res) => res.end());
  const unexpected = await rawRequest(server, `GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nAuthorization: ${AUTH}\r\nExpect: synthetic-unsupported\r\n\r\n`);
  privateRawResponse(unexpected, 400);
  const anonymous = await rawRequest(server, "GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nExpect: 100-continue\r\nContent-Length: 1\r\n\r\n");
  privateRawResponse(anonymous, 401);
  assert.equal(observed.length, 0);
});

test("a stalled body is cancelled even when a fetch adapter ignores the abort signal", async (t) => {
  let cancelled = 0;
  let calls = 0;
  const { server } = await harness(t, (_req, res) => res.end(), {
    timeoutMs: 50, maxConcurrent: 1,
    fetchImpl: async () => {
      calls++;
      if (calls > 1) return Response.json(dto());
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"events":[')); }, cancel() { cancelled++; } }), { headers: { "Content-Type": "application/json" } });
    },
  });
  const timeout = await request(server);
  assert.equal(timeout.status, 504);
  assert.equal(cancelled, 1);
  privateResponse(timeout);
  assert.equal((await request(server)).status, 200);
});

test("each calendar read re-fetches the cloud and never forwards client cache or routing hints", async (t) => {
  let calls = 0;
  const { server, observed } = await harness(t, (req, res) => {
    calls++;
    for (const header of ["cookie", "if-none-match", "if-modified-since", "range", "x-upstream", "forwarded"]) assert.equal(req.headers[header], undefined);
    const value = dto();
    value.events[0].students[0].studentName = `Synthetic revision ${calls}`;
    res.writeHead(200, { "Content-Type": "application/json", ETag: `synthetic-${calls}` });
    res.end(JSON.stringify(value));
  });
  const options = { headers: { Authorization: AUTH, Host: "example.test", "If-None-Match": "synthetic-1", "If-Modified-Since": "Mon, 12 Oct 2026 00:00:00 GMT", Range: "bytes=0-20", "X-Upstream": "http://example.test", Forwarded: "host=example.test", Cookie: "synthetic=private" } };
  const first = await request(server, WINDOW_PATH, options);
  const second = await request(server, WINDOW_PATH, options);
  for (const response of [first, second]) {
    assert.equal(response.status, 200);
    privateResponse(response);
    assert.equal(response.headers.etag, undefined);
  }
  assert.notEqual(first.body, second.body);
  assert.equal(calls, 2);
  assert.equal(observed.length, 2);
  assert.ok(observed.every(({ url }) => url.startsWith(`${UPSTREAM}?`) && !url.includes(TOKEN)));
});

test("mutating a caller's configuration object cannot change the captured service authority", async (t) => {
  const value = config();
  let received;
  const server = await listen(t, reader.createReaderServer(value, { fetchImpl: async (url, init) => { received = { url: String(url), init }; return Response.json(dto()); } }));
  value.token = "c".repeat(64);
  value.upstream = "http://example.test";
  value.host = "0.0.0.0";
  const response = await request(server);
  assert.equal(response.status, 200);
  assert.equal(received.init.headers.Authorization, AUTH);
  assert.ok(received.url.startsWith(`${UPSTREAM}?`));
});

test("a late fetch result after timeout is discarded and its body is cancelled", async (t) => {
  let settle;
  let cancelled = 0;
  const { server } = await harness(t, (_req, res) => res.end(), { timeoutMs: 50, fetchImpl: () => new Promise((resolve) => { settle = resolve; }) });
  const response = await request(server);
  assert.equal(response.status, 504);
  settle(new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { "Content-Type": "application/json" } }));
  await waitUntil(() => cancelled === 1);
  assert.deepEqual(JSON.parse(response.body), { error: "upstream_timeout" });
});

test("calendar payloads stay memory-only with filesystem writes disabled and produce no private logs", (t) => {
  const file = join(scratch(t), "synthetic-memory-config.json");
  writeFileSync(file, JSON.stringify(config()), { mode: 0o600 });
  const moduleUrl = new URL("../scripts/ava-calendar-reader.mjs", import.meta.url).href;
  const code = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import http from 'node:http';
    import { syncBuiltinESMExports } from 'node:module';
    const deny = () => { throw new Error('unexpected filesystem write'); };
    for (const name of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'write', 'writeSync', 'createWriteStream', 'mkdir', 'mkdirSync', 'rename', 'renameSync', 'unlink', 'unlinkSync']) fs[name] = deny;
    for (const name of ['writeFile', 'appendFile', 'mkdir', 'rename', 'unlink']) fs.promises[name] = deny;
    const originalOpen = fs.openSync;
    fs.openSync = (path, flags, ...args) => {
      assert.equal(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC), 0);
      return originalOpen(path, flags, ...args);
    };
    syncBuiltinESMExports();
    globalThis.fetch = () => { throw new Error('unexpected external request'); };
    const { loadConfig, createReaderServer } = await import(${JSON.stringify(moduleUrl)});
    const cfg = loadConfig(${JSON.stringify(file)});
    const payload = ${JSON.stringify(JSON.stringify(dto()))};
    const server = createReaderServer(cfg, { fetchImpl: async () => new Response(payload, { headers: { 'Content-Type': 'application/json' } }) });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      await new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port: server.address().port, path: ${JSON.stringify(WINDOW_PATH)}, agent: false, headers: { Authorization: ${JSON.stringify(AUTH)} } }, (res) => {
          const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('error', reject);
          res.on('end', () => { try { assert.equal(res.statusCode, 200); assert.equal(Buffer.concat(chunks).toString(), payload); resolve(); } catch (error) { reject(error); } });
        });
        req.on('error', reject);
      });
    } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    console.log('memory-only');
  `;
  const result = child(["--input-type=module", "-e", code]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "memory-only\n");
  assert.equal(result.stderr, "");
});

test("configuration rejects changes to authority, credentials, binding or schema", () => {
  const invalid = [null, [], {}, { ...config(), extra: true }, ...["http://app.insiderleadsedu.com/api/ava-calendar/service", `${UPSTREAM}/`, `${UPSTREAM}?token=${TOKEN}`, `${UPSTREAM}#secret`, "https://example.test/api/ava-calendar/service", "https://app.insiderleadsedu.com@127.0.0.1/", "https://app.insiderleadsedu.com/api/../ava-calendar/service"].map((upstream) => ({ ...config(), upstream })), ...["0.0.0.0", "localhost", "::1", "127.0.0.2"].map((host) => ({ ...config(), host })), ...["", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), `${TOKEN}\n`].map((token) => ({ ...config(), token })), ...[0, -1, 65536, 8769.5, "8769", null].map((port) => ({ ...config(), port }))];
  for (const value of invalid) assert.throws(() => reader.validateConfig(value), { message: "invalid_config" });
  for (const field of Object.keys(config())) {
    const value = config();
    delete value[field];
    assert.throws(() => reader.validateConfig(value), { message: "invalid_config" });
  }
  for (const port of [1, 65535]) assert.equal(reader.validateConfig({ ...config(), port }).port, port);
});

test("configuration loads only bounded owner-only regular nonsymlink files", (t) => {
  assert.equal(typeof reader.loadConfig, "function");
  assert.equal(typeof reader.validateConfigFileStat, "function");
  const directory = scratch(t);
  const file = join(directory, "synthetic.json");
  writeFileSync(file, JSON.stringify(config()), { mode: 0o600 });
  assert.deepEqual(reader.loadConfig(file), config());
  chmodSync(file, 0o400);
  assert.deepEqual(reader.loadConfig(file), config());
  for (const mode of [0o640, 0o604, 0o660, 0o644]) {
    chmodSync(file, mode);
    assert.throws(() => reader.loadConfig(file), { message: "invalid_config" });
  }
  chmodSync(file, 0o600);
  const link = join(directory, "symlink.json");
  symlinkSync(file, link);
  for (const path of [link, directory, join(directory, "absent")]) {
    assert.throws(() => reader.loadConfig(path), { message: "invalid_config" });
  }
  const fd = openSync(file, "r");
  try {
    const stat = fstatSync(fd);
    assert.equal(stat.uid, process.getuid());
    assert.doesNotThrow(() => reader.validateConfigFileStat(stat, process.getuid()));
    assert.throws(() => reader.validateConfigFileStat(stat, process.getuid() + 1), { message: "invalid_config" });
  } finally { closeSync(fd); }
  for (const body of ["{", "null", JSON.stringify({ ...config(), privateKey: TOKEN }), " ".repeat(4097)]) {
    writeFileSync(file, body, { mode: 0o600 });
    assert.throws(() => reader.loadConfig(file), { message: "invalid_config" });
  }
});

test("configuration accepts the approved fixed loopback contract", () => {
  assert.equal(typeof reader.validateConfig, "function");
  assert.deepEqual(reader.validateConfig(config()), config());
  assert.ok(Object.isFrozen(reader.validateConfig(config())));
});
