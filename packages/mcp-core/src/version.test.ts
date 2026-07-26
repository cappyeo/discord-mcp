/**
 * Version coherence.
 *
 * Before this existed the package shipped at 0.12.0 while the public `VERSION`
 * export and the MCP initialize handshake both reported `0.0.0`, and the OTel
 * instrumentation version was a second hand-maintained literal. Nothing failed;
 * the only check was a shape regex (`/^\d+\.\d+\.\d+$/`), which every stale
 * literal satisfies.
 *
 * These assert equality with package.json, so a release bump that misses a
 * derived site fails here instead of shipping.
 */
import { describe, expect, it } from 'vitest';
import packageJson from '../package.json' with { type: 'json' };
import { loadConfig } from './config.js';
import { VERSION } from './index.js';
import { TELEMETRY_INSTRUMENTATION_VERSION } from './telemetry/conventions.js';

describe('version coherence', () => {
  it('exports the package version', () => {
    expect(VERSION).toBe(packageJson.version);
  });

  it('reports the package version as the OTel instrumentation version', () => {
    expect(TELEMETRY_INSTRUMENTATION_VERSION).toBe(packageJson.version);
  });

  it('defaults OTEL_SERVICE_VERSION to the package version', () => {
    const config = loadConfig({
      DISCORD_TOKEN: 'Bot fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    } as NodeJS.ProcessEnv);
    expect(config.OTEL_SERVICE_VERSION).toBe(packageJson.version);
  });

  it('never reports 0.0.0', () => {
    expect(VERSION).not.toBe('0.0.0');
  });
});
