import { REST } from '@discordjs/rest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { type BlueprintLifecycleObservation, buildServer } from './server.js';

const ENV = {
  DISCORD_TOKEN: 'Bot fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  LOG_LEVEL: 'fatal',
  MCP_TOOL_SURFACE: 'progressive',
  MCP_AUDIT_ENABLED: 'false',
} as NodeJS.ProcessEnv;

async function connect(observer: (event: BlueprintLifecycleObservation) => void) {
  const config = loadConfig(ENV);
  const rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const { server } = await buildServer({
    rest,
    logger: createLogger(config),
    config,
    onBlueprintLifecycle: observer,
  });
  const client = new Client(
    { name: 'activity-observer-test', version: '0.0.0' },
    { capabilities: {} },
  );
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const DIGEST = `sha256:${'a'.repeat(64)}`;
const PLAN_REF = `dmbpr1.${'b'.repeat(64)}`;
const TARGET = {
  guild_id: '111122223333444455',
  expected_bot_id: '222233334444555566',
};

describe('blueprint lifecycle observer', () => {
  beforeEach(() => {
    process.env.MCP_DRY_RUN = 'false';
  });

  afterEach(() => {
    delete process.env.MCP_DRY_RUN;
  });

  it('emits one sanitized observation for canonical and progressive lifecycle calls', async () => {
    const observations: BlueprintLifecycleObservation[] = [];
    const client = await connect((event) => observations.push(event));

    try {
      const plan = await client.callTool({
        name: 'build_discord_server',
        arguments: { request: 'Build a professional gaming Discord server' },
      });
      const canonicalPlan = await client.callTool({
        name: 'guild_blueprint_plan',
        arguments: { request: 'Build a professional gaming Discord server' },
      });
      const apply = await client.callTool({
        name: 'guild_blueprint_apply',
        arguments: { ...TARGET, plan_ref: PLAN_REF, approval_id: DIGEST, __confirm: true },
      });
      const evidence = await client.callTool({
        name: 'guild_blueprint_evidence',
        arguments: { ...TARGET, plan_id: DIGEST },
      });
      const dispatchedEvidence = await client.callTool({
        name: 'mcp_tools_read',
        arguments: { tool: 'guild_blueprint_evidence', args: {} },
      });
      const pipelineEvidence = await client.callTool({
        name: 'mcp_pipeline',
        arguments: {
          steps: [{ id: 'evidence', tool: 'guild_blueprint_evidence', args: {} }],
        },
      });

      expect(plan).toMatchObject({ isError: false, structuredContent: { status: 'blocked' } });
      expect(canonicalPlan).toMatchObject({
        isError: false,
        structuredContent: { status: 'blocked' },
      });
      expect(apply).toMatchObject({ isError: false, structuredContent: { status: 'blocked' } });
      expect(evidence).toMatchObject({
        isError: false,
        structuredContent: { status: 'blocked' },
      });
      expect(dispatchedEvidence.isError).toBe(true);
      expect(pipelineEvidence).toMatchObject({
        isError: false,
        structuredContent: { aborted: true },
      });
      expect(observations).toEqual([
        { stage: 'plan', status: 'blocked', outcome: 'blocked', transport: 'stdio' },
        { stage: 'plan', status: 'blocked', outcome: 'blocked', transport: 'stdio' },
        { stage: 'apply', status: 'blocked', outcome: 'blocked', transport: 'stdio' },
        { stage: 'evidence', status: 'blocked', outcome: 'blocked', transport: 'stdio' },
        { stage: 'evidence', status: 'error', outcome: 'failure', transport: 'stdio' },
        { stage: 'evidence', status: 'error', outcome: 'failure', transport: 'stdio' },
      ]);
      for (const event of observations) {
        expect(Object.keys(event).sort()).toEqual(['outcome', 'stage', 'status', 'transport']);
      }
    } finally {
      await client.close();
    }
  });

  it('maps errors and unknown statuses to failure without letting the observer alter results', async () => {
    delete process.env.MCP_DRY_RUN;
    const observations: BlueprintLifecycleObservation[] = [];
    const client = await connect((event) => {
      observations.push(event);
      throw new Error('observer failure must be swallowed');
    });

    try {
      const result = await client.callTool({
        name: 'guild_blueprint_apply',
        arguments: { ...TARGET, plan_ref: PLAN_REF, approval_id: DIGEST },
      });

      expect(result).toMatchObject({
        isError: true,
        structuredContent: { code: 'DRY_RUN_PREVIEW' },
      });
      expect(observations).toEqual([
        { stage: 'apply', status: 'error', outcome: 'failure', transport: 'stdio' },
      ]);
    } finally {
      await client.close();
    }
  });
});
