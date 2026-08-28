import { describe, expect, it } from 'vitest';
import IntentPlanTool from './discord_intent_plan.js';

describe('discord_intent_plan tool', () => {
  it('returns a schema-valid read-only plan without invoking Discord', async () => {
    const tool = new IntentPlanTool({} as never);
    const result = (await tool.run({
      intent: 'verify',
      guild_id: '100000000000000001',
      channel_id: '200000000000000002',
    })) as { structuredContent: { status: string; steps: unknown[]; plan_digest: string } };
    expect(result.structuredContent.status).toBe('ready');
    expect(result.structuredContent.steps).toHaveLength(1);
    expect(result.structuredContent.plan_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('requires explicit permission bits for a lock plan', async () => {
    const tool = new IntentPlanTool({} as never);
    const result = (await tool.run({
      intent: 'lock_channel',
      guild_id: '100000000000000001',
      channel_id: '200000000000000002',
    })) as { structuredContent: { status: string; steps: unknown[] } };
    expect(result.structuredContent.status).toBe('needs_input');
    expect(result.structuredContent.steps).toHaveLength(0);
  });

  it('reports missing announcement input without emitting an invalid write step', async () => {
    const tool = new IntentPlanTool({} as never);
    const result = (await tool.run({
      intent: 'announce',
      guild_id: '100000000000000001',
      channel_id: '200000000000000002',
    })) as { structuredContent: { status: string; steps: unknown[] } };
    expect(result.structuredContent.status).toBe('needs_input');
    expect(result.structuredContent.steps).toHaveLength(0);
  });
});
