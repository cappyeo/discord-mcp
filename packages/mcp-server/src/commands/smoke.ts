/**
 * `discord-mcp smoke` - deterministic MCP path verification.
 *
 * The default run is read-only. `--confirm-write` opts into one bounded CRUD
 * lifecycle in a verified guild: create a temporary channel, send and edit one
 * marker message, then delete both artifacts. The command uses an in-memory MCP
 * client/server pair so it exercises the same schemas, middleware, audit, and
 * Discord REST path as an AI host without paying to load 192 tools into a model.
 */
import {
  buildPolicy,
  buildServer,
  createLogger,
  loadConfig,
  wrapRestWithResilience,
} from '@discord-mcp/core';
import { REST } from '@discordjs/rest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { emitResult } from '../lib/output.js';
import { activateProfile } from '../lib/profiles.js';

export interface SmokeOptions {
  json?: boolean;
  confirmWrite?: boolean;
  guildId?: string;
  profile?: string;
  profileDirectory?: string;
}

export interface SmokeToolCall {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface SmokeToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

export interface SmokeSession {
  callTool(call: SmokeToolCall): Promise<SmokeToolResult>;
  close(): Promise<void>;
}

export interface SmokeDeps {
  now(): number;
  openSession(): Promise<SmokeSession>;
}

interface SmokeState {
  identityRead: boolean;
  guildsRead: boolean;
  channelCreated: boolean;
  messageSent: boolean;
  messageEdited: boolean;
  messageDeleted: boolean;
  channelDeleted: boolean;
}

const SNOWFLAKE = /^\d{17,20}$/;

function toolError(name: string, result: SmokeToolResult): Error {
  const text = result.content?.find((item) => item.type === 'text')?.text;
  return new Error(text === undefined ? `${name} returned an MCP error` : `${name}: ${text}`);
}

async function callData(
  session: SmokeSession,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const result = await session.callTool({ name, arguments: args });
  if (result.isError === true) {
    throw toolError(name, result);
  }
  if (result.structuredContent === undefined || result.structuredContent === null) {
    throw new Error(`${name} returned no structuredContent`);
  }
  return result.structuredContent;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SNOWFLAKE.test(value)) {
    throw new Error(`${label} did not return a valid Discord snowflake`);
  }
  return value;
}

function guildIds(data: Record<string, unknown>): string[] {
  if (!Array.isArray(data.guilds)) {
    throw new Error('users_list_current_user_guilds returned an invalid guild list');
  }
  return data.guilds.map((guild, index) =>
    requireId((guild as { id?: unknown }).id, `guilds[${index}].id`),
  );
}

async function listVisibleGuildIds(session: SmokeSession): Promise<string[]> {
  const visibleGuilds: string[] = [];
  const seen = new Set<string>();
  let after: string | undefined;

  for (;;) {
    const guildData = await callData(session, 'users_list_current_user_guilds', {
      limit: 200,
      with_counts: false,
      ...(after === undefined ? {} : { after }),
    });
    const page = guildIds(guildData);
    for (const guildId of page) {
      if (seen.has(guildId)) {
        throw new Error('users_list_current_user_guilds returned a duplicate pagination result');
      }
      seen.add(guildId);
      visibleGuilds.push(guildId);
    }

    if (page.length < 200) {
      return visibleGuilds;
    }
    after = page.at(-1)!;
  }
}

function selectGuild(visibleGuilds: string[], requested?: string): string {
  if (requested !== undefined) {
    if (!SNOWFLAKE.test(requested)) {
      throw new Error('--guild-id must be a 17-20 digit Discord snowflake');
    }
    if (!visibleGuilds.includes(requested)) {
      throw new Error('the requested --guild-id is not visible to this bot');
    }
    return requested;
  }
  if (visibleGuilds.length === 0) {
    throw new Error('the bot is not installed in any guild');
  }
  if (visibleGuilds.length > 1) {
    throw new Error('the bot can see multiple guilds; pass --guild-id to select the test target');
  }
  return visibleGuilds[0]!;
}

function stateDetails(state: SmokeState): string[] {
  return [
    `identity read: ${state.identityRead ? 'ok' : 'not completed'}`,
    `guild discovery: ${state.guildsRead ? 'ok' : 'not completed'}`,
    `temporary channel create: ${state.channelCreated ? 'ok' : 'not completed'}`,
    `marker message send: ${state.messageSent ? 'ok' : 'not completed'}`,
    `marker message edit: ${state.messageEdited ? 'ok' : 'not completed'}`,
    `marker message delete: ${state.messageDeleted ? 'ok' : 'not completed'}`,
    `temporary channel delete: ${state.channelDeleted ? 'ok' : 'not completed'}`,
  ];
}

