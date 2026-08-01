import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { describe, expect, it, vi } from 'vitest';
import draftResponse from './draft_response.js';
import '../../container.js';

describe('intelligence_draft_response', () => {
  it('returns draft when sampling is supported (does NOT post to Discord)', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken(
      'fake-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    const T = draftResponse;
    const t = new T(
      { name: 'intelligence_draft_response', path: 'inline', root: 'inline', store: null as never },
      { name: 'intelligence_draft_response', enabled: true },
    );
    const requestSampling = vi.fn().mockResolvedValue({
      role: 'assistant',
      content: {
        type: 'text',
        text: '{"draft":"Hi! Sure thing - happy to help.","reasoning":"Friendly tone, opens door for follow-up."}',
      },
    });
    const r = (await t.run(
      {
        channel_id: '112233445566778899',
        context_message_count: 10,
        intent: 'Answer their question politely',
        tone: 'friendly',
      },
      { signal: new AbortController().signal, samplingSupported: true, requestSampling } as never,
    )) as {
      isError: boolean;
      structuredContent: { draft: string; reasoning: string; sampling_used: boolean };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.draft).toContain('happy to help');
    expect(r.structuredContent.reasoning).toContain('Friendly');
    expect(r.structuredContent.sampling_used).toBe(true);
  });

  it('falls back with raw context + intent when sampling unsupported', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake');
    const T = draftResponse;
    const t = new T(
      { name: 'intelligence_draft_response', path: 'inline', root: 'inline', store: null as never },
      { name: 'intelligence_draft_response', enabled: true },
    );
    const requestSampling = vi.fn();
    const r = (await t.run(
      {
        channel_id: '112233445566778899',
        context_message_count: 10,
        intent: 'Welcome them',
        tone: 'friendly',
      },
      { signal: new AbortController().signal, samplingSupported: false, requestSampling } as never,
    )) as {
      isError: boolean;
      structuredContent: { _meta?: { fallback: string }; intent?: string };
    };
    expect(r.structuredContent._meta?.fallback).toBe('host_llm_should_process');
    expect(requestSampling).not.toHaveBeenCalled();
  });

  it('handles malformed LLM JSON (returns raw text as draft, empty reasoning)', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake');
    const T = draftResponse;
    const t = new T(
      { name: 'intelligence_draft_response', path: 'inline', root: 'inline', store: null as never },
      { name: 'intelligence_draft_response', enabled: true },
    );
    const requestSampling = vi.fn().mockResolvedValue({
      role: 'assistant',
      content: { type: 'text', text: 'Hey! Welcome aboard 👋' },
    });
    const r = (await t.run(
      {
        channel_id: '112233445566778899',
        context_message_count: 5,
        intent: 'Welcome',
        tone: 'friendly',
      },
      { signal: new AbortController().signal, samplingSupported: true, requestSampling } as never,
    )) as {
      isError: boolean;
      structuredContent: { draft: string; reasoning: string; sampling_used: boolean };
    };
    expect(r.structuredContent.draft).toContain('Welcome aboard');
    expect(r.structuredContent.reasoning).toBe('');
    expect(r.structuredContent.sampling_used).toBe(true);
  });
});
