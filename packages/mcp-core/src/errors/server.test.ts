import { describe, expect, it } from 'vitest';
import {
  BulkheadFullError,
  CircuitOpenError,
  DiscordServerErrorImpl,
  ExternalServiceError,
  InternalError,
} from './server.js';

describe('DiscordServerErrorImpl', () => {
  it('captures HTTP status + route, retriable=true', () => {
    const e = new DiscordServerErrorImpl(503, 'POST /channels/X/messages');
    expect(e.code).toBe('DISCORD_SERVER_ERROR');
    expect(e.category).toBe('server');
    expect(e.retriable).toBe(true);
    expect(e.status).toBe(503);
    expect(e.route).toBe('POST /channels/X/messages');
    expect(e.recoveryHint).toMatch(/Auto-retry/);
  });
});

describe('InternalError', () => {
  it('is server-category, retriable, has generic hint', () => {
    const e = new InternalError('unexpected');
    expect(e.code).toBe('INTERNAL_ERROR');
    expect(e.category).toBe('server');
    expect(e.retriable).toBe(true);
    expect(e.recoveryHint).toMatch(/audit log/);
  });
});

describe('ExternalServiceError', () => {
  it('keeps provider failures distinct from Discord failures', () => {
    const e = new ExternalServiceError('Emoji.gg', 503);
    expect(e.code).toBe('EXTERNAL_SERVICE_UNAVAILABLE');
    expect(e.category).toBe('server');
    expect(e.retriable).toBe(true);
    expect(e.provider).toBe('Emoji.gg');
    expect(e.status).toBe(503);
  });
});

describe('CircuitOpenError (Plan 8 D.4)', () => {
  it('carries retryAfterMs + retriable=true with wait-Nms hint', () => {
    const e = new CircuitOpenError(45000);
    expect(e.code).toBe('CIRCUIT_OPEN');
    expect(e.category).toBe('server');
    expect(e.retriable).toBe(true);
    expect(e.retryAfterMs).toBe(45000);
    expect(e.recoveryHint).toBe('wait 45000ms');
  });
});

describe('BulkheadFullError (Plan 8 D.4)', () => {
  it('is server-category, retriable, with concurrency hint', () => {
    const e = new BulkheadFullError();
    expect(e.code).toBe('BULKHEAD_FULL');
    expect(e.category).toBe('server');
    expect(e.retriable).toBe(true);
    expect(e.recoveryHint).toMatch(/concurrency limit exceeded/);
  });
});