async function openDefaultSession(): Promise<SmokeSession> {
  const config = loadConfig();
  const logger = createLogger(config);
  const baseRest = new REST({ version: '10', retries: 0 }).setToken(
    config.DISCORD_TOKEN.startsWith('Bot ') ? config.DISCORD_TOKEN.slice(4) : config.DISCORD_TOKEN,
  );
  const rest = wrapRestWithResilience(baseRest, buildPolicy(config, logger), {
    circuitHalfOpenAfterMs: config.MCP_CIRCUIT_HALF_OPEN_AFTER_MS,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const built = await buildServer({ rest, logger, config });
  const client = new Client({ name: 'discord-mcp-smoke', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    callTool: async (call) =>
      (await client.callTool({
        name: call.name,
        arguments: call.arguments,
      })) as SmokeToolResult,
    close: async () => {
      await client.close();
      await built.server.close();
      await built.auditSink.shutdown?.();
    },
  };
}

const DEFAULT_DEPS: SmokeDeps = {
  now: Date.now,
  openSession: openDefaultSession,
};

export async function smokeAction(
  opts: SmokeOptions,
  deps: SmokeDeps = DEFAULT_DEPS,
): Promise<void> {
  if (opts.profile !== undefined) {
    try {
      activateProfile(opts.profile, {
        ...(opts.profileDirectory === undefined ? {} : { directory: opts.profileDirectory }),
      });
    } catch (error) {
      emitResult(
        {
          ok: false,
          exitCode: 2,
          summary: `could not activate profile ${opts.profile}`,
          errors: [error instanceof Error ? error.message : String(error)],
        },
        opts.json === true,
      );
      return;
    }
  }

  const mode = opts.confirmWrite === true ? 'write' : 'read-only';
  const state: SmokeState = {
    identityRead: false,
    guildsRead: false,
    channelCreated: false,
    messageSent: false,
    messageEdited: false,
    messageDeleted: false,
    channelDeleted: false,
  };
  const originalDryRun = process.env.MCP_DRY_RUN;
  let session: SmokeSession | undefined;
  let visibleGuildCount = 0;
  let channelId: string | undefined;
  let messageId: string | undefined;
  let failure: Error | undefined;
  const cleanupErrors: string[] = [];

  try {
    if (opts.confirmWrite === true) {
      process.env.MCP_DRY_RUN = 'false';
    }
    session = await deps.openSession();
    await callData(session, 'users_get_current');
    state.identityRead = true;
    const visibleGuilds = await listVisibleGuildIds(session);
    state.guildsRead = true;
    visibleGuildCount = visibleGuilds.length;

    if (opts.confirmWrite === true) {
      const guildId = selectGuild(visibleGuilds, opts.guildId);
      const suffix = deps.now().toString(36);
      const channelName = `mcp-smoke-${suffix}`;
      const channel = await callData(session, 'channels_create_guild_channel', {
        guild_id: guildId,
        name: channelName,
        type: 0,
      });
      channelId = requireId(channel.id, 'channels_create_guild_channel.id');
      state.channelCreated = true;

      const message = await callData(session, 'messages_send', {
        channel_id: channelId,
        content: 'discord-mcp native smoke test (temporary)',
      });
      messageId = requireId(message.message_id, 'messages_send.message_id');
      state.messageSent = true;

      await callData(session, 'messages_edit', {
        channel_id: channelId,
        message_id: messageId,
        content: 'discord-mcp native smoke test (edited; cleanup pending)',
      });
      state.messageEdited = true;

      await callData(session, 'messages_delete', {
        channel_id: channelId,
        message_id: messageId,
        __confirm: true,
      });
      state.messageDeleted = true;

      await callData(session, 'channels_delete', {
        channel_id: channelId,
        audit_reason: 'discord-mcp native smoke test cleanup',
        __confirm: true,
      });
      state.channelDeleted = true;
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    if (session !== undefined && opts.confirmWrite === true) {
      if (channelId !== undefined && messageId !== undefined && !state.messageDeleted) {
        try {
          await callData(session, 'messages_delete', {
            channel_id: channelId,
            message_id: messageId,
            __confirm: true,
          });
          state.messageDeleted = true;
        } catch (error) {
          cleanupErrors.push(error instanceof Error ? error.message : String(error));
        }
      }
      if (channelId !== undefined && !state.channelDeleted) {
        try {
          await callData(session, 'channels_delete', {
            channel_id: channelId,
            audit_reason: 'discord-mcp native smoke test failure cleanup',
            __confirm: true,
          });
          state.channelDeleted = true;
        } catch (error) {
          cleanupErrors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }

    if (session !== undefined) {
      try {
        await session.close();
      } catch (error) {
        if (failure === undefined) {
          failure = error instanceof Error ? error : new Error(String(error));
        }
      }
    }
    if (originalDryRun === undefined) {
      delete process.env.MCP_DRY_RUN;
    } else {
      process.env.MCP_DRY_RUN = originalDryRun;
    }
  }

  const cleanupComplete = channelId === undefined || state.channelDeleted;
  const data = {
    mode,
    visibleGuildCount,
    cleanupComplete,
    steps: state,
  };

  if (failure !== undefined) {
    emitResult(
      {
        ok: false,
        exitCode: 2,
        summary: `MCP ${mode} smoke test failed`,
        details: stateDetails(state),
        errors: [failure.message, ...cleanupErrors],
        data,
      },
      opts.json === true,
    );
    return;
  }

  emitResult(
    {
      ok: true,
      exitCode: 0,
      summary:
        mode === 'read-only'
          ? `MCP read smoke passed; bot can see ${visibleGuildCount} guild(s)`
          : 'MCP write smoke passed; temporary artifacts were removed',
      ...(mode === 'write' ? { details: stateDetails(state) } : {}),
      data,
    },
    opts.json === true,
  );
}
