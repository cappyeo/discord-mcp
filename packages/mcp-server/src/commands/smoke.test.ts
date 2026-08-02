import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type SmokeDeps, type SmokeToolCall, type SmokeToolResult, smokeAction } from './smoke.js';

const originalDryRun = process.env.MCP_DRY_RUN;
const originalExitCode = process.exitCode;

let stdoutWrites: string[] = [];

beforeEach(() => {
  stdoutWrites = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    stdoutWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
  delete process.env.MCP_DRY_RUN;
  process.exitCode = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalDryRun === undefined) {
    delete process.env.MCP_DRY_RUN;
  } else {
    process.env.MCP_DRY_RUN = originalDryRun;
  }
  process.exitCode = originalExitCode;
});

function ok(structuredContent: Record<string, unknown>): SmokeToolResult {
  return { isError: false, content: [], structuredContent };
}

function fail(message: string): SmokeToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function makeDeps(
  guilds: Array<{ id: string }> = [{ id: '999000999000999000' }],
  overrides: Partial<Record<string, SmokeToolResult>> = {},
): { deps: SmokeDeps; calls: SmokeToolCall[]; close: ReturnType<typeof vi.fn> } {
  const calls: SmokeToolCall[] = [];
  const close = vi.fn(async () => undefined);
  const responses: Record<string, SmokeToolResult> = {
    users_get_current: ok({ id: '888000888000888000', username: 'TestBot' }),
    users_list_current_user_guilds: ok({ guilds, count: guilds.length, untrusted_names: '' }),
    channels_create_guild_channel: ok({
      id: '777000777000777000',
      name: 'mcp-smoke-test',
      type: 0,
      parent_id: null,
    }),
    messages_send: ok({
      message_id: '666000666000666000',
      channel_id: '777000777000777000',
    }),
    messages_edit: ok({
      message_id: '666000666000666000',
      channel_id: '777000777000777000',
    }),
    messages_delete: ok({ deleted: true }),
    channels_delete: ok({ deleted: true }),
    ...overrides,
  };

  return {
    calls,
    close,
    deps: {
      now: () => 1_722_555_555_000,
      openSession: async () => ({
        callTool: async (call) => {
          calls.push(call);
          return responses[call.name] ?? fail(`unexpected tool: ${call.name}`);
        },
        close,
      }),
    },
  };
}

function output(): {
  ok: boolean;
  exitCode: number;
  data: { mode: string; cleanupComplete?: boolean };
} {
  return JSON.parse(stdoutWrites.join(''));
}

