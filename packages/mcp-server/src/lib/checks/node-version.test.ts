import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeVersionCheck } from './node-version.js';

const originalNode = process.versions.node;

function setNodeVersion(v: string): void {
  // process.versions is a frozen-ish object; redefine via Object.defineProperty
  // so the spy survives strict-mode and we can restore it cleanly in afterEach.
  Object.defineProperty(process.versions, 'node', {
    value: v,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  setNodeVersion(originalNode);
});

afterEach(() => {
  setNodeVersion(originalNode);
});

describe('nodeVersionCheck', () => {
  it('has the correct id, description, and online flag', () => {
    expect(nodeVersionCheck.id).toBe('node-version');
    expect(nodeVersionCheck.description).toBe('Node.js >= 22.12');
    expect(nodeVersionCheck.online).toBe(false);
  });

  it('returns ok when running >=22.12.0 (exact match)', async () => {
    setNodeVersion('22.12.0');
    const r = await nodeVersionCheck.run(null);
    expect(r.status).toBe('ok');
    expect(r.details).toEqual({ running: '22.12.0', required: '>=22.12.0' });
  });

  it('returns ok for higher minor (22.13.0)', async () => {
    setNodeVersion('22.13.5');
    const r = await nodeVersionCheck.run(null);
    expect(r.status).toBe('ok');
  });

  it('returns ok for higher major (24.0.0)', async () => {
    setNodeVersion('24.0.0');
    const r = await nodeVersionCheck.run(null);
    expect(r.status).toBe('ok');
  });

  it('returns fail for lower minor (22.11.0)', async () => {
    setNodeVersion('22.11.0');
    const r = await nodeVersionCheck.run(null);
    expect(r.status).toBe('fail');
    expect(r.message).toContain('22.11.0');
    expect(r.message).toContain('>=22.12.0');
  });

  it('returns fail for lower major (20.19.0)', async () => {
    setNodeVersion('20.19.0');
    const r = await nodeVersionCheck.run(null);
    expect(r.status).toBe('fail');
  });

  it('returns fail for an unparseable version string', async () => {
    setNodeVersion('not-a-version');
    const r = await nodeVersionCheck.run(null);
    expect(r.status).toBe('fail');
    expect(r.message).toContain('Could not parse');
  });
});
