import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { buildResource } from './resource.js';

const VALID_TOKEN = 'Bot fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('buildResource', () => {
  it('returns a Resource with the configured service.name and service.version', () => {
    const config = loadConfig({
      DISCORD_TOKEN: VALID_TOKEN,
      OTEL_SERVICE_NAME: 'discord-mcp',
      OTEL_SERVICE_VERSION: '0.8.0',
    } as NodeJS.ProcessEnv);
    const resource = buildResource(config);
    const attrs = resource.attributes;
    expect(attrs['service.name']).toBe('discord-mcp');
    expect(attrs['service.version']).toBe('0.8.0');
  });

  it('tags resource with mcp.transport and mcp.tool_count', () => {
    const config = loadConfig({ DISCORD_TOKEN: VALID_TOKEN } as NodeJS.ProcessEnv);
    const attrs = buildResource(config).attributes;
    expect(attrs['mcp.transport']).toBe('stdio');
    expect(attrs['mcp.tool_count']).toBe('203');
  });

  it('honours OTEL_SERVICE_NAME / _VERSION overrides', () => {
    const config = loadConfig({
      DISCORD_TOKEN: VALID_TOKEN,
      OTEL_SERVICE_NAME: 'custom-service',
      OTEL_SERVICE_VERSION: '9.9.9',
    } as NodeJS.ProcessEnv);
    const attrs = buildResource(config).attributes;
    expect(attrs['service.name']).toBe('custom-service');
    expect(attrs['service.version']).toBe('9.9.9');
  });

  it('reads NODE_ENV into deployment.environment.name', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'staging';
    try {
      const config = loadConfig({ DISCORD_TOKEN: VALID_TOKEN } as NodeJS.ProcessEnv);
      const attrs = buildResource(config).attributes;
      expect(attrs['deployment.environment.name']).toBe('staging');
    } finally {
      if (prev === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = prev;
      }
    }
  });
});
