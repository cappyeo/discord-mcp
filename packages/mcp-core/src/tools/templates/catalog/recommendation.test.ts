import { describe, expect, it } from 'vitest';
import type { CatalogRecord } from './index.js';
import {
  retrieveMetadataCandidates,
  selectTemplatePortfolio,
  type TemplateLiveEvidence,
} from './recommendation.js';

function record(
  code: string,
  name: string,
  tags: readonly string[],
  description: string | null = null,
  usage_count = 0,
): CatalogRecord {
  return {
    source_guild_id: `${code.padEnd(17, '0').slice(0, 17)}`,
    code,
    availability: 'active',
    name,
    description,
    usage_count,
    tags,
  };
}

function evidence(
  code: string,
  overrides: Partial<TemplateLiveEvidence> = {},
): TemplateLiveEvidence {
  return {
    code,
    verified: true,
    code_match: true,
    is_dirty: false,
    blueprint: {
      channel_count: 12,
      category_count: 3,
      text_channel_count: 7,
      voice_channel_count: 2,
      forum_channel_count: 0,
      stage_channel_count: 0,
      role_count: 5,
      privileged_role_count: 0,
      risky_permission_signals: [],
    },
    ...overrides,
  };
}

describe('catalog recommendation engine', () => {
  it('retrieves Vietnamese gaming and LFG intent deterministically', () => {
    const result = retrieveMetadataCandidates(
      [
        record('gaming-lfg', 'Gaming cộng đồng', ['gaming', 'lfg'], 'Tìm đồng đội và chơi game'),
        record('music', 'Music lounge', ['music'], 'Phòng nghe nhạc'),
      ],
      'Server chơi game Việt Nam, tìm đồng đội và phòng voice',
    );

    expect(result.status).toBe('ready');
    expect(result.requested_capabilities).toEqual(['gaming', 'lfg', 'voice']);
    expect(result.candidates[0]?.record.code).toBe('gaming-lfg');
    expect(result.candidates[0]?.matched_capabilities).toEqual(['gaming', 'lfg']);
    expect(result.candidates[0]?.score_breakdown.usage).toBeLessThanOrEqual(5);
  });

  it('does not let popularity beat a better intent fit', () => {
    const result = retrieveMetadataCandidates(
      [
        record('fit', 'Gaming LFG', ['gaming', 'lfg'], 'Tìm team', 1),
        record('popular', 'Community', ['community'], 'Nơi trò chuyện', 1_000_000),
      ],
      'gaming lfg',
    );

    expect(result.candidates[0]?.record.code).toBe('fit');
    expect(
      result.candidates.find((candidate) => candidate.record.code === 'popular'),
    ).toBeUndefined();
  });

  it('returns no_match for an unrecognized request with no lexical match', () => {
    const result = retrieveMetadataCandidates(
      [record('gaming', 'Gaming Server', ['gaming'])],
      'một ý tưởng hoàn toàn không liên quan',
    );

    expect(result).toEqual({
      status: 'no_match',
      requested_capabilities: [],
      candidates: [],
      reasons: ['No recognized capability or catalog lexical match.'],
    });
  });

  it('returns no_match when a recognized intent has no matching catalog record', () => {
    const result = retrieveMetadataCandidates(
      [record('music', 'Music lounge', ['music'], 'Songs and listening')],
      'gaming lfg',
    );

    expect(result.status).toBe('no_match');
    expect(result.candidates).toEqual([]);
  });

  it('does not let an incidental lexical token bypass a recognized intent', () => {
    const result = retrieveMetadataCandidates(
      [record('incidental', 'Professional xyz', ['music'], 'xyz only')],
      'gaming xyz',
    );

    expect(result.status).toBe('no_match');
  });

  it('requires a meaningful boundary-aware lexical match for long-tail requests', () => {
    const result = retrieveMetadataCandidates(
      [record('tiny', '.h', ['community']), record('pokemon', 'Pokemon guild', ['community'])],
      'pokemon server',
    );

    expect(result.candidates.map((candidate) => candidate.record.code)).toEqual(['pokemon']);
    expect(
      retrieveMetadataCandidates([record('tiny', '.h', ['community'])], 'such intent').status,
    ).toBe('no_match');
  });

  it('recognizes technology communities instead of collapsing them into generic community', () => {
    const result = retrieveMetadataCandidates(
      [
        record('generic', 'Community', ['community'], 'Chat together', 10_000),
        record('tech', 'Open source developer community', ['coding', 'community'], 'Technology'),
      ],
      'technology community',
    );

    expect(result.requested_capabilities).toEqual(['community', 'technology']);
    expect(result.candidates[0]?.record.code).toBe('tech');
  });

  it('weights name and description evidence above tag-only placeholder metadata', () => {
    const result = retrieveMetadataCandidates(
      [
        record('placeholder', 'Hjew', ['art', 'music'], null, 100_000),
        record('clear', 'Community of artists and musicians', ['community'], 'Art and music'),
      ],
      'art music',
    );

    expect(result.candidates[0]?.record.code).toBe('clear');
  });

  it('excludes deleted records and handles missing descriptions', () => {
    const deleted = {
      ...record('gone', 'Gaming gone', ['gaming']),
      availability: 'deleted' as const,
      code: null,
    };
    const result = retrieveMetadataCandidates(
      [deleted, record('live', 'Gaming live', ['gaming'])],
      'gaming',
    );

    expect(result.candidates.map((candidate) => candidate.record.code)).toEqual(['live']);
    expect(result.candidates[0]?.reasons.join(' ')).toContain('description is missing');
  });

  it('uses stable code tie-breaks', () => {
    const records = [record('zeta', 'Gaming', ['gaming']), record('alpha', 'Gaming', ['gaming'])];
    const first = retrieveMetadataCandidates(records, 'gaming');
    const second = retrieveMetadataCandidates([...records].reverse(), 'gaming');
    expect(first.candidates.map((item) => item.record.code)).toEqual(['alpha', 'zeta']);
    expect(first.candidates.map((item) => item.record.code)).toEqual(
      second.candidates.map((item) => item.record.code),
    );
  });

  it('selects a strict primary and diverse inspirations by marginal gain', () => {
    const retrieval = retrieveMetadataCandidates(
      [
        record('primary', 'Gaming LFG', ['gaming', 'lfg'], 'Gaming team'),
        record('platform', 'Gaming platforms', ['platform'], 'PC mobile console'),
        record('voice', 'Voice and forum', ['voice', 'forum'], 'Voice forum'),
        record('duplicate', 'More gaming', ['gaming'], 'Gaming only'),
      ],
      'gaming lfg platform voice forum',
    );
    const portfolio = selectTemplatePortfolio(
      retrieval.candidates,
      [
        evidence('primary'),
        evidence('platform', {
          blueprint: {
            ...evidence('platform').blueprint,
            role_count: 7,
            text_channel_count: 10,
          },
        }),
        evidence('voice', {
          blueprint: {
            ...evidence('voice').blueprint,
            voice_channel_count: 4,
            forum_channel_count: 2,
          },
        }),
        evidence('duplicate'),
      ],
      {
        preferred_primary_code: 'primary',
        requested_capabilities: retrieval.requested_capabilities,
      },
    );

    expect(portfolio.status).toBe('ready');
    expect(portfolio.primary?.record.code).toBe('primary');
    expect(portfolio.inspirations.map((item) => item.record.code)).toEqual(['voice', 'platform']);
    expect(portfolio.inspirations).not.toContainEqual(
      expect.objectContaining({ record: { code: 'duplicate' } }),
    );
  });

  it('gates unverified, dirty, and undersized templates in strict mode', () => {
    const retrieval = retrieveMetadataCandidates(
      [record('bad', 'Gaming', ['gaming']), record('good', 'Gaming', ['gaming'])],
      'gaming',
    );
    const result = selectTemplatePortfolio(
      retrieval.candidates,
      [
        evidence('bad', {
          verified: false,
          is_dirty: true,
          blueprint: { ...evidence('bad').blueprint, channel_count: 1 },
          risky_permission_signals: ['ADMINISTRATOR'],
        }),
        evidence('good'),
      ],
      { requested_capabilities: retrieval.requested_capabilities },
    );

    expect(result.primary?.record.code).toBe('good');
    expect(result.rejected.map((item) => item.code)).toEqual(['bad']);
    expect(result.rejected[0]?.reasons.join(' ')).toMatch(/unverified|dirty|minimum/i);
  });

  it('pins a valid preferred primary', () => {
    const retrieval = retrieveMetadataCandidates(
      [record('alpha', 'Gaming', ['gaming'], 'A'), record('beta', 'Gaming', ['gaming'], 'B')],
      'gaming',
    );
    const result = selectTemplatePortfolio(
      retrieval.candidates,
      [evidence('alpha'), evidence('beta')],
      { preferred_primary_code: 'beta' },
    );
    expect(result.primary?.record.code).toBe('beta');
  });

  it('penalizes source permission risk and unknown dirtiness while rejecting actual dirty, NSFW, and bloat', () => {
    const retrieval = retrieveMetadataCandidates(
      [
        record('manage', 'Gaming', ['gaming']),
        record('unknown-dirty', 'Gaming', ['gaming']),
        record('dirty', 'Gaming', ['gaming']),
        record('nsfw', 'Gaming', ['gaming']),
        record('bloated', 'Gaming', ['gaming']),
        record('safe', 'Gaming', ['gaming']),
      ],
      'gaming',
    );
    const result = selectTemplatePortfolio(
      retrieval.candidates,
      [
        evidence('manage', { risky_permission_signals: ['MANAGE_ROLES'] }),
        evidence('unknown-dirty', { is_dirty: null }),
        evidence('dirty', { is_dirty: true }),
        evidence('nsfw', {
          blueprint: { ...evidence('nsfw').blueprint, nsfw_channel_count: 1 },
        }),
        evidence('bloated', {
          blueprint: { ...evidence('bloated').blueprint, channel_count: 200 },
        }),
        evidence('safe'),
      ],
      { requested_capabilities: retrieval.requested_capabilities },
    );

    expect(result.primary?.record.code).toBe('safe');
    expect(result.rejected.map((candidate) => candidate.code).sort()).toEqual([
      'bloated',
      'dirty',
      'nsfw',
    ]);
    expect(result.rejected.map((candidate) => candidate.code)).not.toContain('manage');
    expect(result.rejected.map((candidate) => candidate.code)).not.toContain('unknown-dirty');
  });

  it('requires a real text channel and a custom role', () => {
    const retrieval = retrieveMetadataCandidates([record('weak', 'Gaming', ['gaming'])], 'gaming');
    const result = selectTemplatePortfolio(
      retrieval.candidates,
      [
        evidence('weak', {
          blueprint: { channel_count: 3, other_channel_count: 3, role_count: 1 },
        }),
      ],
      { requested_capabilities: retrieval.requested_capabilities },
    );

    expect(result.status).toBe('no_match');
    expect(result.rejected[0]?.reasons).toContain('Template fails minimum viable structure.');
  });

  it('uses trusted live capabilities in the final intent score', () => {
    const retrieval = retrieveMetadataCandidates(
      [
        record('metadata-only', 'Gaming event', ['gaming'], 'A gaming server'),
        record('live-match', 'Gaming', ['gaming'], 'A gaming server'),
      ],
      'gaming events',
    );
    const result = selectTemplatePortfolio(
      retrieval.candidates,
      [evidence('metadata-only'), evidence('live-match', { capabilities: ['events'] })],
      { requested_capabilities: retrieval.requested_capabilities },
    );

    expect(result.primary?.record.code).toBe('live-match');
    expect(result.primary?.effective_capabilities).toContain('events');
  });

  it('lets verified live structure outweigh weaker metadata within comparable intent', () => {
    const retrieval = retrieveMetadataCandidates(
      [
        record('metadata-rich', 'Gaming', ['gaming'], 'A complete gaming community'),
        record('structure-rich', 'Gaming', ['gaming']),
      ],
      'gaming',
    );
    const result = selectTemplatePortfolio(
      retrieval.candidates,
      [
        evidence('metadata-rich', {
          blueprint: { channel_count: 3, text_channel_count: 1, role_count: 2 },
        }),
        evidence('structure-rich', {
          blueprint: {
            channel_count: 20,
            category_count: 5,
            text_channel_count: 10,
            voice_channel_count: 4,
            forum_channel_count: 2,
            role_count: 8,
          },
        }),
      ],
      { requested_capabilities: retrieval.requested_capabilities },
    );

    expect(result.primary?.record.code).toBe('structure-rich');
    expect(result.primary?.portfolio_score_breakdown.structural_quality).toBeGreaterThan(
      result.inspirations[0]?.portfolio_score_breakdown.structural_quality ?? 0,
    );
  });
});
