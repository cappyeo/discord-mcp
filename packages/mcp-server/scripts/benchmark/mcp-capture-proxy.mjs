#!/usr/bin/env node

import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { sameFileIdentity } from './file-identity.mjs';

export const MCP_CAPTURE_SCHEMA = 'discord-mcp.mcp-private-capture.v1';

const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const MAX_CAPTURE_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_CAPTURE_LINES = 128;
const MAX_STRIPPED_ENV_KEYS = 16;
const ENV_KEY = /^[A-Z][A-Z0-9_]{0,63}$/u;

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function exactKeys(value, keys) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function hasForbiddenKey(value, key, depth = 0) {
  if (depth > 8 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => hasForbiddenKey(item, key, depth + 1));
  if (Object.hasOwn(value, key)) return true;
  return Object.values(value).some((item) => hasForbiddenKey(item, key, depth + 1));
}

function requestKey(id) {
  if (typeof id !== 'string' && typeof id !== 'number') return null;
  return `${typeof id}:${String(id)}`;
}

export function parseMcpCaptureProxyArgs(argv) {
  if (!Array.isArray(argv)) throw new TypeError('proxy arguments must be an array');
  if (argv.length < 4 || argv[0] !== '--capture')
    throw new TypeError('usage: --capture <absolute-path> -- <absolute-command> [args...]');
  const capturePath = argv[1];
  if (typeof capturePath !== 'string' || !isAbsolute(capturePath))
    throw new TypeError('capture path must be absolute');
  const stripEnv = [];
  let index = 2;
  while (argv[index] === '--strip-env') {
    const key = argv[index + 1];
    if (
      typeof key !== 'string' ||
      !ENV_KEY.test(key) ||
      stripEnv.includes(key) ||
      stripEnv.length >= MAX_STRIPPED_ENV_KEYS
    )
      throw new TypeError('environment scrub key is invalid');
    stripEnv.push(key);
    index += 2;
  }
  if (argv[index] !== '--')
    throw new TypeError('usage: --capture <absolute-path> -- <absolute-command> [args...]');
  const command = argv[index + 1];
  if (typeof command !== 'string' || !isAbsolute(command))
    throw new TypeError('child command must be absolute');
  if (
    argv
      .slice(index + 2)
      .some((argument) => typeof argument !== 'string' || /[\r\n]/u.test(argument))
  )
    throw new TypeError('child arguments must be newline-free strings');
  return {
    capturePath: resolve(capturePath),
    stripEnv,
    command: resolve(command),
    args: argv.slice(index + 2),
  };
}

/** Keep host authentication in the host process rather than forwarding it to the MCP child. */
export function buildMcpCaptureChildEnvironment(env, stripEnv = []) {
  if (!record(env) || !Array.isArray(stripEnv) || stripEnv.length > MAX_STRIPPED_ENV_KEYS)
    fail('CHILD_ENV_INVALID');
  const childEnvironment = { ...env };
  const seen = new Set();
  for (const key of stripEnv) {
    if (typeof key !== 'string' || !ENV_KEY.test(key) || seen.has(key)) fail('CHILD_ENV_INVALID');
    seen.add(key);
    delete childEnvironment[key];
  }
  return childEnvironment;
}

/** Remove structured output from the host-visible response after preserving the private capture. */
export function sanitizeCapturedMcpResponse(response) {
  if (!record(response) || !record(response.result)) return response;
  const result = { ...response.result };
  delete result.structuredContent;
  delete result.structured_content;
  return { ...response, result };
}

async function openPrivateCapture(path, platform = process.platform) {
  const initial = lstatSync(path);
  if (initial.isSymbolicLink() || !initial.isFile() || initial.size > MAX_CAPTURE_BYTES)
    fail('CAPTURE_FILE_INVALID');
  const flags =
    fsConstants.O_WRONLY |
    fsConstants.O_APPEND |
    (platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0));
  const handle = await open(path, flags, 0o600);
  const opened = await handle.stat();
  if (!opened.isFile() || !sameFileIdentity(initial, opened)) {
    await handle.close();
    fail('CAPTURE_FILE_CHANGED');
  }
  return handle;
}

async function writeLine(stream, line) {
  if (!stream.write(`${line}\n`, 'utf8')) await once(stream, 'drain');
}

