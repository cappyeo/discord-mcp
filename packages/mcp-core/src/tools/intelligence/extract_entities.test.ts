import { REST } from '@discordjs/rest';
import { container } from '@sapphire/pieces';
import { describe, expect, it, vi } from 'vitest';
import extractEntities from './extract_entities.js';
import '../../container.js';

describe('intelligence_extract_entities', () => {
  it('returns extracted entities when sampling is supported', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken(
      'fake-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    const T = extractEntities;
    const t = new T(
      {
        name: 'intelligence_extract_entities',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'intelligence_extract_entities', enabled: true },
    );
    const requestSampling = vi.fn().mockResolvedValue({
      role: 'assistant',
      content: {
        type: 'text',
        text: '{"entities":[{"type":"decision","value":"Ship Plan 5 by Friday","source_message_id":"100000101795321187"},{"type":"action_item","value":"Update README","source_message_id":"100000101795322164"}]}',
      },
    });
    const r = (await t.run(
      { channel_id: '112233445566778899', limit: 50, entity_types: ['decision', 'action_item'] },
      { signal: new AbortController().signal, samplingSupported: true, requestSampling } as never,
    )) as {
      isError: boolean;
      structuredContent: {
        entities: Array<{ type: string; value: string }>;
        count: number;
        sampling_used: boolean;
      };
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.count).toBe(2);
    expect(r.structuredContent.entities[0]!.type).toBe('decision');
    expect(r.structuredContent.entities[1]!.type).toBe('action_item');
    expect(r.structuredContent.sampling_used).toBe(true);
  });

  it('falls back when sampling unsupported', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake');
    const T = extractEntities;
    const t = new T(
      {
        name: 'intelligence_extract_entities',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'intelligence_extract_entities', enabled: true },
    );
    const requestSampling = vi.fn();
    const r = (await t.run(
      { channel_id: '112233445566778899', limit: 50, entity_types: ['decision'] },
      { signal: new AbortController().signal, samplingSupported: false, requestSampling } as never,
    )) as { isError: boolean; structuredContent: { _meta?: { fallback: string } } };
    expect(r.structuredContent._meta?.fallback).toBe('host_llm_should_process');
    expect(requestSampling).not.toHaveBeenCalled();
  });

  it('handles malformed LLM response (returns empty entities)', async () => {
    container.rest = new REST({ version: '10', makeRequest: fetch }).setToken('fake');
    const T = extractEntities;
    const t = new T(
      {
        name: 'intelligence_extract_entities',
        path: 'inline',
        root: 'inline',
        store: null as never,
      },
      { name: 'intelligence_extract_entities', enabled: true },
    );
    const requestSampling = vi.fn().mockResolvedValue({
      role: 'assistant',
      content: { type: 'text', text: 'I could not extract anything.' },
    });
    const r = (await t.run(
      { channel_id: '112233445566778899', limit: 50, entity_types: ['decision'] },
      { signal: new AbortController().signal, samplingSupported: true, requestSampling } as never,
    )) as {
      isError: boolean;
      structuredContent: { entities: unknown[]; count: number; sampling_used: boolean };
    };
    expect(r.structuredContent.entities).toEqual([]);
    expect(r.structuredContent.count).toBe(0);
    expect(r.structuredContent.sampling_used).toBe(true);
  });
});
