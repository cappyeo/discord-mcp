/**
 * Attribution reaches each tool through `ctx.caller`, so the only honest proof
 * is the payload the tool hands Discord. These cases cover the write surfaces
 * added for attribution; the wording rules live in
 * `_lib/attribution.test.ts`.
 */
import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import type { CallerIdentity } from '../../pieces/Tool.js';
import '../../container.js';
import channelsModify from '../channels/modify.js';
import createGlobalCommand from '../commands/create_global.js';
import modifyGuildCommand from '../commands/modify_guild.js';
import componentsSend from '../components-v2/send.js';
import eventsCreate from '../events/create.js';
import eventsModify from '../events/modify.js';
import guildModify from '../guild/modify.js';
import createFollowup from '../interactions/create_followup.js';
import editFollowup from '../interactions/edit_followup.js';
import editOriginalResponse from '../interactions/edit_original_response.js';
import messagesEdit from '../messages/edit.js';
import stageCreate from '../stage_instances/create.js';
import stageModify from '../stage_instances/modify.js';
import createSticker from '../stickers/create_guild_sticker.js';
import modifySticker from '../stickers/modify_guild_sticker.js';
import templatesModify from '../templates/modify.js';
import webhooksEditMessage from '../webhooks/edit_message.js';

const CALLER: CallerIdentity = { id: '111122223333444455', username: 'frostbun' };
const EDITED = '-# _Edited by <@111122223333444455> via discord-mcp_';
const UPDATED = '-# _Updated by <@111122223333444455> via discord-mcp_';
const API = 'https://discord.com/api/v10';

type Runnable = {
  run: (args: unknown, ctx: { signal: AbortSignal; caller?: CallerIdentity }) => Promise<unknown>;
};

function run(piece: new (options: never, meta: never) => Runnable, args: Record<string, unknown>) {
  container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
  const instance = new piece(
    { path: 'inline', root: 'inline', store: null } as never,
    { enabled: true } as never,
  );
  return instance.run(args, { signal: new AbortController().signal, caller: CALLER });
}

/** Capture the JSON body of the single write a tool makes. */
function capture(method: 'patch' | 'post', path: string, reply: unknown) {
  const bodies: Record<string, unknown>[] = [];
  server.use(
    http[method](`${API}${path}`, async ({ request }) => {
      bodies.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json(reply);
    }),
  );
  return bodies;
}

