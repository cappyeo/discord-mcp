import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { resolveApplicationId } from './application.js';

const DISCORD_API = 'https://discord.com/api/v10';
const APPLICATION_ID = '111122223333444401';

describe('resolveApplicationId', () => {
  it('keeps an explicit application ID without a lookup', async () => {
    const get = async () => {
      throw new Error('unexpected Discord request');
    };
    const rest = { get } as unknown as REST;
    await expect(resolveApplicationId(rest, APPLICATION_ID)).resolves.toBe(APPLICATION_ID);
  });

  it('resolves the authenticated bot application and caches the result', async () => {
    const rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    let requests = 0;
    server.use(
      http.get(`${DISCORD_API}/applications/@me`, () => {
        requests += 1;
        return HttpResponse.json({ id: APPLICATION_ID });
      }),
    );

    await expect(resolveApplicationId(rest, undefined)).resolves.toBe(APPLICATION_ID);
    await expect(resolveApplicationId(rest, undefined)).resolves.toBe(APPLICATION_ID);
    expect(requests).toBe(1);
  });

  it('fails closed when the current application response is malformed', async () => {
    const rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    server.use(
      http.get(`${DISCORD_API}/applications/@me`, () =>
        HttpResponse.json({ id: 'not-a-snowflake' }),
      ),
    );
    await expect(resolveApplicationId(rest, undefined)).rejects.toThrow(/invalid application ID/);
  });
});
