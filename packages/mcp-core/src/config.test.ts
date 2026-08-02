import { describe, expect, it } from 'vitest';
import packageJson from '../package.json' with { type: 'json' };
import { loadConfig } from './config.js';

const VALID_TOKEN = 'Bot fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('loadConfig', () => {
  it('throws when DISCORD_TOKEN is missing or too short', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/DISCORD_TOKEN/);
    expect(() => loadConfig({ DISCORD_TOKEN: 'short' } as NodeJS.ProcessEnv)).toThrow(/too short/);
  });

  it('returns defaults when only DISCORD_TOKEN provided', () => {
    const c = loadConfig({ DISCORD_TOKEN: VALID_TOKEN } as NodeJS.ProcessEnv);
    expect(c.DISCORD_EXPECTED_BOT_ID).toBeUndefined();
    expect(c.DISCORD_DEFAULT_GUILD_ID).toBeUndefined();
    expect(c.DISCORD_MCP_ACCESS_TOKEN).toBeUndefined();
    expect(c.LOG_LEVEL).toBe('info');
    expect(c.GATEWAY).toBe(false);
  });

  it('accepts a bot identity lock and rejects malformed IDs', () => {
    const configured = loadConfig({
      DISCORD_TOKEN: VALID_TOKEN,
      DISCORD_EXPECTED_BOT_ID: '987654321098765432',
    } as NodeJS.ProcessEnv);
    expect(configured.DISCORD_EXPECTED_BOT_ID).toBe('987654321098765432');
    expect(() =>
      loadConfig({
        DISCORD_TOKEN: VALID_TOKEN,
        DISCORD_EXPECTED_BOT_ID: 'not-a-snowflake',
      } as NodeJS.ProcessEnv),
    ).toThrow(/DISCORD_EXPECTED_BOT_ID/);
  });

  it('accepts a non-empty remote MCP bearer token and rejects an empty one', () => {
    expect(
      loadConfig({
        DISCORD_TOKEN: VALID_TOKEN,
        DISCORD_MCP_ACCESS_TOKEN: 'remote-access-token',
      } as NodeJS.ProcessEnv).DISCORD_MCP_ACCESS_TOKEN,
    ).toBe('remote-access-token');
    expect(() =>
      loadConfig({ DISCORD_TOKEN: VALID_TOKEN, DISCORD_MCP_ACCESS_TOKEN: '' } as NodeJS.ProcessEnv),
    ).toThrow(/DISCORD_MCP_ACCESS_TOKEN/);
  });

  it('accepts a valid default guild ID and rejects malformed values', () => {
    const configured = loadConfig({
      DISCORD_TOKEN: VALID_TOKEN,
      DISCORD_DEFAULT_GUILD_ID: '111122223333444455',
    } as NodeJS.ProcessEnv);
    expect(configured.DISCORD_DEFAULT_GUILD_ID).toBe('111122223333444455');
    expect(() =>
      loadConfig({
        DISCORD_TOKEN: VALID_TOKEN,
        DISCORD_DEFAULT_GUILD_ID: 'not-a-snowflake',
      } as NodeJS.ProcessEnv),
    ).toThrow(/DISCORD_DEFAULT_GUILD_ID/);
  });

  it('validates ALLOWED_GUILDS and requires the default guild to be allowed', () => {
    const configured = loadConfig({
      DISCORD_TOKEN: VALID_TOKEN,
      ALLOWED_GUILDS: '111122223333444455, 999000999000999000',
      DISCORD_DEFAULT_GUILD_ID: '999000999000999000',
    } as NodeJS.ProcessEnv);
    expect(configured.ALLOWED_GUILDS).toBe('111122223333444455, 999000999000999000');

    for (const value of ['', 'not-a-snowflake', '111122223333444455, bad']) {
      expect(() =>
        loadConfig({ DISCORD_TOKEN: VALID_TOKEN, ALLOWED_GUILDS: value } as NodeJS.ProcessEnv),
      ).toThrow(/ALLOWED_GUILDS/);
    }

    expect(() =>
      loadConfig({
        DISCORD_TOKEN: VALID_TOKEN,
        ALLOWED_GUILDS: '111122223333444455',
        DISCORD_DEFAULT_GUILD_ID: '999000999000999000',
      } as NodeJS.ProcessEnv),
    ).toThrow(/DISCORD_DEFAULT_GUILD_ID/);
  });

  describe('OpenTelemetry fields (Plan 8 Phase A)', () => {
    it('OTEL_ENABLED defaults to false', () => {
      const c = loadConfig({ DISCORD_TOKEN: VALID_TOKEN } as NodeJS.ProcessEnv);
      expect(c.OTEL_ENABLED).toBe(false);
    });

    it('OTEL_ENABLED accepts truthy strings', () => {
      for (const v of ['1', 'true', 'yes']) {
        const c = loadConfig({ DISCORD_TOKEN: VALID_TOKEN, OTEL_ENABLED: v } as NodeJS.ProcessEnv);
        expect(c.OTEL_ENABLED).toBe(true);
      }
      const off = loadConfig({
        DISCORD_TOKEN: VALID_TOKEN,
        OTEL_ENABLED: 'no',
      } as NodeJS.ProcessEnv);
      expect(off.OTEL_ENABLED).toBe(false);
    });

    it('OTEL_SERVICE_NAME defaults to "discord-mcp" and accepts override', () => {
      const def = loadConfig({ DISCORD_TOKEN: VALID_TOKEN } as NodeJS.ProcessEnv);
      expect(def.OTEL_SERVICE_NAME).toBe('discord-mcp');
      const overridden = loadConfig({
        DISCORD_TOKEN: VALID_TOKEN,
        OTEL_SERVICE_NAME: 'custom',
      } as NodeJS.ProcessEnv);
      expect(overridden.OTEL_SERVICE_NAME).toBe('custom');
    });

    it('OTEL_SERVICE_VERSION defaults to the package version and accepts override', () => {
      // Was asserted against a hardcoded '0.12.0'. A literal here is the same
      // bug class that let the server advertise 0.0.0 for twelve releases:
      // the test passes while the value is stale.
      const def = loadConfig({ DISCORD_TOKEN: VALID_TOKEN } as NodeJS.ProcessEnv);
      expect(def.OTEL_SERVICE_VERSION).toBe(packageJson.version);
      const overridden = loadConfig({
        DISCORD_TOKEN: VALID_TOKEN,
        OTEL_SERVICE_VERSION: '1.2.3',
      } as NodeJS.ProcessEnv);
      expect(overridden.OTEL_SERVICE_VERSION).toBe('1.2.3');
    });

    it('OTEL_EXPORTER_OTLP_ENDPOINT is optional and validates URL', () => {
      const def = loadConfig({ DISCORD_TOKEN: VALID_TOKEN } as NodeJS.ProcessEnv);
      expect(def.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
      const ok = loadConfig({
        DISCORD_TOKEN: VALID_TOKEN,
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      } as NodeJS.ProcessEnv);
      expect(ok.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://localhost:4318');
      expect(() =>
        loadConfig({
          DISCORD_TOKEN: VALID_TOKEN,
          OTEL_EXPORTER_OTLP_ENDPOINT: 'not-a-url',
        } as NodeJS.ProcessEnv),
      ).toThrow();
    });

    it('OTEL_EXPORTER_OTLP_PROTOCOL defaults to "http/protobuf" and accepts the enum', () => {
      const def = loadConfig({ DISCORD_TOKEN: VALID_TOKEN } as NodeJS.ProcessEnv);
      expect(def.OTEL_EXPORTER_OTLP_PROTOCOL).toBe('http/protobuf');
      for (const v of ['http/protobuf', 'http/json', 'grpc'] as const) {
        const c = loadConfig({
          DISCORD_TOKEN: VALID_TOKEN,
          OTEL_EXPORTER_OTLP_PROTOCOL: v,
        } as NodeJS.ProcessEnv);
        expect(c.OTEL_EXPORTER_OTLP_PROTOCOL).toBe(v);
      }
      expect(() =>
        loadConfig({
          DISCORD_TOKEN: VALID_TOKEN,
          OTEL_EXPORTER_OTLP_PROTOCOL: 'bogus',
        } as NodeJS.ProcessEnv),
      ).toThrow();
    });

    it('OTEL_EXPORTER_OTLP_HEADERS is optional', () => {
      const def = loadConfig({ DISCORD_TOKEN: VALID_TOKEN } as NodeJS.ProcessEnv);
      expect(def.OTEL_EXPORTER_OTLP_HEADERS).toBeUndefined();
      const c = loadConfig({
        DISCORD_TOKEN: VALID_TOKEN,
        OTEL_EXPORTER_OTLP_HEADERS: 'k=v,a=b',
      } as NodeJS.ProcessEnv);
      expect(c.OTEL_EXPORTER_OTLP_HEADERS).toBe('k=v,a=b');
    });

    it('OTEL_TRACES_SAMPLER defaults to "parentbased_always_on"', () => {
      const def = loadConfig({ DISCORD_TOKEN: VALID_TOKEN } as NodeJS.ProcessEnv);
      expect(def.OTEL_TRACES_SAMPLER).toBe('parentbased_always_on');
      const c = loadConfig({
        DISCORD_TOKEN: VALID_TOKEN,
        OTEL_TRACES_SAMPLER: 'traceidratio',
      } as NodeJS.ProcessEnv);
      expect(c.OTEL_TRACES_SAMPLER).toBe('traceidratio');
      expect(() =>
        loadConfig({
          DISCORD_TOKEN: VALID_TOKEN,
          OTEL_TRACES_SAMPLER: 'unknown',
        } as NodeJS.ProcessEnv),
      ).toThrow();
    });

    it('OTEL_TRACES_SAMPLER_ARG defaults to 1 and clamps via [0,1]', () => {
      const def = loadConfig({ DISCORD_TOKEN: VALID_TOKEN } as NodeJS.ProcessEnv);
      expect(def.OTEL_TRACES_SAMPLER_ARG).toBe(1);
      const half = loadConfig({
        DISCORD_TOKEN: VALID_TOKEN,
        OTEL_TRACES_SAMPLER_ARG: '0.25',
      } as NodeJS.ProcessEnv);
      expect(half.OTEL_TRACES_SAMPLER_ARG).toBe(0.25);
      expect(() =>
        loadConfig({
          DISCORD_TOKEN: VALID_TOKEN,
          OTEL_TRACES_SAMPLER_ARG: '2',
        } as NodeJS.ProcessEnv),
      ).toThrow();
      expect(() =>
        loadConfig({
          DISCORD_TOKEN: VALID_TOKEN,
          OTEL_TRACES_SAMPLER_ARG: '-1',
        } as NodeJS.ProcessEnv),
      ).toThrow();
    });

    it('OTEL_CONSOLE_EXPORTER defaults to false and accepts truthy strings', () => {
      const def = loadConfig({ DISCORD_TOKEN: VALID_TOKEN } as NodeJS.ProcessEnv);
      expect(def.OTEL_CONSOLE_EXPORTER).toBe(false);
      const on = loadConfig({
        DISCORD_TOKEN: VALID_TOKEN,
        OTEL_CONSOLE_EXPORTER: 'true',
      } as NodeJS.ProcessEnv);
      expect(on.OTEL_CONSOLE_EXPORTER).toBe(true);
    });
  });

  describe('Resilience fields (Plan 8 Phase C)', () => {
    it('MCP_RETRY_ENABLED defaults to true (default-on flag)', () => {
      const c = loadConfig({ DISCORD_TOKEN: VALID_TOKEN } as NodeJS.ProcessEnv);
      expect(c.MCP_RETRY_ENABLED).toBe(true);
    });

    it('MCP_RETRY_ENABLED only goes false on the literal string "false"', () => {
      const off = loadConfig({
        DISCORD_TOKEN: VALID_TOKEN,
        MCP_RETRY_ENABLED: 'false',
      } as NodeJS.ProcessEnv);
      expect(off.MCP_RETRY_ENABLED).toBe(false);
      // Anything else → true (default-on semantics).
      for (const v of ['true', '1', 'yes', '0', 'no', '']) {
        const on = loadConfig({
          DISCORD_TOKEN: VALID_TOKEN,
          MCP_RETRY_ENABLED: v,
        } as NodeJS.ProcessEnv);
        expect(on.MCP_RETRY_ENABLED).toBe(true);
      }
    });

    it('MCP_RETRY_MAX_ATTEMPTS defaults to 3 and rejects out-of-range', () => {
      const def = loadConfig({ DISCORD_TOKEN: VALID_TOKEN } as NodeJS.ProcessEnv);
      expect(def.MCP_RETRY_MAX_ATTEMPTS).toBe(3);
      const five = loadConfig({
        DISCORD_TOKEN: VALID_TOKEN,
        MCP_RETRY_MAX_ATTEMPTS: '5',
      } as NodeJS.ProcessEnv);
      expect(five.MCP_RETRY_MAX_ATTEMPTS).toBe(5);
      expect(() =>
        loadConfig({
          DISCORD_TOKEN: VALID_TOKEN,
          MCP_RETRY_MAX_ATTEMPTS: '0',
        } as NodeJS.ProcessEnv),
      ).toThrow();
      expect(() =>
        loadConfig({
          DISCORD_TOKEN: VALID_TOKEN,
          MCP_RETRY_MAX_ATTEMPTS: '11',
        } as NodeJS.ProcessEnv),
      ).toThrow();
    });

    it('MCP_RETRY_BASE_DELAY_MS defaults to 200 and rejects out-of-range', () => {
      const def = loadConfig({ DISCORD_TOKEN: VALID_TOKEN } as NodeJS.ProcessEnv);
      expect(def.MCP_RETRY_BASE_DELAY_MS).toBe(200);
      const overridden = loadConfig({
        DISCORD_TOKEN: VALID_TOKEN,
        MCP_RETRY_BASE_DELAY_MS: '1000',
      } as NodeJS.ProcessEnv);
      expect(overridden.MCP_RETRY_BASE_DELAY_MS).toBe(1000);
      expect(() =>
        loadConfig({
          DISCORD_TOKEN: VALID_TOKEN,
          MCP_RETRY_BASE_DELAY_MS: '49',
        } as NodeJS.ProcessEnv),
      ).toThrow();
      expect(() =>
        loadConfig({
          DISCORD_TOKEN: VALID_TOKEN,
          MCP_RETRY_BASE_DELAY_MS: '5001',
        } as NodeJS.ProcessEnv),
      ).toThrow();
    });

    it('MCP_RETRY_MAX_DELAY_MS defaults to 10000 and rejects out-of-range', () => {
      const def = loadConfig({ DISCORD_TOKEN: VALID_TOKEN } as NodeJS.ProcessEnv);
      expect(def.MCP_RETRY_MAX_DELAY_MS).toBe(10000);
      const overridden = loadConfig({
        DISCORD_TOKEN: VALID_TOKEN,
        MCP_RETRY_MAX_DELAY_MS: '30000',
      } as NodeJS.ProcessEnv);
      expect(overridden.MCP_RETRY_MAX_DELAY_MS).toBe(30000);
      expect(() =>
        loadConfig({
          DISCORD_TOKEN: VALID_TOKEN,
          MCP_RETRY_MAX_DELAY_MS: '499',
        } as NodeJS.ProcessEnv),
      ).toThrow();
      expect(() =>
        loadConfig({
          DISCORD_TOKEN: VALID_TOKEN,
          MCP_RETRY_MAX_DELAY_MS: '60001',
        } as NodeJS.ProcessEnv),
      ).toThrow();
    });

    it('MCP_RETRY_JITTER defaults to "full" and accepts the enum', () => {
      const def = loadConfig({ DISCORD_TOKEN: VALID_TOKEN } as NodeJS.ProcessEnv);
      expect(def.MCP_RETRY_JITTER).toBe('full');
      for (const v of ['none', 'full', 'decorrelated'] as const) {
        const c = loadConfig({
          DISCORD_TOKEN: VALID_TOKEN,
          MCP_RETRY_JITTER: v,
        } as NodeJS.ProcessEnv);
        expect(c.MCP_RETRY_JITTER).toBe(v);
      }
      expect(() =>
        loadConfig({
          DISCORD_TOKEN: VALID_TOKEN,
          MCP_RETRY_JITTER: 'bogus',
        } as NodeJS.ProcessEnv),
      ).toThrow();
    });

    it('MCP_TIMEOUT_DEFAULT_MS defaults to 30000 and rejects out-of-range', () => {
      const def = loadConfig({ DISCORD_TOKEN: VALID_TOKEN } as NodeJS.ProcessEnv);
      expect(def.MCP_TIMEOUT_DEFAULT_MS).toBe(30000);
      const overridden = loadConfig({
        DISCORD_TOKEN: VALID_TOKEN,
        MCP_TIMEOUT_DEFAULT_MS: '15000',
      } as NodeJS.ProcessEnv);
      expect(overridden.MCP_TIMEOUT_DEFAULT_MS).toBe(15000);
      expect(() =>
        loadConfig({
          DISCORD_TOKEN: VALID_TOKEN,
          MCP_TIMEOUT_DEFAULT_MS: '999',
        } as NodeJS.ProcessEnv),
      ).toThrow();
      expect(() =>
        loadConfig({
          DISCORD_TOKEN: VALID_TOKEN,
          MCP_TIMEOUT_DEFAULT_MS: '120001',
        } as NodeJS.ProcessEnv),
      ).toThrow();
    });
  });

  describe('Circuit breaker + bulkhead fields (Plan 8 Phase D)', () => {
    it('MCP_CIRCUIT_ENABLED defaults to true (default-on flag)', () => {
      const c = loadConfig({ DISCORD_TOKEN: VALID_TOKEN } as NodeJS.ProcessEnv);
      expect(c.MCP_CIRCUIT_ENABLED).toBe(true);
    });

    it('MCP_CIRCUIT_ENABLED only goes false on the literal string "false"', () => {
      const off = loadConfig({
        DISCORD_TOKEN: VALID_TOKEN,
        MCP_CIRCUIT_ENABLED: 'false',
      } as NodeJS.ProcessEnv);
      expect(off.MCP_CIRCUIT_ENABLED).toBe(false);
      for (const v of ['true', '1', 'yes', '0', 'no', '']) {
        const on = loadConfig({
          DISCORD_TOKEN: VALID_TOKEN,
          MCP_CIRCUIT_ENABLED: v,
        } as NodeJS.ProcessEnv);
        expect(on.MCP_CIRCUIT_ENABLED).toBe(true);
      }
    });

    it('MCP_CIRCUIT_FAILURE_THRESHOLD defaults to 10 and rejects out-of-range', () => {
      const def = loadConfig({ DISCORD_TOKEN: VALID_TOKEN } as NodeJS.ProcessEnv);
      expect(def.MCP_CIRCUIT_FAILURE_THRESHOLD).toBe(10);
      const overridden = loadConfig({
        DISCORD_TOKEN: VALID_TOKEN,
        MCP_CIRCUIT_FAILURE_THRESHOLD: '5',
      } as NodeJS.ProcessEnv);
      expect(overridden.MCP_CIRCUIT_FAILURE_THRESHOLD).toBe(5);
      expect(() =>
        loadConfig({
          DISCORD_TOKEN: VALID_TOKEN,
          MCP_CIRCUIT_FAILURE_THRESHOLD: '2',
        } as NodeJS.ProcessEnv),
      ).toThrow();
      expect(() =>
        loadConfig({
          DISCORD_TOKEN: VALID_TOKEN,
          MCP_CIRCUIT_FAILURE_THRESHOLD: '101',
        } as NodeJS.ProcessEnv),
      ).toThrow();
    });

    it('MCP_CIRCUIT_HALF_OPEN_AFTER_MS defaults to 60000 and rejects out-of-range', () => {
      const def = loadConfig({ DISCORD_TOKEN: VALID_TOKEN } as NodeJS.ProcessEnv);
      expect(def.MCP_CIRCUIT_HALF_OPEN_AFTER_MS).toBe(60000);
      const overridden = loadConfig({
        DISCORD_TOKEN: VALID_TOKEN,
        MCP_CIRCUIT_HALF_OPEN_AFTER_MS: '30000',
      } as NodeJS.ProcessEnv);
      expect(overridden.MCP_CIRCUIT_HALF_OPEN_AFTER_MS).toBe(30000);
      expect(() =>
        loadConfig({
          DISCORD_TOKEN: VALID_TOKEN,
          MCP_CIRCUIT_HALF_OPEN_AFTER_MS: '4999',
        } as NodeJS.ProcessEnv),
      ).toThrow();
      expect(() =>
        loadConfig({
          DISCORD_TOKEN: VALID_TOKEN,
          MCP_CIRCUIT_HALF_OPEN_AFTER_MS: '600001',
        } as NodeJS.ProcessEnv),
      ).toThrow();
    });

    it('MCP_BULKHEAD_LIMIT defaults to 100 and rejects out-of-range', () => {
      const def = loadConfig({ DISCORD_TOKEN: VALID_TOKEN } as NodeJS.ProcessEnv);
      expect(def.MCP_BULKHEAD_LIMIT).toBe(100);
      const overridden = loadConfig({
        DISCORD_TOKEN: VALID_TOKEN,
        MCP_BULKHEAD_LIMIT: '50',
      } as NodeJS.ProcessEnv);
      expect(overridden.MCP_BULKHEAD_LIMIT).toBe(50);
      expect(() =>
        loadConfig({
          DISCORD_TOKEN: VALID_TOKEN,
          MCP_BULKHEAD_LIMIT: '0',
        } as NodeJS.ProcessEnv),
      ).toThrow();
      expect(() =>
        loadConfig({
          DISCORD_TOKEN: VALID_TOKEN,
          MCP_BULKHEAD_LIMIT: '1001',
        } as NodeJS.ProcessEnv),
      ).toThrow();
    });
  });

  describe('Audit fields (Plan 8 Phase E)', () => {
    it('MCP_AUDIT_ENABLED defaults to true (default-on flag)', () => {
      const c = loadConfig({ DISCORD_TOKEN: VALID_TOKEN } as NodeJS.ProcessEnv);
      expect(c.MCP_AUDIT_ENABLED).toBe(true);
    });

    it('MCP_AUDIT_ENABLED only goes false on the literal string "false"', () => {
      const off = loadConfig({
        DISCORD_TOKEN: VALID_TOKEN,
        MCP_AUDIT_ENABLED: 'false',
      } as NodeJS.ProcessEnv);
      expect(off.MCP_AUDIT_ENABLED).toBe(false);
      for (const v of ['true', '1', 'yes', '0', 'no', '']) {
        const on = loadConfig({
          DISCORD_TOKEN: VALID_TOKEN,
          MCP_AUDIT_ENABLED: v,
        } as NodeJS.ProcessEnv);
        expect(on.MCP_AUDIT_ENABLED).toBe(true);
      }
    });

    it('MCP_AUDIT_SINK defaults to "stderr" and accepts the enum', () => {
      const def = loadConfig({ DISCORD_TOKEN: VALID_TOKEN } as NodeJS.ProcessEnv);
      expect(def.MCP_AUDIT_SINK).toBe('stderr');
      for (const v of ['stderr', 'file', 'otlp', 'none'] as const) {
        const c = loadConfig({
          DISCORD_TOKEN: VALID_TOKEN,
          MCP_AUDIT_SINK: v,
        } as NodeJS.ProcessEnv);
        expect(c.MCP_AUDIT_SINK).toBe(v);
      }
      expect(() =>
        loadConfig({
          DISCORD_TOKEN: VALID_TOKEN,
          MCP_AUDIT_SINK: 'bogus',
        } as NodeJS.ProcessEnv),
      ).toThrow();
    });

    it('MCP_AUDIT_FILE is optional and accepts a path override', () => {
      const def = loadConfig({ DISCORD_TOKEN: VALID_TOKEN } as NodeJS.ProcessEnv);
      expect(def.MCP_AUDIT_FILE).toBeUndefined();
      const c = loadConfig({
        DISCORD_TOKEN: VALID_TOKEN,
        MCP_AUDIT_FILE: '/var/log/discord-mcp/audit.jsonl',
      } as NodeJS.ProcessEnv);
      expect(c.MCP_AUDIT_FILE).toBe('/var/log/discord-mcp/audit.jsonl');
    });
  });
});
