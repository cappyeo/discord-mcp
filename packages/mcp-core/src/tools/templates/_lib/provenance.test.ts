import { describe, expect, it } from 'vitest';
import { canonicalTemplateJson, templateEvidenceDigest, templateProvenance } from './provenance.js';
import type { RawGuildTemplate } from './template.js';

const template: RawGuildTemplate = {
  code: 'audit-code',
  name: 'Untrusted name',
  description: 'Untrusted description',
  usage_count: 1,
  creator_id: '111122223333444455',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-02T00:00:00.000Z',
  source_guild_id: '999000999000999000',
  is_dirty: false,
  serialized_source_guild: {
    preferred_locale: 'en-US',
    roles: [{ id: 0, name: '@everyone', permissions: '0' }],
    channels: [{ id: 1, name: 'general', type: 0 }],
  },
};

describe('template provenance', () => {
  it('ignores canonical object key order but detects live payload changes', () => {
    const reordered: RawGuildTemplate = {
      ...template,
      serialized_source_guild: {
        channels: [{ type: 0, name: 'general', id: 1 }],
        roles: [{ permissions: '0', name: '@everyone', id: 0 }],
        preferred_locale: 'en-US',
      },
    };
    const changed: RawGuildTemplate = {
      ...template,
      serialized_source_guild: {
        ...template.serialized_source_guild,
        channels: [{ id: 1, name: 'general', type: 2 }],
      },
    };

    expect(templateEvidenceDigest(reordered)).toBe(templateEvidenceDigest(template));
    expect(templateEvidenceDigest(changed)).not.toBe(templateEvidenceDigest(template));
    expect(templateEvidenceDigest({ ...template, usage_count: 2 })).not.toBe(
      templateEvidenceDigest(template),
    );
  });

  it('binds provenance to Discord source guild metadata without exposing text or permissions', () => {
    const provenance = templateProvenance(template, '2026-08-12T01:02:03.000Z');

    expect(provenance).toMatchObject({
      evidence_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      fetched_at: '2026-08-12T01:02:03.000Z',
      source_guild: {
        id: '999000999000999000',
        snapshot_id: null,
        icon_hash: null,
        preferred_locale: 'en-US',
      },
    });
    expect(JSON.stringify(provenance)).not.toContain('Untrusted');
    expect(JSON.stringify(provenance)).not.toContain('permissions');
  });

  it('canonicalizes nested records deterministically', () => {
    expect(canonicalTemplateJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
  });
});
