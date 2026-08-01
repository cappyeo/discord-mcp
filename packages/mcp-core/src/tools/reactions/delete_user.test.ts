import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import reactionsDeleteUser from './delete_user.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';

describe('reactions_delete_user', () => {
  it('DELETEs the user-specific reaction route', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.delete(
        `${DISCORD_API}/channels/:channelId/messages/:messageId/reactions/*`,
        async () => new HttpResponse(null, { status: 204 }),
      ),
    );
    const T = reactionsDeleteUser;
    const t = new T(
      { name: 'reactions_delete_user', path: 'inline', root: 'inline', store: null as never },
      { name: 'reactions_delete_user', enabled: true },
    );
    const r = (await t.run(
      {
        channel_id: '111122223333444401',
        message_id: '999000999000999000',
        emoji: '👍',
        user_id: '111122223333444402',
      },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { deleted: boolean; user_id: string } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.deleted).toBe(true);
    expect(r.structuredContent.user_id).toBe('111122223333444402');
  });
});
