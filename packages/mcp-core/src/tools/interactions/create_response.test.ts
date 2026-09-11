import { server } from '@discord-mcp/server-mocks';
import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import interactionsCreateResponse from './create_response.js';
import '../../container.js';

const DISCORD_API = 'https://discord.com/api/v10';
const TOKEN = 'a'.repeat(70);

describe('interactions_create_response', () => {
  it.each([
    true,
    false,
  ])('forwards with_response=%s without bot authentication', async (withResponse) => {
    const response = { interaction: { id: '111111111111111111' }, resource: { type: 4 } };
    const post = vi.fn().mockResolvedValue(withResponse ? response : null);
    container.rest = { post } as unknown as REST;
    const tool = new interactionsCreateResponse(
      {
        name: 'interactions_create_response',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'interactions_create_response', enabled: true },
    );
    const result = await tool.run(
      {
        interaction_id: '111111111111111111',
        interaction_token: TOKEN,
        type: 4,
        with_response: withResponse,
      },
      { signal: new AbortController().signal },
    );
    expect(post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        auth: false,
        query: new URLSearchParams({ with_response: String(withResponse) }),
      }),
    );
    expect(result).toMatchObject({ isError: false, structuredContent: { acknowledged: true } });
    if (withResponse) expect(result.structuredContent).toMatchObject({ message: response });
  });
  it('advertises only Discord-defined interaction response types', () => {
    const metadata = (
      interactionsCreateResponse as unknown as {
        __toolMetadata: { inputSchema: Record<string, z.ZodTypeAny> };
      }
    ).__toolMetadata;
    const schema = z.object(metadata.inputSchema);

    for (const type of [1, 4, 5, 6, 7, 8, 9, 10, 12]) {
      expect(
        schema.safeParse({ interaction_id: '1'.repeat(18), interaction_token: TOKEN, type })
          .success,
      ).toBe(true);
    }
    for (const type of [2, 3, 11]) {
      expect(
        schema.safeParse({ interaction_id: '1'.repeat(18), interaction_token: TOKEN, type })
          .success,
      ).toBe(false);
    }
  });

  it('POSTs without Authorization header (token-auth) and returns acknowledged', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake-token-aaaaaa');
    let auth: string | null = 'sentinel';
    server.use(
      http.post(`${DISCORD_API}/interactions/:iid/:token/callback`, async ({ request }) => {
        auth = request.headers.get('authorization');
        const body = (await request.json()) as { type: number };
        expect(body.type).toBe(4);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const t = new interactionsCreateResponse(
      {
        name: 'interactions_create_response',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'interactions_create_response', enabled: true },
    );
    const r = (await t.run(
      {
        interaction_id: '111111111111111111',
        interaction_token: TOKEN,
        type: 4,
        data: { content: 'hi' },
      },
      { signal: new AbortController().signal },
    )) as { isError: boolean; structuredContent: { acknowledged: boolean } };
    expect(auth).toBeNull();
    expect(r.isError).toBe(false);
    expect(r.structuredContent.acknowledged).toBe(true);
  });
});
