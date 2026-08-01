import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import appEmojisDelete from './delete.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('app_emojis_delete', () => {
  it('DELETEs the app emoji and returns deleted:true', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.delete(
        `${DISCORD_API}/applications/:appId/emojis/:emojiId`,
        async () => new HttpResponse(null, { status: 204 }),
      ),
    );
    const T = appEmojisDelete;
    const t = new T(
      { name: 'app_emojis_delete', path: 'inline', root: 'inline', store: null as never },
      { name: 'app_emojis_delete', enabled: true },
    );
    const r = (await t.run(
      { application_id: '111122223333444401', emoji_id: '850000000000000001' },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { deleted: boolean } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.deleted).toBe(true);
  });

  it('declares confirm_required + destructiveHint', () => {
    const T = appEmojisDelete;
    const t = new T(
      { name: 'app_emojis_delete', path: 'inline', root: 'inline', store: null as never },
      { name: 'app_emojis_delete', enabled: true },
    );
    expect(t.preconditions).toContain('confirm_required');
    expect(t.annotations.destructiveHint).toBe(true);
  });
});