async function appendCapture(handle, capture) {
  const serialized = `${JSON.stringify(capture)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CAPTURE_RECORD_BYTES)
    fail('CAPTURE_RECORD_TOO_LARGE');
  await handle.appendFile(serialized, 'utf8');
  await handle.sync();
}

/** Run the transparent stdio proxy. Captures full tool results before stripping structuredContent. */
export async function runMcpCaptureProxy({
  capturePath,
  command,
  args,
  spawn = nodeSpawn,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  stripEnv = [],
  platform = process.platform,
} = {}) {
  const handle = await openPrivateCapture(capturePath, platform);
  const child = spawn(command, args, {
    env: buildMcpCaptureChildEnvironment(env, stripEnv),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const pending = new Map();
  let ordinal = 0;
  let failed = false;

  child.stderr.on('data', (chunk) => stderr.write(chunk));
  const clientLines = createInterface({ input: stdin, crlfDelay: Number.POSITIVE_INFINITY });
  const serverLines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });

  const clientLoop = (async () => {
    for await (const line of clientLines) {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        fail('CLIENT_JSON_INVALID');
      }
      if (record(message) && message.method === 'tools/call') {
        const key = requestKey(message.id);
        const parameters = message.params;
        if (
          key === null ||
          !record(parameters) ||
          typeof parameters.name !== 'string' ||
          !record(parameters.arguments) ||
          pending.has(key)
        )
          fail('TOOL_REQUEST_INVALID');
        pending.set(key, { tool_name: parameters.name, arguments: parameters.arguments });
      }
      await writeLine(child.stdin, line);
    }
    child.stdin.end();
  })();

  const serverLoop = (async () => {
    for await (const line of serverLines) {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        fail('SERVER_JSON_INVALID');
      }
      const key = record(message) ? requestKey(message.id) : null;
      const request = key === null ? undefined : pending.get(key);
      if (request !== undefined) {
        pending.delete(key);
        if (!record(message.result) || message.error !== undefined) fail('TOOL_RESPONSE_INVALID');
        ordinal += 1;
        await appendCapture(handle, {
          schema_version: MCP_CAPTURE_SCHEMA,
          capture_id: randomUUID(),
          ordinal,
          tool_name: request.tool_name,
          arguments: request.arguments,
          result: message.result,
        });
        message = sanitizeCapturedMcpResponse(message);
      }
      await writeLine(stdout, JSON.stringify(message));
    }
  })();

  const close = once(child, 'close');
  try {
    await Promise.all([clientLoop, serverLoop]);
    const [exitCode, signal] = await close;
    if (pending.size !== 0) fail('TOOL_RESPONSE_MISSING');
    if (signal !== null || exitCode !== 0) fail('MCP_CHILD_FAILED');
    return 0;
  } catch (error) {
    failed = true;
    child.kill('SIGTERM');
    throw error;
  } finally {
    clientLines.close();
    serverLines.close();
    await handle.close();
    if (failed && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

function readCaptureBytes(path, platform = process.platform) {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile() || before.size > MAX_CAPTURE_BYTES)
    fail('CAPTURE_FILE_INVALID');
  const flags = fsConstants.O_RDONLY | (platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0));
  const descriptor = openSync(path, flags);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !sameFileIdentity(before, opened)) fail('CAPTURE_FILE_CHANGED');
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const finalPath = lstatSync(path);
    if (
      bytes.length !== before.size ||
      !sameFileIdentity(opened, after) ||
      finalPath.isSymbolicLink() ||
      !sameFileIdentity(before, finalPath)
    )
      fail('CAPTURE_FILE_CHANGED');
    return bytes.toString('utf8');
  } finally {
    closeSync(descriptor);
  }
}

/** Consume exactly one new, full MCP tool result from a private host state. */
export function consumeCapturedMcpCall(privateState, expectedTool, options = {}) {
  if (!record(privateState) || typeof privateState.capturePath !== 'string')
    fail('CAPTURE_STATE_INVALID');
  if (!Number.isSafeInteger(privateState.captureCursor) || privateState.captureCursor < 0)
    fail('CAPTURE_CURSOR_INVALID');
  if (typeof expectedTool !== 'string' || expectedTool === '') fail('EXPECTED_TOOL_INVALID');
  const text = readCaptureBytes(privateState.capturePath, options.platform ?? process.platform);
  const lines = text === '' ? [] : text.trimEnd().split(/\r?\n/u);
  if (lines.length > MAX_CAPTURE_LINES || privateState.captureCursor > lines.length)
    fail('CAPTURE_CURSOR_INVALID');
  const captures = lines.map((line) => {
    let capture;
    try {
      capture = JSON.parse(line);
    } catch {
      fail('CAPTURE_JSON_INVALID');
    }
    if (
      !record(capture) ||
      !exactKeys(capture, [
        'schema_version',
        'capture_id',
        'ordinal',
        'tool_name',
        'arguments',
        'result',
      ]) ||
      capture.schema_version !== MCP_CAPTURE_SCHEMA ||
      typeof capture.capture_id !== 'string' ||
      !Number.isSafeInteger(capture.ordinal) ||
      capture.ordinal < 1 ||
      typeof capture.tool_name !== 'string' ||
      !record(capture.arguments) ||
      !record(capture.result)
    )
      fail('CAPTURE_RECORD_INVALID');
    return capture;
  });
  const unread = captures.slice(privateState.captureCursor);
  if (unread.length !== 1) fail('CAPTURE_COUNT_INVALID');
  const capture = unread[0];
  if (capture.tool_name !== expectedTool) fail('CAPTURE_TOOL_MISMATCH');
  if (hasForbiddenKey(capture.arguments, 'plan_token')) fail('RAW_PLAN_TOKEN');
  if (!record(capture.result.structuredContent) || capture.result.isError === true)
    fail('CAPTURE_RESULT_INVALID');
  privateState.captureCursor = captures.length;
  return capture;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const parsed = parseMcpCaptureProxyArgs(argv);
    return await runMcpCaptureProxy(parsed);
  } catch {
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}
