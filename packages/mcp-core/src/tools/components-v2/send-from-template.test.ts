import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { describe, expect, it } from 'vitest';
import sendFromTemplate from './send-from-template.js';
import '../../container.js';

describe('components_v2_send_from_template', () => {
  it('applies announcement template variables and sends', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken(
      'fake-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    const T = sendFromTemplate;
    const t = new T(
      {
        name: 'components_v2_send_from_template',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'components_v2_send_from_template', enabled: true },
    );
    const r = (await t.run(
      {
        channel_id: '112233445566778899',
        template: 'announcement',
        vars: { title: 'Hello', body: 'world', cta_label: 'Click', cta_url: 'https://example.com' },
      },
      { signal: new AbortController().signal },
    )) as {
      isError: boolean;
      structuredContent: { message_id: string; template: string; jump_url: string };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.message_id).toBe('999000999000999000');
    expect(r.structuredContent.template).toBe('announcement');
    expect(r.structuredContent.jump_url).toBe(
      'https://discord.com/channels/999000999000999000/112233445566778899/999000999000999000',
    );
  });
});
