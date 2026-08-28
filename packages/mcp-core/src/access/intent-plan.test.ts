import { describe, expect, it } from 'vitest';
import { planDiscordIntent } from './intent-plan.js';

describe('planDiscordIntent', () => {
  it('normalizes the bounded lock, announce, verify workflow deterministically', () => {
    const request = {
      intent: 'lock channel and announce',
      guild_id: '100000000000000001',
      channel_id: '200000000000000002',
      announcement: 'Read-only maintenance notice',
      allow: '0',
      deny: '2048',
    };
    const first = planDiscordIntent(request);
    const second = planDiscordIntent(request);
    expect(first).toEqual(second);
    expect(first.status).toBe('ready');
    expect(first.steps.map((step) => step.tool)).toEqual([
      'channels_modify_permissions',
      'messages_send',
      'permissions_audit_channel',
    ]);
    expect(first.access.permissions).toContain('MANAGE_ROLES');
    expect(first.access.permissions).toContain('SEND_MESSAGES');
    expect(first.steps[0]?.args).toMatchObject({ allow: '0', deny: '2048' });
    expect(first.steps[1]?.depends_on).toEqual(['lock-channel']);
    expect(first.steps[2]?.depends_on).toEqual(['lock-channel', 'announce']);
    expect(first.steps.map((step) => step.requires_approval)).toEqual([true, true, false]);
    expect(first.approval_boundary).toBe('per_write');
    expect(first.verification_step_id).toBe('verify-channel');
    expect(first.plan_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('does not guess permission bits for a lock intent', () => {
    const plan = planDiscordIntent({
      intent: 'lock_channel',
      guild_id: '100000000000000001',
      channel_id: '200000000000000002',
    });
    expect(plan.status).toBe('needs_input');
    expect(plan.steps).toHaveLength(0);
  });

  it('rejects malformed permission bitfields without producing a write step', () => {
    const plan = planDiscordIntent({
      intent: 'lock_channel',
      guild_id: '100000000000000001',
      channel_id: '200000000000000002',
      allow: 'not-a-bitfield',
    });
    expect(plan.status).toBe('needs_input');
    expect(plan.steps).toHaveLength(0);
  });

  it('rejects overlapping allow and deny bitfields', () => {
    const plan = planDiscordIntent({
      intent: 'lock_channel',
      guild_id: '100000000000000001',
      channel_id: '200000000000000002',
      allow: '1024',
      deny: '1024',
    });
    expect(plan.status).toBe('needs_input');
    expect(plan.steps).toHaveLength(0);
  });

  it('keeps a single announce intent executable only after text is supplied', () => {
    const plan = planDiscordIntent({
      intent: 'announce',
      guild_id: '100000000000000001',
      channel_id: '200000000000000002',
      announcement: 'Maintenance starts soon',
    });
    expect(plan.status).toBe('ready');
    expect(plan.steps.map((step) => step.tool)).toEqual(['messages_send']);
  });

  it('accepts the bounded Vietnamese intent aliases without broad guessing', () => {
    const plan = planDiscordIntent({
      intent: 'khóa kênh và thông báo',
      guild_id: '100000000000000001',
      channel_id: '200000000000000002',
      announcement: 'Bảo trì',
      deny: '1024',
    });
    expect(plan.status).toBe('ready');
    expect(plan.intent).toBe('lock_and_announce');
  });

  it('fails closed for unsupported natural language', () => {
    const plan = planDiscordIntent({
      intent: 'make it awesome',
      guild_id: '100000000000000001',
      channel_id: '200000000000000002',
    });
    expect(plan.status).toBe('unsupported');
    expect(plan.steps).toHaveLength(0);
    expect(plan.plan_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
