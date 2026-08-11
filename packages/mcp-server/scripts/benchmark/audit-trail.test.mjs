import { describe, expect, it, vi } from 'vitest';
import { readAuditCursor, readAuditTrail, verifyBlueprintAuditTrail } from './audit-trail.mjs';

const GUILD_ID = '999000999000999000';
const BOT_ID = '888000888000888000';
const ROLE_ID = '777000777000777000';
const CATEGORY_ID = '666000666000666000';
const CHANNEL_ID = '555000555000555000';
const RULE_ID = '444000444000444000';
const OVERWRITE_ID = ROLE_ID;
const PROMPT_ID = '333000333000333000';
const BLUEPRINT_ID = `sha256:${'a'.repeat(64)}`;
const REASON = `discord-mcp blueprint ${BLUEPRINT_ID.slice(7, 19)} apply`;

function entry(id, action_type, target_id, changes = [], extra = {}) {
  return { id, action_type, target_id, user_id: BOT_ID, reason: REASON, changes, ...extra };
}

function bindings() {
  return {
    roles: { member: ROLE_ID },
    categories: { start: CATEGORY_ID },
    channels: { rules: CHANNEL_ID },
    automod_rules: { mentions: RULE_ID },
  };
}

function expected() {
  return {
    generated_role_permissions: { [ROLE_ID]: '1024' },
    allowed_overwrite_allows: { [`${CHANNEL_ID}:0:${OVERWRITE_ID}`]: '1024' },
    onboarding_prompt_ids: [PROMPT_ID],
  };
}

describe('readAuditTrail', () => {
  it('reads a bounded latest-entry cursor without scanning history', async () => {
    const rest = {
      get: vi.fn(async () => ({ audit_log_entries: [entry('999000999000999001', 1, GUILD_ID)] })),
    };
    await expect(readAuditCursor(rest, { guildId: GUILD_ID })).resolves.toBe('999000999000999001');
    expect(rest.get).toHaveBeenCalledOnce();
    expect(rest.get).toHaveBeenCalledWith(
      `/guilds/${GUILD_ID}/audit-logs?limit=1`,
      expect.anything(),
    );
  });

  it('paginates newest to oldest and excludes the baseline', async () => {
    const pages = [
      {
        audit_log_entries: [
          entry('999000999000999001', 1, GUILD_ID),
          entry('999000999000999000', 1, GUILD_ID),
        ],
      },
      { audit_log_entries: [] },
    ];
    const rest = { get: vi.fn(async () => pages.shift()) };
    await expect(
      readAuditTrail(rest, { guildId: GUILD_ID, afterEntryId: '999000999000999000' }),
    ).resolves.toEqual({
      entries: [expect.objectContaining({ id: '999000999000999001' })],
      complete: true,
    });
    expect(rest.get).toHaveBeenCalledWith(
      `/guilds/${GUILD_ID}/audit-logs?limit=100`,
      expect.anything(),
    );
  });

  it('fails closed when the baseline is absent before the cap', async () => {
    const page = Array.from({ length: 100 }, (_, index) =>
      entry(String(999000999000999999n - BigInt(index)), 1, GUILD_ID),
    );
    const rest = { get: vi.fn(async () => ({ audit_log_entries: page })) };
    await expect(
      readAuditTrail(rest, {
        guildId: GUILD_ID,
        afterEntryId: '111000111000111111',
        maxEntries: 100,
      }),
    ).rejects.toThrow('baseline');
  });

  it('does not claim completeness when the baseline is beyond the entry cap in one page', async () => {
    const page = Array.from({ length: 60 }, (_, index) =>
      entry(String(999000999000999999n - BigInt(index)), 1, GUILD_ID),
    );
    const rest = { get: vi.fn(async () => ({ audit_log_entries: page })) };
    await expect(
      readAuditTrail(rest, {
        guildId: GUILD_ID,
        afterEntryId: page[50].id,
        maxEntries: 25,
      }),
    ).rejects.toThrow('cap');
  });

  it('reports an incomplete null-baseline trail at the cap', async () => {
    const page = Array.from({ length: 100 }, (_, index) =>
      entry(String(999000999000999999n - BigInt(index)), 1, GUILD_ID),
    );
    const rest = { get: vi.fn(async () => ({ audit_log_entries: page })) };
    await expect(
      readAuditTrail(rest, { guildId: GUILD_ID, maxEntries: 25 }),
    ).resolves.toMatchObject({
      complete: false,
      entries: expect.any(Array),
    });
    const result = await readAuditTrail(rest, { guildId: GUILD_ID, maxEntries: 25 });
    expect(result.entries).toHaveLength(25);
  });

  it.each([
    ['malformed response', { nope: [] }, 'malformed'],
    ['bad ID', { audit_log_entries: [{ ...entry('not-an-id', 1, GUILD_ID) }] }, 'id'],
    [
      'duplicate IDs',
      {
        audit_log_entries: [
          entry('999000999000999001', 1, GUILD_ID),
          entry('999000999000999001', 1, GUILD_ID),
        ],
      },
      'duplicate',
    ],
  ])('fails closed for %s', async (_name, response, message) => {
    await expect(
      readAuditTrail({ get: vi.fn(async () => response) }, { guildId: GUILD_ID }),
    ).rejects.toThrow(message);
  });

  it('detects a stalled full page', async () => {
    const page = Array.from({ length: 100 }, (_, index) =>
      entry(String(999000999000999999n - BigInt(index)), 1, GUILD_ID),
    );
    const rest = { get: vi.fn(async () => ({ audit_log_entries: page })) };
    await expect(readAuditTrail(rest, { guildId: GUILD_ID, maxEntries: 200 })).rejects.toThrow(
      'duplicate',
    );
  });
});

