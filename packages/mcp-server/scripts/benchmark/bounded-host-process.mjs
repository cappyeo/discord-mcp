import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(nodeExecFile);

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Run one host CLI process with bounded output, abort support, and process-tree close proof. */
export async function runBoundedHostProcess({
  launcher,
  args,
  cwd,
  env,
  timeoutMs,
  processDidNotCloseCode,
  maxStdoutBytes = 8 * 1024 * 1024,
  terminationGraceMs = 2_000,
  platform = process.platform,
  spawn = nodeSpawn,
  terminate = null,
  signal: abortSignal,
} = {}) {
  if (!record(launcher) || typeof launcher.command !== 'string')
    throw new TypeError('launcher is required');
  if (!Array.isArray(args) || typeof cwd !== 'string' || !record(env))
    throw new TypeError('host process arguments are invalid');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new TypeError('timeoutMs must be positive');
  if (!Number.isSafeInteger(maxStdoutBytes) || maxStdoutBytes < 1)
    throw new TypeError('maxStdoutBytes must be positive');
  if (!Number.isSafeInteger(terminationGraceMs) || terminationGraceMs < 1)
    throw new TypeError('terminationGraceMs must be positive');
  if (
    typeof processDidNotCloseCode !== 'string' ||
    !/^[A-Z][A-Z0-9_]{0,127}$/u.test(processDidNotCloseCode)
  )
    throw new TypeError('processDidNotCloseCode is invalid');
  if (abortSignal !== undefined && !(abortSignal instanceof AbortSignal))
    throw new TypeError('signal must be an AbortSignal');
  if (abortSignal?.aborted === true)
    return {
      stdout: '',
      exitCode: null,
      signal: null,
      timedOut: false,
      aborted: true,
      spawnError: false,
      truncated: false,
    };

  const invocation = [
    ...(Array.isArray(launcher.prefix_args) ? launcher.prefix_args : []),
    ...args,
  ];
  return new Promise((resolveResult, rejectResult) => {
    const chunks = [];
    let bytes = 0;
    let child;
    let timer;
    let stopPromise;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let spawnError = false;
    let truncated = false;
    let closeResolve;
    const closed = new Promise((resolveClose) => {
      closeResolve = resolveClose;
    });
    const finish = (exitCode, closeSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', onAbort);
      resolveResult({
        stdout: Buffer.concat(chunks).toString('utf8'),
        exitCode,
        signal: closeSignal,
        timedOut,
        aborted,
        spawnError,
        truncated,
      });
    };
    const terminateTree = async (force) => {
      if (!child?.pid) return;
      if (terminate !== null) {
        try {
          await terminate({ child, platform, force });
        } catch {
          // The close proof below remains authoritative.
        }
        return;
      }
      try {
        if (platform === 'win32') {
          await execFile('taskkill', ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])], {
            windowsHide: true,
          });
        } else {
          process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
        }
      } catch {
        // The close proof below remains authoritative.
      }
    };
    const waitForClose = () =>
      Promise.race([
        closed.then(() => true),
        new Promise((resolveClose) => setTimeout(() => resolveClose(false), terminationGraceMs)),
      ]);
    const stop = (kind) => {
      if (stopPromise !== undefined) return stopPromise;
      stopPromise = (async () => {
        if (kind === 'timeout') timedOut = true;
        if (kind === 'abort') aborted = true;
        await terminateTree(false);
        if (await waitForClose()) return;
        await terminateTree(true);
        if (!(await waitForClose()) && !settled) {
          settled = true;
          clearTimeout(timer);
          abortSignal?.removeEventListener('abort', onAbort);
          const error = new Error(processDidNotCloseCode);
          error.code = processDidNotCloseCode;
          rejectResult(error);
        }
      })();
      return stopPromise;
    };
    const onAbort = () => void stop('abort');
    try {
      child = spawn(launcher.command, invocation, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: platform !== 'win32',
        windowsHide: true,
      });
    } catch {
      spawnError = true;
      finish(null, null);
      return;
    }
    child.stdout?.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (bytes >= maxStdoutBytes) {
        truncated = true;
        return;
      }
      const remaining = maxStdoutBytes - bytes;
      const bounded = buffer.byteLength > remaining ? buffer.subarray(0, remaining) : buffer;
      chunks.push(bounded);
      bytes += bounded.byteLength;
      if (bounded.byteLength < buffer.byteLength) truncated = true;
    });
    child.stderr?.on('data', () => {});
    child.once('error', () => {
      spawnError = true;
      if (timedOut || aborted) return;
      if (!child.pid) finish(null, null);
      else void stop('error');
    });
    child.once('close', (code, closeSignal) => {
      closeResolve();
      finish(code, closeSignal);
    });
    timer = setTimeout(() => void stop('timeout'), timeoutMs);
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    if (abortSignal?.aborted === true) onAbort();
  });
}
