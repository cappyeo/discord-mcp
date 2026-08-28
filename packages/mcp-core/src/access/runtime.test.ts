import { PermissionFlagsBits } from 'discord-api-types/v10';
import { describe, expect, it } from 'vitest';
import {
  evaluateRuntimeAccess,
  type RuntimeAccessRequest,
  runtimeAccessRequirement,
  runtimeAccessRequirementForArgs,
} from './runtime.js';

const request: RuntimeAccessRequest = {
  toolName: 'messages_send',
  args: { channel_id: '111122223333444455' },
  requirement: {
    auth: 'bot',
    permissions: ['VIEW_CHANNEL', 'SEND_MESSAGES'],
    intents: [],
    scope: 'channel',
    hierarchy: 'not_applicable',
  },
  expectedBotId: '999999999999999999',
};

describe('runtime access evaluation', () => {
  it('allows only complete identity-matched evidence with all declared permissions', () => {
    expect(
      evaluateRuntimeAccess(request, {
        status: 'complete',
        identityVerified: true,
        botId: request.expectedBotId,
        effectivePermissions: PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages,
      }).status,
    ).toBe('allowed');
  });

  it('does not treat partial or missing permission bits as allowed', () => {
    expect(
      evaluateRuntimeAccess(request, {
        status: 'partial',
        identityVerified: true,
        botId: request.expectedBotId,
        effectivePermissions: PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages,
      }).status,
    ).toBe('unknown');
    const denied = evaluateRuntimeAccess(request, {
      status: 'complete',
      identityVerified: true,
      botId: request.expectedBotId,
      effectivePermissions: PermissionFlagsBits.ViewChannel,
    });
    expect(denied.status).toBe('denied');
    expect(denied.missingPermissions).toEqual(['SEND_MESSAGES']);
  });

  it('rejects an identity mismatch and unknown intent evidence', () => {
    expect(
      evaluateRuntimeAccess(request, {
        status: 'complete',
        identityVerified: true,
        botId: '888888888888888888',
        effectivePermissions: PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages,
      }).status,
    ).toBe('denied');
    const intentRequest = {
      ...request,
      requirement: { ...request.requirement, intents: ['GUILD_MEMBERS'] as const },
    };
    expect(
      evaluateRuntimeAccess(intentRequest, {
        status: 'complete',
        identityVerified: true,
        botId: request.expectedBotId,
        effectivePermissions: PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages,
        intents: { GUILD_MEMBERS: 'unknown' },
      }),
    ).toMatchObject({ status: 'unknown', missingIntents: [] });
    expect(
      evaluateRuntimeAccess(intentRequest, {
        status: 'complete',
        identityVerified: true,
        botId: request.expectedBotId,
        effectivePermissions: PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages,
        intents: { GUILD_MEMBERS: 'missing' },
      }),
    ).toMatchObject({ status: 'denied', missingIntents: ['GUILD_MEMBERS'] });
  });

  it('does not allow a hierarchy-sensitive operation without explicit hierarchy evidence', () => {
    const hierarchyRequest = {
      ...request,
      requirement: { ...request.requirement, hierarchy: 'required' as const },
    };
    expect(
      evaluateRuntimeAccess(hierarchyRequest, {
        status: 'complete',
        identityVerified: true,
        botId: request.expectedBotId,
        effectivePermissions: PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages,
      }),
    ).toMatchObject({ status: 'unknown', hierarchy: 'unknown' });
    expect(
      evaluateRuntimeAccess(hierarchyRequest, {
        status: 'complete',
        identityVerified: true,
        botId: request.expectedBotId,
        effectivePermissions: PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages,
        hierarchy: 'not_satisfied',
      }),
    ).toMatchObject({ status: 'denied', hierarchy: 'not_satisfied' });
    expect(
      evaluateRuntimeAccess(hierarchyRequest, {
        status: 'complete',
        identityVerified: true,
        botId: request.expectedBotId,
        effectivePermissions: PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages,
        hierarchy: 'satisfied',
      }).status,
    ).toBe('allowed');
  });

  it('resolves the central and field-aware requirement helpers', () => {
    expect(runtimeAccessRequirement('messages_send')).toMatchObject({ scope: 'channel' });
    expect(runtimeAccessRequirement('future_tool')).toBeNull();
    expect(runtimeAccessRequirementForArgs('members_modify', { nick: 'mod' })).toMatchObject({
      permissions: ['MANAGE_NICKNAMES'],
      hierarchy: 'required',
    });
  });
});