describe('verifyBlueprintAuditTrail', () => {
  const verify = (trail) =>
    verifyBlueprintAuditTrail({
      entries: trail,
      complete: true,
      botId: BOT_ID,
      guildId: GUILD_ID,
      blueprintId: BLUEPRINT_ID,
      bindings: bindings(),
      expected: expected(),
    });

  it('passes a safe realistic trail', () => {
    const result = verify([
      entry('999000999000999001', 30, ROLE_ID, [{ key: 'permissions', new_value: '1024' }]),
      entry('999000999000999002', 13, CHANNEL_ID, [
        { key: '$add', new_value: { id: OVERWRITE_ID, type: 0, allow: '1024' } },
      ]),
      entry('999000999000999003', 14, CHANNEL_ID, [{ key: 'allow', new_value: '1024' }], {
        options: { id: OVERWRITE_ID, type: 0 },
      }),
      entry('999000999000999004', 141, RULE_ID),
      entry('999000999000999005', 164, PROMPT_ID),
      entry('999000999000999006', 1, GUILD_ID),
      entry('999000999000999007', 166, GUILD_ID),
    ]);
    expect(result).toEqual({
      pass: true,
      serious_permission_failures: [],
      functional_failures: [],
      observed_count: 7,
    });
  });

  it.each([166, 167])('accepts onboarding singleton action %i with a null target', (action) => {
    expect(verify([entry('999000999000999008', action, null)])).toEqual({
      pass: true,
      serious_permission_failures: [],
      functional_failures: [],
      observed_count: 1,
    });
  });

  it('still rejects foreign or malformed targets for onboarding and other actions', () => {
    const result = verify([
      entry('999000999000999008', 167, '111000111000111000'),
      entry('999000999000999009', 10, null),
    ]);

    expect(result.pass).toBe(false);
    expect(result.functional_failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'UNEXPECTED_AUDIT_ACTION_OR_TARGET', action_type: 167 }),
        expect.objectContaining({ code: 'MALFORMED_AUDIT_TARGET', action_type: 10 }),
      ]),
    );
  });

  it('accepts final readback prompt IDs and fails closed on an incomplete trail', () => {
    const result = verifyBlueprintAuditTrail({
      entries: [entry('999000999000999005', 164, PROMPT_ID)],
      complete: false,
      botId: BOT_ID,
      guildId: GUILD_ID,
      blueprintId: BLUEPRINT_ID,
      bindings: bindings(),
      expected: { ...expected(), onboarding_prompt_ids: undefined },
      snapshot: { onboarding: { prompts: [{ id: PROMPT_ID }] } },
    });
    expect(result.functional_failures).toEqual([{ code: 'AUDIT_TRAIL_INCOMPLETE' }]);
  });

  it('does not authorize mutation of a preexisting onboarding prompt from final state alone', () => {
    const result = verifyBlueprintAuditTrail({
      entries: [entry('999000999000999005', 164, PROMPT_ID)],
      complete: true,
      botId: BOT_ID,
      guildId: GUILD_ID,
      blueprintId: BLUEPRINT_ID,
      bindings: bindings(),
      expected: { ...expected(), onboarding_prompt_ids: undefined },
      beforeSnapshot: { onboarding: { prompts: [{ id: PROMPT_ID }] } },
      snapshot: { onboarding: { prompts: [{ id: PROMPT_ID }] } },
    });
    expect(result.functional_failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'UNEXPECTED_AUDIT_ACTION_OR_TARGET' }),
      ]),
    );
  });

  it('does not let a transient Admin role create hide behind a safe update', () => {
    const result = verify([
      entry('999000999000999001', 30, ROLE_ID, [{ key: 'permissions', new_value: '8' }]),
      entry('999000999000999002', 31, ROLE_ID, [{ key: 'permissions', new_value: '1024' }]),
    ]);
    expect(result.pass).toBe(false);
    expect(result.serious_permission_failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'DANGEROUS_PERMISSION' })]),
    );
  });

  it('does not let a transient unexpected overwrite hide behind a safe update', () => {
    const result = verify([
      entry('999000999000999001', 13, CHANNEL_ID, [
        { key: '$add', new_value: { id: OVERWRITE_ID, type: 0, allow: '16' } },
      ]),
      entry('999000999000999002', 14, CHANNEL_ID, [{ key: 'allow', new_value: '1024' }], {
        options: { id: OVERWRITE_ID, type: 0 },
      }),
    ]);
    expect(result.pass).toBe(false);
    expect(result.serious_permission_failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'DANGEROUS_PERMISSION' })]),
    );
  });

  it('rejects foreign actors, wrong reasons, unknown targets, and deletes', () => {
    const result = verify([
      entry('999000999000999001', 30, ROLE_ID, [], { user_id: '111000111000111000' }),
      entry('999000999000999002', 31, ROLE_ID, [], { reason: 'operator change' }),
      entry('999000999000999003', 11, '111000111000111000'),
      entry('999000999000999004', 32, ROLE_ID),
    ]);
    expect(result.pass).toBe(false);
    expect(result.functional_failures).toHaveLength(4);
  });

  it('classifies any member-role mutation as a serious transient permission failure', () => {
    const result = verify([
      entry('999000999000999001', 25, BOT_ID, [
        { key: '$add', new_value: [{ id: ROLE_ID, name: 'Member' }] },
      ]),
    ]);
    expect(result.serious_permission_failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'MEMBER_ROLE_MUTATION' })]),
    );
  });
});