describe('attribution on write surfaces', () => {
  it('credits a message edit', async () => {
    const bodies = capture('patch', '/channels/:cid/messages/:mid', {
      id: '999000999000999000',
      channel_id: '111122223333444455',
      edited_timestamp: '2026-04-28T13:00:00.000000+00:00',
    });
    await run(messagesEdit, {
      channel_id: '111122223333444455',
      message_id: '999000999000999000',
      content: 'updated',
    });
    expect(bodies.at(-1)?.content).toBe(`updated\n${EDITED}`);
  });

  it('credits a webhook message edit', async () => {
    const bodies = capture('patch', '/webhooks/:wid/:token/messages/:mid', {
      id: '999000999000999000',
      channel_id: '111122223333444455',
    });
    await run(webhooksEditMessage, {
      webhook_id: '111122223333444455',
      token: 'a'.repeat(70),
      message_id: '999000999000999000',
      content: 'updated',
    });
    expect(bodies.at(-1)?.content).toBe(`updated\n${EDITED}`);
  });

  it('adds the credit as its own V2 text block', async () => {
    const bodies = capture('post', '/channels/:cid/messages', {
      id: '999000999000999000',
      channel_id: '111122223333444455',
      guild_id: '222222222222222222',
    });
    await run(componentsSend, {
      channel_id: '111122223333444455',
      components: [{ type: 10, content: 'hi' }],
      allowed_mentions: { parse: ['users'] },
    });
    expect(bodies.at(-1)?.components).toEqual([
      { type: 10, content: 'hi' },
      { type: 10, content: `-# _Sent by <@111122223333444455> via discord-mcp_` },
    ]);
    // The caller's own mention policy is passed through untouched.
    expect(bodies.at(-1)?.allowed_mentions).toEqual({ parse: ['users'] });
  });

  it('credits a guild description without touching its name', async () => {
    const bodies = capture('patch', '/guilds/:gid', {
      id: '222222222222222222',
      name: 'Guild',
      icon: null,
      owner_id: '111111111111111111',
      description: 'a server',
      preferred_locale: 'en-US',
      features: [],
    });
    await run(guildModify, {
      guild_id: '222222222222222222',
      name: 'Guild',
      description: 'a server',
    });
    expect(bodies.at(-1)?.name).toBe('Guild');
    expect(bodies.at(-1)?.description).toBe(`a server ${UPDATED}`);
  });

  it('credits a channel topic', async () => {
    const bodies = capture('patch', '/channels/:cid', {
      id: '111122223333444455',
      name: 'general',
      type: 0,
      parent_id: null,
    });
    await run(channelsModify, {
      channel_id: '111122223333444455',
      topic: 'about the server',
    });
    expect(bodies.at(-1)?.topic).toBe(`about the server ${UPDATED}`);
  });

  it('credits an event description', async () => {
    const bodies = capture('patch', '/guilds/:gid/scheduled-events/:eid', {
      id: '999000999000999000',
      guild_id: '222222222222222222',
      scheduled_start_time: '2026-11-03T00:00:00.000Z',
      scheduled_end_time: null,
      status: 1,
      entity_type: 3,
      channel_id: null,
      description: 'meet up',
    });
    await run(eventsModify, {
      guild_id: '222222222222222222',
      event_id: '999000999000999000',
      description: 'meet up',
    });
    expect(bodies.at(-1)?.description).toBe(`meet up ${UPDATED}`);
  });

  it('credits a stage topic', async () => {
    const bodies = capture('patch', '/stage-instances/:cid', {
      id: '999000999000999000',
      guild_id: '222222222222222222',
      channel_id: '111122223333444455',
      topic: 'live',
      privacy_level: 2,
    });
    await run(stageModify, {
      channel_id: '111122223333444455',
      topic: 'live',
    });
    expect(bodies.at(-1)?.topic).toBe(`live ${UPDATED}`);
  });

  it('credits a template description and leaves a null clear alone', async () => {
    const bodies = capture('patch', '/guilds/:gid/templates/:code', {
      code: 'abc',
      name: 'Template',
      description: 'about',
      usage_count: 0,
      creator_id: '111111111111111111',
      creator: { id: '111111111111111111', username: 'bot' },
      created_at: '2026-11-03T00:00:00.000Z',
      updated_at: '2026-11-03T00:00:00.000Z',
      source_guild_id: '222222222222222222',
      serialized_source_guild: {},
      is_dirty: null,
    });
    await run(templatesModify, {
      guild_id: '222222222222222222',
      template_code: 'abc',
      description: 'about',
    });
    expect(bodies.at(-1)?.description).toBe(`about ${UPDATED}`);

    await run(templatesModify, {
      guild_id: '222222222222222222',
      template_code: 'abc',
      description: null,
    });
    expect(bodies.at(-1)?.description).toBeNull();
  });

  it('credits an interaction follow-up and its edit', async () => {
    const bodies = capture('post', '/webhooks/:aid/:token', {
      id: '999000999000999000',
      channel_id: '111122223333444455',
    });
    await run(createFollowup, {
      application_id: '222222222222222222',
      interaction_token: 'a'.repeat(70),
      content: 'hello',
    });
    expect(bodies.at(-1)?.content).toBe(
      `hello\n-# _Sent by <@111122223333444455> via discord-mcp_`,
    );

    const edits = capture('patch', '/webhooks/:aid/:token/messages/:mid', {
      id: '999000999000999000',
      channel_id: '111122223333444455',
    });
    await run(editFollowup, {
      application_id: '222222222222222222',
      interaction_token: 'a'.repeat(70),
      message_id: '999000999000999000',
      content: 'hello',
    });
    expect(edits.at(-1)?.content).toBe(`hello\n${EDITED}`);
  });

  it('credits an edited original interaction response', async () => {
    const bodies = capture('patch', '/webhooks/:aid/:token/messages/%40original', {
      id: '999000999000999000',
      channel_id: '111122223333444455',
    });
    await run(editOriginalResponse, {
      application_id: '222222222222222222',
      interaction_token: 'a'.repeat(70),
      content: 'hello',
    });
    expect(bodies.at(-1)?.content).toBe(`hello\n${EDITED}`);
  });

  it('credits command descriptions on create and modify', async () => {
    const created = capture('post', '/applications/:aid/commands', {
      id: '999000999000999000',
      application_id: '222222222222222222',
      name: 'ping',
      description: 'pong',
      type: 1,
    });
    await run(createGlobalCommand, {
      application_id: '222222222222222222',
      name: 'ping',
      description: 'pong',
    });
    expect(created.at(-1)?.description).toBe(
      `pong -# _Created by <@111122223333444455> via discord-mcp_`,
    );

    const modified = capture('patch', '/applications/:aid/guilds/:gid/commands/:cid', {
      id: '999000999000999000',
      application_id: '222222222222222222',
      guild_id: '222222222222222222',
      name: 'ping',
      description: 'pong',
      type: 1,
    });
    await run(modifyGuildCommand, {
      application_id: '222222222222222222',
      guild_id: '222222222222222222',
      command_id: '999000999000999000',
      description: 'pong',
    });
    expect(modified.at(-1)?.description).toBe(`pong ${UPDATED}`);
  });

  it('credits a sticker description', async () => {
    const bodies: FormData[] = [];
    server.use(
      http.post(`${API}/guilds/:gid/stickers`, async ({ request }) => {
        bodies.push(await request.formData());
        return HttpResponse.json({
          id: '999000999000999000',
          name: 'Wave',
          description: 'a wave',
          tags: 'wave',
          format_type: 1,
          available: true,
        });
      }),
    );
    await run(createSticker, {
      guild_id: '222222222222222222',
      name: 'Wave',
      description: 'a wave',
      tags: 'wave',
      file_format: 1,
      file_data: 'data:image/png;base64,iVBORw0KGgo=',
    });
    expect(bodies.at(-1)?.get('description')).toBe(
      `a wave -# _Created by <@111122223333444455> via discord-mcp_`,
    );
  });

  it('credits a stage topic on create', async () => {
    const bodies = capture('post', '/stage-instances', {
      id: '999000999000999000',
      guild_id: '222222222222222222',
      channel_id: '111122223333444455',
      topic: 'live',
      privacy_level: 2,
    });
    await run(stageCreate, { channel_id: '111122223333444455', topic: 'live' });
    expect(bodies.at(-1)?.topic).toBe(`live -# _Created by <@111122223333444455> via discord-mcp_`);
  });

  it('credits an event description on create', async () => {
    const bodies = capture('post', '/guilds/:gid/scheduled-events', {
      id: '999000999000999000',
      guild_id: '222222222222222222',
      name: 'Meetup',
      scheduled_start_time: '2026-11-03T00:00:00.000Z',
      scheduled_end_time: null,
      status: 1,
      entity_type: 3,
      channel_id: null,
      description: 'meet up',
    });
    await run(eventsCreate, {
      guild_id: '222222222222222222',
      name: 'Meetup',
      scheduled_start_time: '2026-11-03T00:00:00.000Z',
      entity_type: 3,
      description: 'meet up',
    });
    expect(bodies.at(-1)?.description).toBe(
      `meet up -# _Created by <@111122223333444455> via discord-mcp_`,
    );
  });

  it('credits a sticker description on modify and leaves the rest untouched', async () => {
    const bodies = capture('patch', '/guilds/:gid/stickers/:sid', {
      id: '999000999000999000',
      name: 'Wave',
      description: 'a wave',
      tags: 'wave',
      format_type: 1,
      available: true,
    });
    await run(modifySticker, {
      guild_id: '222222222222222222',
      sticker_id: '999000999000999000',
      description: 'a wave',
    });
    expect(bodies.at(-1)?.description).toBe(`a wave ${UPDATED}`);
    expect(bodies.at(-1)?.name).toBeUndefined();
  });

  it('credits a template description while leaving its name alone', async () => {
    const bodies = capture('patch', '/guilds/:gid/templates/:code', {
      code: 'abc',
      name: 'Renamed',
      description: 'about',
      usage_count: 0,
      creator_id: '111111111111111111',
      creator: { id: '111111111111111111', username: 'bot' },
      created_at: '2026-11-03T00:00:00.000Z',
      updated_at: '2026-11-03T00:00:00.000Z',
      source_guild_id: '222222222222222222',
      serialized_source_guild: {},
      is_dirty: null,
    });
    await run(templatesModify, {
      guild_id: '222222222222222222',
      template_code: 'abc',
      name: 'Renamed',
      description: 'about',
    });
    expect(bodies.at(-1)?.name).toBe('Renamed');
    expect(bodies.at(-1)?.description).toBe(`about ${UPDATED}`);
  });

  it('credits a webhook edit made inside a thread', async () => {
    const bodies = capture('patch', '/webhooks/:wid/:token/messages/:mid', {
      id: '999000999000999000',
      channel_id: '111122223333444455',
    });
    await run(webhooksEditMessage, {
      webhook_id: '111122223333444455',
      token: 'a'.repeat(70),
      message_id: '999000999000999000',
      thread_id: '111122223333444456',
      content: 'updated',
    });
    expect(bodies.at(-1)?.content).toBe(`updated\n${EDITED}`);
  });
});
