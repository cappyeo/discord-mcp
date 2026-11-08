import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REST } from '@discordjs/rest';
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { buildServer } from './server.js';
import { WORKFLOW_TASKS_EXTENSION } from './workflows/mcp-tasks.js';

const endpoint = 'http://localhost/mcp';
const revision = '2026-07-28';
const guild = '222222222222222222';
const role = {
  id: '333333333333333333',
  name: 'pilot',
  color: 0,
  position: 1,
  permissions: '0',
  mentionable: false,
  hoist: false,
};
const step = { tool: 'roles_create', args: { guild_id: guild, name: role.name } };
const input = {
  target: { profile_id: 'tasks-pilot', guild_id: guild },
  steps: [step],
  idempotency_key: 'task-pilot-workflow-01',
};
type MakeRequest = NonNullable<ConstructorParameters<typeof REST>[0]>['makeRequest'];

let directory: string;
let handlers: McpHttpHandler[];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'discord-mcp-tasks-'));
  handlers = [];
});
afterEach(async () => {
  await Promise.all(handlers.map((handler) => handler.close()));
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function makeHandler(makeRequest: MakeRequest, env: NodeJS.ProcessEnv = {}) {
  const config = loadConfig({
    DISCORD_TOKEN: 'fake'.padEnd(64, 'x'),
    DISCORD_MCP_ACCESS_TOKEN: 'a'.repeat(64),
    MCP_BLUEPRINT_STATE_DIR: directory,
    MCP_AUDIT_ENABLED: 'false',
    MCP_WORKFLOW_TASKS: 'true',
    LOG_LEVEL: 'fatal',
    ...env,
  });
  const rest = new REST({ version: '10', makeRequest }).setToken(config.DISCORD_TOKEN);
  const handler = createMcpHandler(
    async ({ era }) =>
      (
        await buildServer({
          config,
          logger: createLogger(config),
          rest,
          transport: 'http',
          enableResourceSubscriptions: false,
          enableWorkflowTasks: era === 'modern',
        })
      ).server,
  );
  handlers.push(handler);
  return handler;
}

async function rpc(
  handler: McpHttpHandler,
  method: string,
  params: Record<string, unknown> = {},
  capabilities = true,
) {
  const routingName = params.name ?? params.taskId;
  const response = await handler.fetch(
    new Request(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': revision,
        'Mcp-Method': method,
        ...(typeof routingName === 'string' ? { 'Mcp-Name': routingName } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': revision,
            'io.modelcontextprotocol/clientCapabilities': capabilities
              ? { extensions: { [WORKFLOW_TASKS_EXTENSION]: {} } }
              : {},
          },
        },
      }),
    }),
  );
  return (await response.json()) as {
    result?: { taskId?: string; status?: string; resultType?: string; [key: string]: unknown };
    error?: { code: number; message: string };
  };
}

describe('MCP Tasks pilot over the modern wire', () => {
  it('returns one durable task and performs one write across concurrent starts and reconnect', async () => {
    const write = vi.fn<MakeRequest>(async () => Response.json(role));
    const server = makeHandler(write, { MCP_TOOL_SURFACE: 'progressive' });
    const reconnect = makeHandler(write, { MCP_TOOL_SURFACE: 'progressive' });
    const other = makeHandler(write, { DISCORD_MCP_ACCESS_TOKEN: 'b'.repeat(64) });
    const blockedGuild = makeHandler(write, { ALLOWED_GUILDS: '555555555555555555' });
    const args = {
      name: 'mcp_tools_write',
      arguments: { tool: 'workflow_start', args: input },
    };

    const discovery = await rpc(server, 'server/discover');
    expect(discovery.result?.capabilities).toMatchObject({
      extensions: { [WORKFLOW_TASKS_EXTENSION]: {} },
    });
    const [first, second] = await Promise.all([
      rpc(server, 'tools/call', args),
      rpc(reconnect, 'tools/call', args),
    ]);
    expect(first.result).toMatchObject({ resultType: 'task', taskId: expect.any(String) });
    const taskId = first.result!.taskId!;
    expect(second.result).toMatchObject({ resultType: 'task', taskId });

    await vi.waitFor(async () => {
      const polled = await rpc(reconnect, 'tasks/get', { taskId });
      expect(polled.result).toMatchObject({
        resultType: 'complete',
        taskId,
        status: 'completed',
        result: { structuredContent: { id: taskId, status: 'completed', completed_steps: 1 } },
      });
    });
    expect(write).toHaveBeenCalledTimes(1);
    const noCapability = await rpc(reconnect, 'tasks/get', { taskId }, false);
    expect(noCapability.error?.code).toBe(-32021);
    expect((await rpc(other, 'tasks/get', { taskId })).error?.code).toBe(-32602);
    expect((await rpc(blockedGuild, 'tasks/get', { taskId })).error?.code).toBe(-32602);

    const fallback = await rpc(reconnect, 'tools/call', args, false);
    expect(fallback.result).toMatchObject({ structuredContent: { id: taskId } });
    expect(fallback.result?.resultType).not.toBe('task');
    const reused = await rpc(reconnect, 'tools/call', {
      name: 'workflow_start',
      arguments: { ...input, steps: [{ ...step, args: { ...step.args, name: 'different' } }] },
    });
    expect(reused.result).toMatchObject({
      isError: true,
      structuredContent: { code: 'VALIDATION_FAILED' },
    });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('acknowledges cooperative cancel and skips the next step across requests', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = vi.fn<MakeRequest>(async () => {
      await pending;
      return Response.json(role);
    });
    const server = makeHandler(write);
    const started = await rpc(server, 'tools/call', {
      name: 'workflow_start',
      arguments: { ...input, steps: [step, step] },
    });
    expect(started.result).toMatchObject({ resultType: 'task', taskId: expect.any(String) });
    const taskId = started.result!.taskId!;
    try {
      await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
      const updated = await rpc(server, 'tasks/update', { taskId, inputResponses: {} });
      expect(updated.result?.resultType).toBe('complete');
      const cancelled = await rpc(server, 'tasks/cancel', { taskId });
      expect(cancelled.result?.resultType).toBe('complete');
    } finally {
      release();
    }
    await vi.waitFor(async () => {
      expect((await rpc(server, 'tasks/get', { taskId })).result).toMatchObject({
        taskId,
        status: 'cancelled',
      });
    });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('keeps Tasks opt-in and uses the host LLM fallback for modern intelligence calls', async () => {
    const messages = vi.fn<MakeRequest>(async () =>
      Response.json([{ id: role.id, content: 'Sample', author: { username: 'fixture' } }]),
    );
    const server = makeHandler(messages, { MCP_WORKFLOW_TASKS: 'false' });
    const discovery = await rpc(server, 'server/discover');
    expect(discovery.result?.capabilities).not.toHaveProperty([
      'extensions',
      WORKFLOW_TASKS_EXTENSION,
    ]);
    const result = await rpc(server, 'tools/call', {
      name: 'intelligence_summarize_channel',
      arguments: { channel_id: '444444444444444444' },
    });
    expect(result.result).toMatchObject({
      structuredContent: {
        _meta: { fallback: 'host_llm_should_process', sampling_used: false },
        raw_messages: [{ content: 'Sample' }],
      },
    });
    expect(messages).toHaveBeenCalledTimes(1);
  });
});
