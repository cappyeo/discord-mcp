import type { REST } from '@discordjs/rest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { PayloadApprovalLedger } from './middleware/payload-confirmation.js';
import { buildServer } from './server.js';

const CHANNEL_ID = '111122223333444455';
const MESSAGE_ID = '999000999000999000';
const BOT_ID = '987654321098765432';
const VALID_TOKEN = 'Bot fake.test.token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('server-scoped payload approval ledger', () => {
  const config = loadConfig({
    DISCORD_TOKEN: VALID_TOKEN,
    MCP_DRY_RUN: 'false',
    MCP_WRITE_MODE: 'allow',
    MCP_AUDIT_ENABLED: 'false',
    DISCORD_EXPECTED_BOT_ID: BOT_ID,
    LOG_LEVEL: 'fatal',
  } as NodeJS.ProcessEnv);
  const logger = createLogger(config);
  const post = vi.fn().mockResolvedValue({
    id: MESSAGE_ID,
    channel_id: CHANNEL_ID,
    guild_id: '111122223333444466',
  });
  const rest = {
    get: vi.fn().mockResolvedValue({ id: BOT_ID, bot: true, username: 'approval-bot' }),
    post,
  } as unknown as REST;
  const ledger = new PayloadApprovalLedger();
  const originalDryRun = process.env.MCP_DRY_RUN;
  let firstClient: Client;
  let secondClient: Client;
  let isolatedClient: Client;

  beforeAll(async () => {
    process.env.MCP_DRY_RUN = 'false';
    const first = await buildServer({
      rest,
      logger,
      config,
      payloadApprovalLedger: ledger,
    });
    const second = await buildServer({
      rest,
      logger,
      config,
      payloadApprovalLedger: ledger,
    });
    const isolated = await buildServer({
      rest,
      logger,
      config,
      payloadApprovalLedger: new PayloadApprovalLedger(),
    });

    const [firstClientTransport, firstServerTransport] = InMemoryTransport.createLinkedPair();
    const [secondClientTransport, secondServerTransport] = InMemoryTransport.createLinkedPair();
    const [isolatedClientTransport, isolatedServerTransport] = InMemoryTransport.createLinkedPair();
    firstClient = new Client({ name: 'approval-first', version: '1.0.0' }, { capabilities: {} });
    secondClient = new Client({ name: 'approval-second', version: '1.0.0' }, { capabilities: {} });
    isolatedClient = new Client(
      { name: 'approval-isolated', version: '1.0.0' },
      { capabilities: {} },
    );
    await Promise.all([
      first.server.connect(firstServerTransport),
      firstClient.connect(firstClientTransport),
      second.server.connect(secondServerTransport),
      secondClient.connect(secondClientTransport),
      isolated.server.connect(isolatedServerTransport),
      isolatedClient.connect(isolatedClientTransport),
    ]);
  });

  afterAll(async () => {
    await Promise.all([firstClient.close(), secondClient.close(), isolatedClient.close()]);
    if (originalDryRun === undefined) delete process.env.MCP_DRY_RUN;
    else process.env.MCP_DRY_RUN = originalDryRun;
  });

  it('allows preview on one stateless server and one-time apply on another server in the same process', async () => {
    const args = {
      channel_id: CHANNEL_ID,
      components: [{ type: 10, content: 'cross-server approval' }],
    };
    const preview = await firstClient.callTool({ name: 'components_v2_send', arguments: args });
    expect(preview.structuredContent).toMatchObject({
      code: 'PAYLOAD_CONFIRMATION_REQUIRED',
    });
    const structured = preview.structuredContent as {
      payload_hash: string;
      approval_id: string;
    };

    const applied = await secondClient.callTool({
      name: 'components_v2_send',
      arguments: {
        ...args,
        __confirm: true,
        __confirm_hash: structured.payload_hash,
        __confirm_id: structured.approval_id,
      },
    });
    expect(applied.isError).toBe(false);
    expect(post).toHaveBeenCalledTimes(1);

    const replay = await firstClient.callTool({
      name: 'components_v2_send',
      arguments: {
        ...args,
        __confirm: true,
        __confirm_hash: structured.payload_hash,
        __confirm_id: structured.approval_id,
      },
    });
    expect(replay.structuredContent).toMatchObject({
      code: 'PAYLOAD_CONFIRMATION_APPROVAL_REPLAYED',
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a fresh process or replica receives an old approval', async () => {
    const args = {
      channel_id: CHANNEL_ID,
      components: [{ type: 10, content: 'replica boundary' }],
    };
    const preview = await firstClient.callTool({ name: 'components_v2_send', arguments: args });
    const structured = preview.structuredContent as {
      payload_hash: string;
      approval_id: string;
    };
    const result = await isolatedClient.callTool({
      name: 'components_v2_send',
      arguments: {
        ...args,
        __confirm: true,
        __confirm_hash: structured.payload_hash,
        __confirm_id: structured.approval_id,
      },
    });
    expect(result.structuredContent).toMatchObject({
      code: 'PAYLOAD_CONFIRMATION_APPROVAL_MISSING',
    });
    expect(post).toHaveBeenCalledTimes(1);
  });
});