describe('smokeAction', () => {
  it('does not open an MCP session when profile activation fails', async () => {
    const { deps, calls, close } = makeDeps();

    await smokeAction(
      {
        json: true,
        profile: 'missing',
        profileDirectory: join(tmpdir(), `discord-mcp-missing-smoke-${process.pid}`),
      },
      deps,
    );

    const parsed = JSON.parse(stdoutWrites.join(''));
    expect(process.exitCode).toBe(2);
    expect(parsed.summary).toContain('could not activate profile');
    expect(calls).toEqual([]);
    expect(close).not.toHaveBeenCalled();
  });

  it('is read-only by default', async () => {
    const { deps, calls, close } = makeDeps();

    await smokeAction({ json: true }, deps);

    expect(calls.map((call) => call.name)).toEqual([
      'users_get_current',
      'users_list_current_user_guilds',
    ]);
    expect(output()).toMatchObject({ ok: true, exitCode: 0, data: { mode: 'read-only' } });
    expect(process.env.MCP_DRY_RUN).toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  });

  it('runs create, send, edit, and self-cleaning deletes only with --confirm-write', async () => {
    process.env.MCP_DRY_RUN = 'true';
    const { deps, calls, close } = makeDeps();

    await smokeAction({ confirmWrite: true, json: true }, deps);

    expect(calls.map((call) => call.name)).toEqual([
      'users_get_current',
      'users_list_current_user_guilds',
      'channels_create_guild_channel',
      'messages_send',
      'messages_edit',
      'messages_delete',
      'channels_delete',
    ]);
    expect(
      calls.find((call) => call.name === 'channels_create_guild_channel')?.arguments,
    ).toMatchObject({ guild_id: '999000999000999000', type: 0 });
    expect(calls.find((call) => call.name === 'messages_delete')?.arguments).toMatchObject({
      __confirm: true,
    });
    expect(calls.find((call) => call.name === 'channels_delete')?.arguments).toMatchObject({
      __confirm: true,
    });
    expect(output()).toMatchObject({
      ok: true,
      exitCode: 0,
      data: { mode: 'write', cleanupComplete: true },
    });
    expect(process.env.MCP_DRY_RUN).toBe('true');
    expect(close).toHaveBeenCalledOnce();
  });

  it('refuses an ambiguous multi-guild write without --guild-id', async () => {
    const { deps, calls } = makeDeps([{ id: '999000999000999000' }, { id: '999000999000999001' }]);

    await smokeAction({ confirmWrite: true, json: true }, deps);

    expect(calls.map((call) => call.name)).toEqual([
      'users_get_current',
      'users_list_current_user_guilds',
    ]);
    expect(output()).toMatchObject({ ok: false, exitCode: 2, data: { mode: 'write' } });
  });

  it('paginates guild discovery before selecting an explicit write target', async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => ({
      id: (900_000_000_000_000_000n + BigInt(index)).toString(),
    }));
    const targetGuild = { id: '999000999000999000' };
    const { deps, calls } = makeDeps();
    const originalOpenSession = deps.openSession;
    deps.openSession = async () => {
      const session = await originalOpenSession();
      const originalCallTool = session.callTool;
      session.callTool = async (call) => {
        if (call.name === 'users_list_current_user_guilds') {
          calls.push(call);
          return ok({
            guilds: call.arguments?.after === undefined ? firstPage : [targetGuild],
          });
        }
        return originalCallTool(call);
      };
      return session;
    };

    await smokeAction({ confirmWrite: true, guildId: targetGuild.id, json: true }, deps);

    const guildCalls = calls.filter((call) => call.name === 'users_list_current_user_guilds');
    expect(guildCalls).toHaveLength(2);
    expect(guildCalls[1]?.arguments).toMatchObject({ after: firstPage.at(-1)?.id });
    expect(
      calls.find((call) => call.name === 'channels_create_guild_channel')?.arguments,
    ).toMatchObject({ guild_id: targetGuild.id });
    expect(output()).toMatchObject({
      ok: true,
      exitCode: 0,
      data: { visibleGuildCount: 201, cleanupComplete: true },
    });
  });

  it('deletes a created channel when a later write fails', async () => {
    const { deps, calls } = makeDeps(undefined, {
      messages_send: fail('missing Send Messages permission'),
    });

    await smokeAction({ confirmWrite: true, json: true }, deps);

    expect(calls.map((call) => call.name)).toEqual([
      'users_get_current',
      'users_list_current_user_guilds',
      'channels_create_guild_channel',
      'messages_send',
      'channels_delete',
    ]);
    expect(output()).toMatchObject({
      ok: false,
      exitCode: 2,
      data: { mode: 'write', cleanupComplete: true },
    });
  });

  it('deletes both temporary artifacts when editing the marker fails', async () => {
    const { deps, calls } = makeDeps(undefined, {
      messages_edit: fail('temporary edit failure'),
    });

    await smokeAction({ confirmWrite: true, json: true }, deps);

    expect(calls.map((call) => call.name)).toEqual([
      'users_get_current',
      'users_list_current_user_guilds',
      'channels_create_guild_channel',
      'messages_send',
      'messages_edit',
      'messages_delete',
      'channels_delete',
    ]);
    expect(output()).toMatchObject({
      ok: false,
      exitCode: 2,
      data: { mode: 'write', cleanupComplete: true },
    });
  });
});
