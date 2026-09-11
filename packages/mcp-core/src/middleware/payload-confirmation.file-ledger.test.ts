import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FilePayloadApprovalLedger, type PayloadApprovalBinding } from './payload-confirmation.js';

const SECRET = 'approval-ledger-test-secret-01234567890123456789';
const BINDING: PayloadApprovalBinding = {
  tool: 'components_v2_send',
  payloadHash: 'a'.repeat(64),
  target: JSON.stringify({ channel_id: '123' }),
  botId: '456',
};

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function make(now: () => number = () => 10_000, options: { maxRecords?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'discord-mcp-approval-'));
  directories.push(directory);
  return {
    directory,
    ledger: new FilePayloadApprovalLedger({
      directory,
      secret: SECRET,
      now,
      ttlMs: 100,
      ...options,
    }),
  };
}

describe('FilePayloadApprovalLedger', () => {
  it('returns missing for an unknown approval without granting or consuming another approval', () => {
    const { ledger } = make();
    const approval = ledger.issue(BINDING);
    expect(ledger.consume('unknown-approval', BINDING)).toBe('missing');
    expect(ledger.consume(approval.approvalId, BINDING)).toBe('ok');
  });

  it.each([
    null,
    { id: 'bad' },
    { id: 'a'.repeat(64), state: 'unknown', expiresAt: 10_100, binding: BINDING },
    { id: 'a'.repeat(64), state: 'pending', expiresAt: 'invalid', binding: BINDING },
    { id: 'a'.repeat(64), state: 'pending', expiresAt: 10_100, binding: null },
    {
      id: 'a'.repeat(64),
      state: 'pending',
      expiresAt: 10_100,
      binding: { ...BINDING, botId: 123 },
    },
  ])('rejects malformed records even when their envelope is authenticated', (record) => {
    const { ledger, directory } = make();
    const state = { version: 1, records: [record] };
    const mac = createHmac('sha256', SECRET).update(JSON.stringify(state)).digest('hex');
    writeFileSync(join(directory, 'approvals.json'), JSON.stringify({ ...state, mac }));
    expect(() => ledger.issue(BINDING)).toThrow(
      expect.objectContaining({
        message: 'Approval ledger operation failed closed',
        cause: expect.objectContaining({ message: 'Approval ledger record is invalid' }),
      }),
    );
  });

  it.each([
    null,
    { version: 2, records: [], mac: '' },
    { version: 1, records: {} },
  ])('rejects malformed persisted envelopes', (state) => {
    const { ledger, directory } = make();
    writeFileSync(join(directory, 'approvals.json'), JSON.stringify(state));
    expect(() => ledger.issue(BINDING)).toThrow(
      expect.objectContaining({
        message: 'Approval ledger operation failed closed',
        cause: expect.objectContaining({ message: 'Approval ledger state is invalid' }),
      }),
    );
  });

  it('rejects a state directory that resolves to an existing file', () => {
    const { directory } = make();
    const file = join(directory, 'not-a-directory');
    writeFileSync(file, 'existing data');
    expect(() => new FilePayloadApprovalLedger({ directory: file, secret: SECRET })).toThrow(
      /store is unavailable/,
    );
    expect(readFileSync(file, 'utf8')).toBe('existing data');
  });

  it('shares an approval across instances and survives restart without persisting the token', () => {
    const first = make();
    const approval = first.ledger.issue(BINDING);
    const second = new FilePayloadApprovalLedger({
      directory: first.directory,
      secret: SECRET,
      now: () => 10_000,
      ttlMs: 100,
    });
    expect(second.consume(approval.approvalId, BINDING)).toBe('ok');
    const restarted = new FilePayloadApprovalLedger({
      directory: first.directory,
      secret: SECRET,
      now: () => 10_000,
      ttlMs: 100,
    });
    expect(restarted.consume(approval.approvalId, BINDING)).toBe('replayed');
    expect(readFileSync(join(first.directory, 'approvals.json'), 'utf8')).not.toContain(
      approval.approvalId,
    );
  });

  it('atomically allows only one of two instances to consume', () => {
    const first = make();
    const second = new FilePayloadApprovalLedger({
      directory: first.directory,
      secret: SECRET,
      now: () => 10_000,
      ttlMs: 100,
    });
    const approval = first.ledger.issue(BINDING);
    const results = [
      first.ledger.consume(approval.approvalId, BINDING),
      second.consume(approval.approvalId, BINDING),
    ];
    expect(results.sort()).toEqual(['ok', 'replayed']);
  });

  it('keeps mismatch and expiry fail-closed', () => {
    let now = 10_000;
    const { ledger } = make(() => now);
    const approval = ledger.issue(BINDING);
    expect(ledger.consume(approval.approvalId, { ...BINDING, botId: '789' })).toBe('mismatch');
    now = 10_101;
    expect(ledger.consume(approval.approvalId, BINDING)).toBe('expired');
    expect(ledger.consume(approval.approvalId, BINDING)).toBe('expired');
  });

  it('rejects tampered state and bounds records', () => {
    const { directory, ledger } = make(() => 10_000, { maxRecords: 2 });
    ledger.issue(BINDING);
    ledger.issue({ ...BINDING, tool: 'components_v2_edit' });
    ledger.issue({ ...BINDING, tool: 'components_v2_send_from_template' });
    const path = join(directory, 'approvals.json');
    const state = JSON.parse(readFileSync(path, 'utf8')) as { records: unknown[] };
    expect(state.records).toHaveLength(2);
    writeFileSync(path, JSON.stringify({ ...state, mac: '0'.repeat(64) }));
    expect(() => ledger.issue(BINDING)).toThrow(/failed closed|integrity/i);
  });

  it('requires a strong secret and fails closed for an unavailable store', () => {
    expect(() => new FilePayloadApprovalLedger({ directory: '   ', secret: SECRET })).toThrow(
      /directory is required/i,
    );
    expect(
      () => new FilePayloadApprovalLedger({ directory: join(tmpdir(), 'x'), secret: 'short' }),
    ).toThrow(/32 bytes/);
    expect(
      () =>
        new FilePayloadApprovalLedger({
          directory: join(tmpdir(), 'x'),
          secret: SECRET,
          now: () => 0,
        }),
    ).not.toThrow();
  });

  it('accepts byte secrets and bounds invalid constructor options', () => {
    const directory = mkdtempSync(join(tmpdir(), 'discord-mcp-approval-bytes-'));
    directories.push(directory);
    const ledger = new FilePayloadApprovalLedger({
      directory,
      secret: Buffer.from(SECRET, 'utf8'),
      ttlMs: 0,
      maxRecords: 0,
      now: () => 10_000,
    });
    expect(ledger.issue(BINDING).expiresAt).toBeGreaterThan(10_000);
  });

  it('fails closed when the persisted state is not JSON', () => {
    const { directory, ledger } = make();
    writeFileSync(join(directory, 'approvals.json'), '{not-json');
    expect(() => ledger.issue(BINDING)).toThrow(/state is unreadable|failed closed/i);
  });

  it('does not remove another process lock when the store is busy', () => {
    const { directory, ledger } = make();
    const lockPath = join(directory, 'approvals.lock');
    writeFileSync(lockPath, 'held', { flag: 'wx' });
    expect(() => ledger.issue(BINDING)).toThrow(/failed closed|unavailable/i);
    expect(existsSync(lockPath)).toBe(true);
    unlinkSync(lockPath);
  });
});
