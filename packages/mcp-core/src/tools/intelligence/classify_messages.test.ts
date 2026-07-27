import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { describe, expect, it, vi } from 'vitest';
import classifyMessages from './classify_messages.js';
import '../../container.js';

describe('intelligence_classify_messages', () => {
  it('returns classifications when sampling is supported', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken(
      'fake-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    const T = classifyMessages;
    const t = new T(
      {
        name: 'intelligence_classify_messages',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'intelligence_classify_messages', enabled: true },
    );
    const requestSampling = vi.fn().mockResolvedValue({
      role: 'assistant',
      content: {
        type: 'text',
        text: '{"classifications":[{"message_id":"100000101795321187","author":"user1","category":"greeting","confidence":0.9},{"message_id":"100000101795322164","author":"user2","category":"question","confidence":0.7},{"message_id":"100000101795323141","author":"user3","category":"greeting","confidence":0.85}]}',
      },
    });
    const r = (await t.run(
      { channel_id: '112233445566778899', categories: ['greeting', 'question', 'spam'], limit: 25 },
      { signal: new AbortController().signal, samplingSupported: true, requestSampling } as never,
    )) as {
      isError: boolean;
      structuredContent: {
        classifications: Array<{ message_id: string; category: string; confidence: number }>;
        count: number;
        sampling_used: boolean;
      };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.count).toBe(3);
    expect(r.structuredContent.classifications[0]!.category).toBe('greeting');
    expect(r.structuredContent.sampling_used).toBe(true);
  });

  it('falls back with raw messages + categories when sampling unsupported', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake');
    const T = classifyMessages;
    const t = new T(
      {
        name: 'intelligence_classify_messages',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'intelligence_classify_messages', enabled: true },
    );
    const requestSampling = vi.fn();
    const r = (await t.run(
      { channel_id: '112233445566778899', categories: ['greeting', 'question'], limit: 25 },
      { signal: new AbortController().signal, samplingSupported: false, requestSampling } as never,
    )) as { isError: boolean; structuredContent: { _meta?: { fallback: string } } };
    expect(r.structuredContent._meta?.fallback).toBe('host_llm_should_process');
    expect(requestSampling).not.toHaveBeenCalled();
  });

  it('handles malformed LLM response (returns empty classifications)', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake');
    const T = classifyMessages;
    const t = new T(
      {
        name: 'intelligence_classify_messages',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'intelligence_classify_messages', enabled: true },
    );
    const requestSampling = vi.fn().mockResolvedValue({
      role: 'assistant',
      content: { type: 'text', text: 'I cannot classify these in JSON.' },
    });
    const r = (await t.run(
      { channel_id: '112233445566778899', categories: ['a', 'b'], limit: 10 },
      { signal: new AbortController().signal, samplingSupported: true, requestSampling } as never,
    )) as {
      isError: boolean;
      structuredContent: { classifications: unknown[]; sampling_used: boolean; count: number };
    };
    expect(r.structuredContent.classifications).toEqual([]);
    expect(r.structuredContent.count).toBe(0);
    expect(r.structuredContent.sampling_used).toBe(true);
  });
});
