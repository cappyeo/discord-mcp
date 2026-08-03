import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import '../../container.js';
import create from './create.js';
import deleteTemplate from './delete.js';
import diff from './diff.js';
import get from './get.js';
import inspect from './inspect.js';
import list from './list.js';
import modify from './modify.js';
import sync from './sync.js';

const DISCORD_API = 'https://discord.com/api/v10';
const guildId = '999000999000999000';
const code = 'techcommons2026';

const template = {
  code,
  name: 'Tech Commons',
  description: 'A community server',
  usage_count: 4,
  creator_id: '111122223333444455',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-02T00:00:00.000Z',
  source_guild_id: guildId,
  is_dirty: false,
  serialized_source_guild: {
    name: 'Tech Commons',
    channels: [{ id: 1, name: 'general', type: 0 }],
    roles: [{ id: 0, name: '@everyone', permissions: '0' }],
  },
};

function makeTool<T>(Piece: new (...args: never[]) => T, name: string): T {
  return new Piece(
    { name, path: 'inline', root: 'inline', store: null as never },
    { name, enabled: true },
  );
}

async function run<T extends { run: (args: object, options: object) => Promise<unknown> }>(
  Piece: new (...args: never[]) => T,
  name: string,
  args: object,
) {
  const tool = makeTool(Piece, name);
  return tool.run(args, { signal: new AbortController().signal }) as Promise<{
    isError: boolean;
    structuredContent: Record<string, unknown>;
  }>;
}

function useRest() {
  container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
}

