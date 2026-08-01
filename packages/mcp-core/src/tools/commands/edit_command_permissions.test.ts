import { server } from '@discord-mcp/server-mocks';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import commandsEditCommandPermissions from './edit_command_permissions.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('commands_edit_command_permissions', () => {
  it('uses Bearer auth (not Bot) and PUTs the body', async () => {
    let authHeader: string | null = null;
    server.use(
      http.put(
        `${DISCORD_API}/applications/:appId/guilds/:guildId/commands/:cmdId/permissions`,
        async ({ request, params }) => {
          authHeader = request.headers.get('authorization');
          const body = (await request.json()) as {
            permissions: Array<{ id: string; type: number; permission: boolean }>;
          };
          return HttpResponse.json({
            id: params.cmdId,
            application_id: params.appId,
            guild_id: params.guildId,
            permissions: body.permissions,
          });
        },
      ),
    );
    const t = new commandsEditCommandPermissions(
      {
        name: 'commands_edit_command_permissions',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'commands_edit_command_permissions', enabled: true },
    );
    const r = (await t.run(
      {
        application_id: '111111111111111111',
        guild_id: '999000999000999000',
        command_id: '222222222222222222',
        permissions: [{ id: '333333333333333333', type: 2, permission: true }],
        bearer_token: 'usr_oauth2_access_token_xxxxxxxxxxxxxxxxxxxxxxxxx',
      },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: { permissions: Array<{ id: string }> };
    };
    expect(r.isError).toBe(false);
    expect(authHeader).not.toBeNull();
    expect(authHeader!.startsWith('Bearer ')).toBe(true);
    expect(authHeader!.startsWith('Bot ')).toBe(false);
    expect(r.structuredContent.permissions[0]!.id).toBe('333333333333333333');
  });

  it('declares bearer_token required and rejects direct calls when it is missing', async () => {
    const t = new commandsEditCommandPermissions(
      {
        name: 'commands_edit_command_permissions',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'commands_edit_command_permissions', enabled: true },
    );
    const args = {
      application_id: '111111111111111111',
      guild_id: '999000999000999000',
      command_id: '222222222222222222',
      permissions: [],
    };
    expect(z.object(t.inputSchema).safeParse(args).success).toBe(false);
    await expect(
      t.run(args as Parameters<typeof t.run>[0], { signal: new AbortController().signal }),
    ).rejects.toThrow(/bearer_token/i);
  });
});
