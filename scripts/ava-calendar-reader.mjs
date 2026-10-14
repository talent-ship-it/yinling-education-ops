import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const UPSTREAM_URL = "https://app.insiderleadsedu.com/api/ava-calendar/service";
export const DEFAULT_CONFIG_PATH = "/home/codex/.config/insiderleads/ava-calendar-reader.json";

const MAX_CONFIG_BYTES = 4096;

function validConfigFileOwner(stat, uid) {
  return Number.isInteger(uid) && stat.isFile() && stat.uid === uid;
}

function validConfigFileBounds(stat) {
  return (stat.mode & 0o077) === 0 && !(stat.size > MAX_CONFIG_BYTES);
}

export function validateConfigFileStat(stat, uid = process.getuid?.()) {
  if (!validConfigFileOwner(stat, uid) || !validConfigFileBounds(stat)) {
    throw new Error("invalid_config");
  }
}

function validateConfigInode(before, opened) {
  if (before.dev !== opened.dev || before.ino !== opened.ino) throw new Error("invalid_config");
}

function readConfigBytes(fd) {
  const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1);
  let size = 0;
  while (size < bytes.length) {
    const count = readSync(fd, bytes, size, bytes.length - size, null);
    if (count === 0) break;
    size += count;
  }
  validateConfigFileStat(fstatSync(fd));
  if (size > MAX_CONFIG_BYTES) throw new Error("invalid_config");
  return bytes.subarray(0, size);
}

export function loadConfig(path = process.env.ILE_CALENDAR_READER_CONFIG ?? DEFAULT_CONFIG_PATH) {
  let fd;
  try {
    const before = lstatSync(path);
    validateConfigFileStat(before);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    validateConfigFileStat(opened);
    validateConfigInode(before, opened);
    return validateConfig(JSON.parse(readConfigBytes(fd).toString("utf8")));
  } catch {
    throw new Error("invalid_config");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const PRIVATE_HEADERS = Object.freeze({
  "Cache-Control": "private, no-store, max-age=0",
  Vary: "Authorization",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
});

function invalidDeclaredLength(declared, maximum) {
  return declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum);
}

function validateBoundedBody(upstream, maximum) {
  if (invalidDeclaredLength(upstream.headers.get("content-length"), maximum) || !upstream.body) {
    void upstream.body?.cancel().catch(() => {});
    throw new Error("source_unavailable");
  }
}

function appendResponseChunk(chunks, value, size, maximum) {
  size += value.byteLength;
  if (size > maximum) throw new Error("source_unavailable");
  chunks.push(Buffer.from(value));
  return size;
}

async function readBounded(upstream, maximum, signal) {
  validateBoundedBody(upstream, maximum);
  const stream = upstream.body.getReader();
  const cancel = () => { void stream.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks = [];
  let size = 0;
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await stream.read();
      signal.throwIfAborted();
      if (done) break;
      size = appendResponseChunk(chunks, value, size, maximum);
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    stream.releaseLock();
  }
}

function json(response, status, body) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, PRIVATE_HEADERS);
  response.end(JSON.stringify(body));
}

function authorizationHeaderCount(request) {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === "authorization") count++;
  }
  return count;
}

