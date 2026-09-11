import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import stickersCreateGuildSticker from './create_guild_sticker.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('stickers_create_guild_sticker', () => {
  it.each([
    ['image/apng', 2, 'png'],
    ['application/json', 3, 'json'],
    ['application/octet-stream', 3, 'json'],
    ['image/gif', 4, 'gif'],
    ['application/octet-stream', 1, 'bin'],
  ])('preserves upload bytes and MIME type for %s', async (mime, format, extension) => {
    const post = vi.fn().mockResolvedValue({
      id: '850000000000000099',
      name: 'WaveHi',
      description: null,
      tags: 'wave',
      format_type: format,
    });
    container.rest = { post } as unknown as REST;
    const tool = new stickersCreateGuildSticker(
      {
        name: 'stickers_create_guild_sticker',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'stickers_create_guild_sticker', enabled: true },
    );
    const result = await tool.run(
      {
        guild_id: '999000999000999000',
        name: 'WaveHi',
        description: '',
        tags: 'wave',
        file_format: format,
        file_data: `data:${mime};base64,e30=`,
      },
      { signal: new AbortController().signal },
    );
    expect(result).toMatchObject({ isError: false, structuredContent: { available: true } });
    expect(post).toHaveBeenCalledWith(
      '/guilds/999000999000999000/stickers',
      expect.objectContaining({
        appendToFormData: true,
        files: [
          { key: 'file', name: `sticker.${extension}`, contentType: mime, data: Buffer.from('{}') },
        ],
      }),
    );
  });

  it('rejects malformed upload data before contacting Discord', async () => {
    const post = vi.fn();
    container.rest = { post } as unknown as REST;
    const tool = new stickersCreateGuildSticker(
      {
        name: 'stickers_create_guild_sticker',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'stickers_create_guild_sticker', enabled: true },
    );
    await expect(
      tool.run({ file_data: 'not-a-data-uri' }, { signal: new AbortController().signal }),
    ).rejects.toThrow(/base64 data URI/);
    expect(post).not.toHaveBeenCalled();
  });

  it('uploads multipart and returns the new sticker', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.post(`${DISCORD_API}/guilds/:guildId/stickers`, async ({ params }) =>
        HttpResponse.json({
          id: '850000000000000099',
          name: 'WaveHi',
          description: 'a friendly wave',
          tags: 'wave',
          format_type: 1,
          available: true,
          guild_id: params.guildId,
        }),
      ),
    );
    const T = stickersCreateGuildSticker;
    const t = new T(
      {
        name: 'stickers_create_guild_sticker',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'stickers_create_guild_sticker', enabled: true },
    );
    const tinyPng = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
    const r = (await t.run(
      {
        guild_id: '999000999000999000',
        name: 'WaveHi',
        description: 'a friendly wave',
        tags: 'wave',
        file_format: 1,
        file_data: `data:image/png;base64,${tinyPng}`,
      },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { id: string; name: string } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.id).toBe('850000000000000099');
    expect(r.structuredContent.name).toBe('WaveHi');
  });
});