describe('Guild Template tools', () => {
  it('GETs a public template and fences its snapshot as untrusted data', async () => {
    useRest();
    server.use(
      http.get(`${DISCORD_API}/guilds/templates/:code`, ({ params }) => {
        expect(params.code).toBe(code);
        return HttpResponse.json(template);
      }),
    );

    const result = await run(get, 'templates_get', { template_code: code });
    expect(result.isError).toBe(false);
    expect(result.structuredContent.template).toMatchObject({
      code,
      use_url: `https://discord.new/${code}`,
    });
    expect(result.structuredContent.source_guild).toEqual(template.serialized_source_guild);
    expect(result.structuredContent.untrusted_text).toContain('<untrusted_discord_template');
  });

  it('inspects template structure and isolates raw template names from the dossier', async () => {
    useRest();
    server.use(
      http.get(`${DISCORD_API}/guilds/templates/:code`, () =>
        HttpResponse.json({
          ...template,
          serialized_source_guild: {
            channels: [
              { id: 1, name: 'general', type: 0 },
              { id: 2, name: 'staff only', type: 4, permission_overwrites: [{ id: '1' }] },
            ],
            roles: [
              { id: 0, name: '@everyone', permissions: '0' },
              { id: 1, name: 'Do not trust this role name', permissions: '8' },
            ],
          },
        }),
      ),
    );

    const result = await run(inspect, 'templates_inspect', { template_code: code });
    expect(result.isError).toBe(false);
    expect(result.structuredContent.blueprint).toMatchObject({
      channel_count: 2,
      category_count: 1,
      text_channel_count: 1,
      permission_overwrite_count: 1,
      role_count: 2,
      privileged_role_count: 1,
      risky_permission_signals: [{ permission: 'ADMINISTRATOR', role_count: 1 }],
    });
    expect(JSON.stringify(result.structuredContent.blueprint)).not.toContain('Do not trust');
    expect(result.structuredContent.untrusted_text).toContain('Do not trust this role name');
  });

  it('compares only the template source guild and reports structural drift safely', async () => {
    useRest();
    server.use(
      http.get(`${DISCORD_API}/guilds/templates/:code`, () => HttpResponse.json(template)),
      http.get(`${DISCORD_API}/guilds/:guildId/channels`, () =>
        HttpResponse.json([
          { id: '1', name: 'general', type: 0 },
          { id: '2', name: 'announcements', type: 0 },
        ]),
      ),
      http.get(`${DISCORD_API}/guilds/:guildId/roles`, () =>
        HttpResponse.json([
          { id: guildId, name: '@everyone', permissions: '0' },
          { id: '4', name: 'Contributors', permissions: '0' },
        ]),
      ),
    );

    const result = await run(diff, 'templates_diff', { guild_id: guildId, template_code: code });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      source_guild_matches: true,
      drift: {
        channels_added_since_snapshot_count: 1,
        roles_added_since_snapshot_count: 1,
        sync_recommended: true,
      },
    });
    expect(result.structuredContent.untrusted_text).toContain('announcements');
  });

  it('audits matched role permissions, channel settings, and role overwrites', async () => {
    useRest();
    const semanticTemplate = {
      ...template,
      serialized_source_guild: {
        channels: [
          {
            id: 1,
            name: 'general',
            type: 0,
            topic: 'Original topic',
            permission_overwrites: [{ id: 0, type: 0, allow: '0', deny: '0' }],
          },
        ],
        roles: [
          { id: 0, name: '@everyone', permissions: '0' },
          { id: 1, name: 'Moderator', permissions: '0' },
        ],
      },
    };
    server.use(
      http.get(`${DISCORD_API}/guilds/templates/:code`, () => HttpResponse.json(semanticTemplate)),
      http.get(`${DISCORD_API}/guilds/:guildId/channels`, () =>
        HttpResponse.json([
          {
            id: '1',
            name: 'general',
            type: 0,
            topic: 'Updated topic',
            permission_overwrites: [{ id: guildId, type: 0, allow: '1024', deny: '0' }],
          },
        ]),
      ),
      http.get(`${DISCORD_API}/guilds/:guildId/roles`, () =>
        HttpResponse.json([
          { id: guildId, name: '@everyone', permissions: '0' },
          { id: '4', name: 'Moderator', permissions: '8' },
        ]),
      ),
    );

    const result = await run(diff, 'templates_diff', { guild_id: guildId, template_code: code });
    expect(result.isError).toBe(false);
    expect(result.structuredContent.drift).toMatchObject({
      role_permission_difference_count: 1,
      channel_setting_difference_count: 1,
      permission_overwrite_difference_count: 1,
      unmapped_permission_overwrite_count: 0,
      sync_recommended: true,
    });
    expect(result.structuredContent.untrusted_text).toContain('Moderator');
    expect(result.structuredContent.untrusted_text).toContain('topic');
  });

  it('ignores managed roles and pairs duplicate channel names by comparable settings', async () => {
    useRest();
    const duplicateChannelTemplate = {
      ...template,
      serialized_source_guild: {
        channels: [
          {
            id: 1,
            name: 'rules',
            type: 0,
            topic: null,
            permission_overwrites: [{ id: 0, type: 0, allow: '0', deny: '2048' }],
          },
          {
            id: 2,
            name: 'rules',
            type: 0,
            topic: 'Read this first',
            permission_overwrites: [
              { id: 1, type: 0, allow: '68608', deny: '0' },
              { id: 0, type: 0, allow: '0', deny: '2048' },
            ],
          },
        ],
        roles: [
          { id: 0, name: '@everyone', permissions: '0' },
          { id: 1, name: 'Member', permissions: '0' },
        ],
      },
    };
    server.use(
      http.get(`${DISCORD_API}/guilds/templates/:code`, () =>
        HttpResponse.json(duplicateChannelTemplate),
      ),
      http.get(`${DISCORD_API}/guilds/:guildId/channels`, () =>
        HttpResponse.json([
          {
            id: 'channel-with-topic',
            name: 'rules',
            type: 0,
            topic: 'Read this first',
            permission_overwrites: [
              { id: 'member-role', type: 0, allow: '68608', deny: '0' },
              { id: guildId, type: 0, allow: '0', deny: '2048' },
            ],
          },
          {
            id: 'channel-without-topic',
            name: 'rules',
            type: 0,
            topic: null,
            permission_overwrites: [{ id: guildId, type: 0, allow: '0', deny: '2048' }],
          },
        ]),
      ),
      http.get(`${DISCORD_API}/guilds/:guildId/roles`, () =>
        HttpResponse.json([
          { id: guildId, name: '@everyone', permissions: '0' },
          { id: 'member-role', name: 'Member', permissions: '0' },
          { id: 'bot-role', name: 'DevBot', managed: true, permissions: '8' },
        ]),
      ),
    );

    const result = await run(diff, 'templates_diff', { guild_id: guildId, template_code: code });
    expect(result.isError).toBe(false);
    expect(result.structuredContent.drift).toMatchObject({
      source_guild_role_count: 2,
      roles_added_since_snapshot_count: 0,
      channel_setting_difference_count: 0,
      permission_overwrite_difference_count: 0,
      sync_recommended: false,
    });
  });

  it('does not read an unrelated guild when the template source does not match', async () => {
    useRest();
    server.use(
      http.get(`${DISCORD_API}/guilds/templates/:code`, () => HttpResponse.json(template)),
    );

    const result = await run(diff, 'templates_diff', {
      guild_id: '888000888000888000',
      template_code: code,
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ source_guild_matches: false, drift: null });
  });

  it('GETs templates owned by one guild', async () => {
    useRest();
    server.use(
      http.get(`${DISCORD_API}/guilds/:guildId/templates`, () => HttpResponse.json([template])),
    );

    const result = await run(list, 'templates_list', { guild_id: guildId });
    expect(result.isError).toBe(false);
    expect(result.structuredContent.count).toBe(1);
    expect(result.structuredContent.templates).toMatchObject([{ code }]);
  });

  it('POSTs the requested snapshot metadata', async () => {
    useRest();
    server.use(
      http.post(`${DISCORD_API}/guilds/:guildId/templates`, async ({ request }) => {
        expect(await request.json()).toEqual({
          name: 'Tech Commons v1',
          description: 'Initial layout',
        });
        return HttpResponse.json({ ...template, name: 'Tech Commons v1' });
      }),
    );

    const result = await run(create, 'templates_create', {
      guild_id: guildId,
      name: 'Tech Commons v1',
      description: 'Initial layout',
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent.template).toMatchObject({ code, name: 'Tech Commons v1' });
  });

  it('PUTs a template code to sync its snapshot', async () => {
    useRest();
    server.use(
      http.put(`${DISCORD_API}/guilds/:guildId/templates/:code`, ({ params }) => {
        expect(params.code).toBe(code);
        return HttpResponse.json(template);
      }),
    );

    const result = await run(sync, 'templates_sync', { guild_id: guildId, template_code: code });
    expect(result.isError).toBe(false);
    expect(result.structuredContent.template).toMatchObject({ code });
  });

  it('PATCHes only supplied template metadata', async () => {
    useRest();
    server.use(
      http.patch(`${DISCORD_API}/guilds/:guildId/templates/:code`, async ({ request }) => {
        expect(await request.json()).toEqual({ description: null });
        return HttpResponse.json({ ...template, description: null });
      }),
    );

    const result = await run(modify, 'templates_modify', {
      guild_id: guildId,
      template_code: code,
      description: null,
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent.template).toMatchObject({ code, description: null });
  });

  it('DELETEs only through a destructive, confirmation-gated tool', async () => {
    useRest();
    server.use(
      http.delete(`${DISCORD_API}/guilds/:guildId/templates/:code`, () =>
        HttpResponse.json(template),
      ),
    );

    const result = await run(deleteTemplate, 'templates_delete', {
      guild_id: guildId,
      template_code: code,
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ deleted: true, template: { code } });
    expect(result.structuredContent.untrusted_text).toContain('<untrusted_discord_template');
    const tool = makeTool(deleteTemplate, 'templates_delete') as unknown as {
      preconditions: readonly string[];
      annotations: { destructiveHint: boolean };
    };
    expect(tool.preconditions).toContain('confirm_required');
    expect(tool.annotations.destructiveHint).toBe(true);
  });
});
