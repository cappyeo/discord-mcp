import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { describe, expect, it, vi } from 'vitest';
import componentsV2Edit from './edit.js';
import '../../container.js';

describe('components_v2_edit', () => {
  it('rejects invalid components before editing a Discord message', async () => {
    const patch = vi.fn();
    container.rest = { patch } as unknown as REST;
    const tool = new componentsV2Edit(
      { name: 'components_v2_edit', path: 'inline', root: 'inline', store: null as never },
      { name: 'components_v2_edit', enabled: true },
    );
    await expect(
      tool.run(
        {
          channel_id: '111122223333444455',
          message_id: '999000999000999000',
          components: [{ type: 10, content: '' }],
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(patch).not.toHaveBeenCalled();
  });
  it('edits with V2 flag set', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken(
      'fake-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    const T = componentsV2Edit;
    const t = new T(
      { name: 'components_v2_edit', path: 'inline', root: 'inline', store: null as never },
      { name: 'components_v2_edit', enabled: true },
    );
    const r = (await t.run(
      {
        channel_id: '111122223333444455',
        message_id: '999000999000999000',
        components: [{ type: 10, content: 'updated' }],
      },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { message_id: string; edited_timestamp: string } };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.message_id).toBe('999000999000999000');
  });
});
