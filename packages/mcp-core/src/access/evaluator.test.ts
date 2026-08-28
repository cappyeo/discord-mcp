import { describe, expect, it } from 'vitest';
import { evaluateBotPermissions } from './evaluator.js';

const GUILD_ID = '111122223333444455';
const BOT_ID = '999988887777666601';
const ROLE_ID = '999988887777666602';

const everyone = {
  id: GUILD_ID,
  name: '@everyone',
  position: 0,
  permissions: '1024',
  managed: false,
};

describe('evaluateBotPermissions', () => {
  it('fails closed when Discord omits the @everyone role', () => {
    expect(() =>
      evaluateBotPermissions({
        guildId: GUILD_ID,
        roles: [],
        member: { id: BOT_ID, roles: [] },
      }),
    ).toThrow('@everyone');
  });

  it('unions the bot role permissions and reports its highest role', () => {
    const result = evaluateBotPermissions({
      guildId: GUILD_ID,
      roles: [
        everyone,
        { ...everyone, id: ROLE_ID, name: 'Bot', position: 4, permissions: '2048' },
      ],
      member: { id: BOT_ID, roles: [ROLE_ID] },
    });

    expect(result.basePermissions).toBe(3072n);
    expect(result.effectivePermissions).toBe(3072n);
    expect(result.topRoleId).toBe(ROLE_ID);
    expect(result.confidence).toBe('complete');
  });

  it('keeps missing role IDs and unknown permission bits as partial evidence', () => {
    const result = evaluateBotPermissions({
      guildId: GUILD_ID,
      roles: [everyone, { ...everyone, id: ROLE_ID, name: 'Bot', position: 4, permissions: '1' }],
      member: { id: BOT_ID, roles: [ROLE_ID, '999988887777666603'] },
    });

    expect(result.missingRoleIds).toEqual(['999988887777666603']);
    expect(result.unknownPermissionBits).toBe(0n);
    expect(result.confidence).toBe('partial');
  });

  it('applies channel overwrites after guild role permissions', () => {
    const result = evaluateBotPermissions({
      guildId: GUILD_ID,
      roles: [
        everyone,
        { ...everyone, id: ROLE_ID, name: 'Bot', position: 4, permissions: '2048' },
      ],
      member: { id: BOT_ID, roles: [ROLE_ID] },
      channel: {
        id: '111122223333444466',
        guild_id: GUILD_ID,
        type: 0,
        permission_overwrites: [
          { id: GUILD_ID, type: 0, allow: '0', deny: '2048' },
          { id: BOT_ID, type: 1, allow: '2048', deny: '0' },
        ],
      },
    });

    expect(result.permissionSourceChannelId).toBe('111122223333444466');
    expect(result.effectivePermissions & 2048n).toBe(2048n);
    expect(result.confidence).toBe('complete');
  });

  it('treats administrator as bypassing channel overwrites', () => {
    const result = evaluateBotPermissions({
      guildId: GUILD_ID,
      roles: [everyone, { ...everyone, id: ROLE_ID, name: 'Bot', position: 4, permissions: '8' }],
      member: { id: BOT_ID, roles: [ROLE_ID] },
      channel: {
        id: '111122223333444466',
        guild_id: GUILD_ID,
        type: 0,
        permission_overwrites: [{ id: GUILD_ID, type: 0, allow: '0', deny: '8' }],
      },
    });

    expect(result.administrator).toBe(true);
    expect(result.effectivePermissions & 8n).toBe(8n);
    expect(result.confidence).toBe('complete');
  });

  it('keeps channel access partial when overwrites are not returned', () => {
    const result = evaluateBotPermissions({
      guildId: GUILD_ID,
      roles: [everyone],
      member: { id: BOT_ID, roles: [] },
      channel: {
        id: '111122223333444466',
        guild_id: GUILD_ID,
        type: 0,
      },
    });
    expect(result.permissionSourceChannelId).toBe('111122223333444466');
    expect(result.confidence).toBe('partial');
  });
});
