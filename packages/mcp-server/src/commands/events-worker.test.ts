import { mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { acquireWorkerLock } from './events-worker.js';

it('keeps the singleton lease even if the PID file disappears', () => {
  const directory = mkdtempSync(join(tmpdir(), 'discord-events-lease-'));
  const release = acquireWorkerLock(directory);
  try {
    unlinkSync(join(directory, 'worker.pid'));
    expect(() => acquireWorkerLock(directory)).toThrow('already owns');
  } finally {
    release();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('allows only one listener/worker across connections and releases the lock for restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'discord-events-lock-'));
  try {
    const release = acquireWorkerLock(directory);
    expect(readFileSync(join(directory, 'worker.pid'), 'utf8')).toBe(String(process.pid));
    expect(() => acquireWorkerLock(directory)).toThrow('already owns');
    release();
    const next = acquireWorkerLock(directory);
    next();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