function authorized(request, expected) {
  const value = request.headers.authorization;
  if (authorizationHeaderCount(request) !== 1 || typeof value !== "string") return false;
  const actual = Buffer.from(value, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const READER_LIMITS = Object.freeze({ timeoutMs: 50_000, maxResponseBytes: 2 * 1024 * 1024, maxConcurrent: 4 });

class ReaderError extends Error {
  constructor(status, code) { super(code); this.status = status; }
}

function validateOptionKeys(value) {
  if (!record(value) || Object.keys(value).some((key) => ![...Object.keys(READER_LIMITS), "fetchImpl"].includes(key))) throw new Error("invalid_options");
}

function optionsFor(value) {
  validateOptionKeys(value);
  const options = { ...READER_LIMITS, fetchImpl: globalThis.fetch, ...value };
  if (typeof options.fetchImpl !== "function" || Object.entries(READER_LIMITS).some(([key, maximum]) => !Number.isInteger(options[key]) || options[key] < 1 || options[key] > maximum)) throw new Error("invalid_options");
  return options;
}

function validUpstreamContentType(value) {
  return value?.split(";")[0].trim().toLowerCase() === "application/json";
}

function successfulUpstream(upstream, signal) {
  return !signal.aborted && !upstream.redirected && upstream.status === 200 && validUpstreamContentType(upstream.headers.get("content-type"));
}

function upstreamStatus(status) {
  return status === 400 ? 400 : status === 409 ? 409 : 502;
}

function sourceErrorCode(status) {
  return status === 400 ? "invalid_window" : status === 409 ? "source_changed" : "source_unavailable";
}

function validateUpstream(upstream, signal) {
  if (!successfulUpstream(upstream, signal)) {
    void upstream.body?.cancel().catch(() => {});
    signal.throwIfAborted();
    const status = upstreamStatus(upstream.status);
    throw new ReaderError(status, sourceErrorCode(status));
  }
}

async function fetchCalendar(config, window, options, signal) {
  signal.throwIfAborted();
  const url = new URL(config.upstream);
  url.searchParams.set("start", window.get("start"));
  url.searchParams.set("end", window.get("end"));
  const upstream = await options.fetchImpl(url, {
    method: "GET", redirect: "manual", cache: "no-store", signal,
    headers: { Authorization: `Bearer ${config.token}`, Accept: "application/json" },
  });
  validateUpstream(upstream, signal);
  const bytes = await readBounded(upstream, options.maxResponseBytes, signal);
  signal.throwIfAborted();
  validateCalendar(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  return bytes;
}

function authorizeReaderMethod(request, expected) {
  if (!authorized(request, expected)) return { status: 401, body: { error: "unauthorized" } };
  if (request.method !== "GET") return { status: 405, allow: "GET", body: { error: "method_not_allowed" } };
}

function readerTarget(request) {
  const target = request.url ?? "";
  const path = target.split("?")[0];
  if (!["/v1/calendar", "/health"].includes(path) || target.includes("#")) return { status: 404, body: { error: "not_found" } };
  return { path, target };
}

function hasRequestBody(request) {
  return request.headers["transfer-encoding"] !== undefined
    || request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0";
}

function readerHealth(request, target) {
  if (target !== "/health" || hasRequestBody(request)) return { status: 400, body: { error: "invalid_window" } };
  return { status: 200, body: { status: "ready", scope: "process", config: "loaded" } };
}

function validWindowValue(window, key, token) {
  if (window.getAll(key).length !== 1) return false;
  const value = window.get(key);
  return Boolean(value) && value.length <= 64 && value !== token;
}

function validWindowTarget(target, window, token) {
  return target.length <= 1024 && ![...window.keys()].some((key) => key !== "start" && key !== "end")
    && ["start", "end"].every((key) => validWindowValue(window, key, token));
}

function readerCalendarRequest(request, target, token) {
  const window = new URLSearchParams(target.slice(target.indexOf("?") + 1));
  if (!validWindowTarget(target, window, token) || hasRequestBody(request)) return { status: 400, body: { error: "invalid_window" } };
  return { window };
}

function resolveReaderRequest(request, config, expected) {
  const denial = authorizeReaderMethod(request, expected);
  if (denial) return denial;
  const target = readerTarget(request);
  if ("status" in target) return target;
  if (target.path === "/health") return readerHealth(request, target.target);
  return readerCalendarRequest(request, target.target, config.token);
}

function sendReaderResponse(response, result) {
  if (result.allow) response.setHeader("Allow", result.allow);
  return json(response, result.status, result.body);
}

function beginCalendarRead(request, response, timeoutMs) {
  const controller = new AbortController();
  const timeoutError = new ReaderError(504, "upstream_timeout");
  const started = performance.now();
  const cancelled = new Promise((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
  });
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  const disconnect = () => controller.abort(new ReaderError(499, "client_closed"));
  response.once("close", disconnect);
  request.once("aborted", disconnect);
  if (response.destroyed || request.aborted) disconnect();
  const cleanup = () => {
    clearTimeout(timer);
    response.off("close", disconnect);
    request.off("aborted", disconnect);
    controller.abort();
  };
  return { controller, timeoutError, started, cancelled, cleanup };
}

function sendReaderError(response, error) {
  return json(response, error instanceof ReaderError ? error.status : 502,
    { error: error instanceof ReaderError ? error.message : "source_unavailable" });
}

async function serveCalendar(request, response, config, window, options) {
  const read = beginCalendarRead(request, response, options.timeoutMs);
  try {
    const bytes = await Promise.race([fetchCalendar(config, window, options, read.controller.signal), read.cancelled]);
    if (performance.now() - read.started >= options.timeoutMs) throw read.timeoutError;
    if (response.destroyed) return;
    response.writeHead(200, PRIVATE_HEADERS);
    response.end(bytes);
  } catch (error) {
    return sendReaderError(response, error);
  } finally {
    read.cleanup();
  }
}

export function createReaderHandler(value, hooks = {}) {
  const config = validateConfig(value);
  const options = optionsFor(hooks);
  const expected = Buffer.from(`Bearer ${config.token}`, "utf8");
  let active = 0;
  return async (request, response) => {
    const input = resolveReaderRequest(request, config, expected);
    if ("status" in input) return sendReaderResponse(response, input);
    if (active >= options.maxConcurrent) return json(response, 503, { error: "busy" });
    active++;
    try {
      return await serveCalendar(request, response, config, input.window, options);
    } finally {
      active--;
    }
  };
}

function socketResponseHeaders(status, body) {
  return { ...PRIVATE_HEADERS, Connection: "close", "Content-Length": Buffer.byteLength(body), ...(status === 405 ? { Allow: "GET" } : {}) };
}

function denySocket(socket, status, code) {
  if (socket.destroyed || socket.writableEnded || !socket.writable) return;
  const reason = { 400: "Bad Request", 401: "Unauthorized", 405: "Method Not Allowed" }[status];
  const body = JSON.stringify({ error: code });
  const headers = socketResponseHeaders(status, body);
  socket.end(`HTTP/1.1 ${status} ${reason}\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}\r\n`).join("")}\r\n${body}`);
}

export function createReaderServer(value, hooks = {}) {
  const config = validateConfig(value);
  const handler = createReaderHandler(config, hooks);
  const expected = Buffer.from(`Bearer ${config.token}`, "utf8");
  const server = createServer({ maxHeaderSize: 8192, headersTimeout: 10_000, requestTimeout: 10_000, keepAliveTimeout: 5000 }, handler);
  server.maxConnections = 32;
  server.maxHeadersCount = 0;
  server.on("clientError", (_error, socket) => denySocket(socket, 400, "invalid_request"));
  server.on("connect", (request, socket) => {
    const permitted = authorized(request, expected);
    denySocket(socket, permitted ? 405 : 401, permitted ? "method_not_allowed" : "unauthorized");
  });
  server.on("upgrade", (request, socket) => {
    const permitted = authorized(request, expected);
    denySocket(socket, permitted ? 400 : 401, permitted ? "invalid_request" : "unauthorized");
  });
  server.on("checkContinue", handler);
  server.on("checkExpectation", (request, response) => {
    const permitted = authorized(request, expected);
    json(response, permitted ? 400 : 401, { error: permitted ? "invalid_request" : "unauthorized" });
  });
  return server;
}

function main() {
  try {
    const config = loadConfig();
    const server = createReaderServer(config);
    server.once("error", () => { process.stderr.write("calendar reader startup failed\n"); process.exitCode = 1; });
    server.listen(config.port, config.host, () => process.stdout.write("calendar reader ready\n"));
    const shutdown = () => { server.close(); server.closeAllConnections(); };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  } catch {
    process.stderr.write("calendar reader startup failed\n");
    process.exitCode = 1;
  }
}

function text(value) {
  return typeof value === "string" && value.length <= 240;
}

function id(value) {
  return text(value) && value.length > 0 && value === value.trim();
}

function nullableText(value) {
  return value === null || text(value);
}

function validInstantFormat(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(value);
}

function validCalendarDate(dateOnly) {
  const date = new Date(`${dateOnly}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === dateOnly;
}

function validatedTimestamp(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || !validCalendarDate(value.slice(0, 10))) return null;
  return timestamp;
}

function microsecondInstant(value, timestamp) {
  const fraction = (value.match(/\.(\d{1,6})/)?.[1] ?? "").padEnd(6, "0");
  return BigInt(timestamp) * 1000n + BigInt(fraction.slice(3));
}

function instant(value) {
  if (!validInstantFormat(value)) return null;
  const timestamp = validatedTimestamp(value);
  if (timestamp === null) return null;
  return microsecondInstant(value, timestamp);
}

function validStudentDetails(student) {
  return id(student.studentId) && text(student.studentName);
}

function validStudentOwner(student) {
  return nullableText(student.owner) && nullableText(student.ownerId);
}

function validStudent(student) {
  return record(student) && validStudentDetails(student) && validStudentOwner(student) && id(student.color);
}

function validEventTeacher(event, teachers) {
  return nullableText(event.teacherId) && nullableText(event.teacherName)
    && (event.teacherId === null || teachers.has(event.teacherId));
}

function validEventIdentity(event, teachers) {
  return record(event) && id(event.eventId) && validEventTeacher(event, teachers);
}

function validEventFlags(event) {
  return typeof event.trial === "boolean" && typeof event.identityPending === "boolean";
}

function validEventStudents(event) {
  return Array.isArray(event.students) && event.students.every(validStudent)
    && new Set(event.students.map((student) => student.studentId)).size === event.students.length;
}

function validEventTimes(event) {
  const start = instant(event.startsAt);
  const end = instant(event.endsAt);
  return start !== null && end !== null && end > start;
}

function validEvent(event, teachers) {
  return validEventIdentity(event, teachers) && validEventFlags(event) && validEventStudents(event) && validEventTimes(event);
}

function validCalendarShape(value) {
  return record(value) && Array.isArray(value.events) && Array.isArray(value.teachers) && record(value.source);
}

function validCalendarSourceState(source) {
  return ["fresh", "stale"].includes(source.freshness) && source.coverage === "complete";
}

function validCalendarSource(source) {
  return /^sha256:[a-f0-9]{64}$/.test(source.revision ?? "") && instant(source.publishedAt) !== null && validCalendarSourceState(source);
}

function validCalendarTeacher(teacher) {
  return record(teacher) && id(teacher.id) && id(teacher.name);
}

function calendarTeachers(values) {
  const teachers = new Set();
  for (const teacher of values) {
    if (!validCalendarTeacher(teacher) || teachers.has(teacher.id)) throw new Error("source_unavailable");
    teachers.add(teacher.id);
  }
  return teachers;
}

function validateCalendarEvents(values, teachers) {
  const events = new Set();
  for (const event of values) {
    if (!validEvent(event, teachers) || events.has(event.eventId)) throw new Error("source_unavailable");
    events.add(event.eventId);
  }
}

function validateCalendar(value) {
  if (!validCalendarShape(value) || !validCalendarSource(value.source)) throw new Error("source_unavailable");
  validateCalendarEvents(value.events, calendarTeachers(value.teachers));
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validConfigSchema(value) {
  const fields = ["upstream", "token", "host", "port"];
  return record(value) && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function validConfigBinding(value) {
  return value.upstream === UPSTREAM_URL && value.host === "127.0.0.1";
}

function validConfigToken(value) {
  return typeof value.token === "string" && /^[a-f0-9]{64}$/.test(value.token);
}

function validConfigPort(value) {
  return Number.isInteger(value.port) && value.port >= 1 && value.port <= 65535;
}

function validConfigAuthority(value) {
  return validConfigBinding(value) && validConfigToken(value) && validConfigPort(value);
}

export function validateConfig(value) {
  if (!validConfigSchema(value) || !validConfigAuthority(value)) {
    throw new Error("invalid_config");
  }
  return Object.freeze({ upstream: value.upstream, token: value.token, host: value.host, port: value.port });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
