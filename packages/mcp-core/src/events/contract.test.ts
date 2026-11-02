import { describe, expect, it } from 'vitest';
import { verifyCallback } from './callback.js';
import { directlyMentions, eventDefinition, mentionDefinition } from './contract.js';

const bot = '111122223333444481';
const guild = '111122223333444482';

describe('event discovery and trigger contracts', () => {
  it('requires both the actual bot mention token and the provider mention list', () => {
    expect(directlyMentions(`<@${bot}> hi`, [bot], bot)).toBe(true);
    expect(directlyMentions(`<@!${bot}> hi`, [bot], bot)).toBe(true);
    for (const content of ['ordinary reply', '@everyone', `<@&${bot}>`, `<@${guild}>`]) {
      expect(directlyMentions(content, [bot], bot)).toBe(false);
    }
    expect(directlyMentions(`<@${bot}>`, [], bot)).toBe(false);
  });

  it('publishes discovery schemas bound to the authorized author, guild and bot', () => {
    expect(eventDefinition(bot).inputSchema).toMatchObject({
      properties: { author_id: { const: bot } },
    });
    const mention = mentionDefinition(guild, bot);
    expect(mention.inputSchema).toMatchObject({ properties: { guild_id: { const: guild } } });
    expect(mention.payloadSchema).toMatchObject({
      properties: { guild_id: { const: guild }, mentioned_bot_id: { const: bot } },
    });
  });

  it('accepts only the exact fresh callback challenge before enabling delivery', async () => {
    const sub = {
      id: 'sub_test',
      url: 'https://callback.example.test/events',
      secret: `whsec_${Buffer.alloc(32, 7).toString('base64')}`,
    };
    await expect(
      verifyCallback(
        async (_url, body) => ({
          status: 200,
          body: JSON.stringify({ challenge: JSON.parse(body).challenge }),
        }),
        sub,
      ),
    ).resolves.toBeUndefined();
    await expect(
      verifyCallback(
        async () => ({ status: 200, body: JSON.stringify({ challenge: 'x'.repeat(36) }) }),
        sub,
      ),
    ).rejects.toThrow('rejected');
  });
});
