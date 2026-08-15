import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { runBoundedHostProcess } from './bounded-host-process.mjs';

function child() {
  const value = new EventEmitter();
  value.pid = 42;
  value.stdout = new PassThrough();
  value.stderr = new PassThrough();
  return value;
}

const request = {
  launcher: { command: process.execPath, prefix_args: ['driver.mjs'] },
  args: ['--version'],
  cwd: process.cwd(),
  env: {},
  timeoutMs: 1_000,
  processDidNotCloseCode: 'HOST_PROCESS_DID_NOT_CLOSE',
};

describe('bounded host process', () => {
  it('captures bounded stdout and reports a normal close', async () => {
    const processChild = child();
    const pending = runBoundedHostProcess({ ...request, spawn: () => processChild });
    processChild.stdout.write('1.2.3\n');
    processChild.emit('close', 0, null);
    await expect(pending).resolves.toEqual({
      stdout: '1.2.3\n',
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      spawnError: false,
      truncated: false,
    });
  });

  it('does not spawn when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const spawn = vi.fn();
    await expect(
      runBoundedHostProcess({ ...request, signal: controller.signal, spawn }),
    ).resolves.toMatchObject({ aborted: true });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('terminates, escalates, and rejects when the process tree never closes', async () => {
    const processChild = child();
    const terminate = vi.fn(async () => {});
    await expect(
      runBoundedHostProcess({
        ...request,
        timeoutMs: 1,
        terminationGraceMs: 1,
        spawn: () => processChild,
        terminate,
      }),
    ).rejects.toMatchObject({ code: 'HOST_PROCESS_DID_NOT_CLOSE' });
    expect(terminate).toHaveBeenCalledTimes(2);
    expect(terminate.mock.calls.map(([call]) => call.force)).toEqual([false, true]);
  });

  it('marks oversized stdout as truncated without retaining excess bytes', async () => {
    const processChild = child();
    const pending = runBoundedHostProcess({
      ...request,
      maxStdoutBytes: 4,
      spawn: () => processChild,
    });
    processChild.stdout.write('abcdef');
    processChild.emit('close', 0, null);
    await expect(pending).resolves.toMatchObject({ stdout: 'abcd', truncated: true });
  });
});
