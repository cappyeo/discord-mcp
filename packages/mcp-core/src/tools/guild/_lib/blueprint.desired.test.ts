import { describe, expect, it } from 'vitest';
import {
  desiredOnboardingBody,
  onboardingResponseHasIds,
  onboardingSemanticallyMatches,
} from './blueprint.desired.js';
import { emptyBlueprintBindings } from './blueprint.execution.schema.js';
import { compileGuildBlueprint } from './blueprint.js';
import type { TargetOnboarding } from './blueprint.target.js';

const blueprint = compileGuildBlueprint({
  request: 'Build a professional gaming community',
  requested_capabilities: ['gaming', 'lfg', 'voice'],
  primary: {
    code: 'primary',
    effective_capabilities: ['gaming', 'lfg', 'voice'],
    blueprint: {
      channel_count: 10,
      category_count: 2,
      text_channel_count: 6,
      voice_channel_count: 3,
      forum_channel_count: 0,
      stage_channel_count: 0,
      other_channel_count: 0,
      nsfw_channel_count: 0,
      permission_overwrite_count: 4,
      role_count: 4,
      privileged_role_count: 0,
      risky_permission_signals: [],
    },
  },
  inspirations: [],
});

function bindings() {
  const result = emptyBlueprintBindings();
  for (const [index, role] of blueprint.roles.entries()) {
    result.roles[role.key] = `200000000000000${String(index + 1).padStart(3, '0')}`;
  }
  for (const [index, channel] of blueprint.channels.entries()) {
    result.channels[channel.key] = `300000000000000${String(index + 1).padStart(3, '0')}`;
  }
  return result;
}

describe('blueprint onboarding request contract', () => {
  it('supplies required prompt placeholders and reuses authoritative Discord IDs', () => {
    const request = desiredOnboardingBody(blueprint, bindings())!;
    const requestPrompts = request.prompts as Array<Record<string, unknown>>;

    expect(requestPrompts).not.toHaveLength(0);
    expect(requestPrompts.every((prompt) => /^\d{17,20}$/.test(String(prompt.id)))).toBe(true);

    const response: TargetOnboarding = {
      guild_id: '100000000000000001',
      enabled: request.enabled as boolean,
      mode: request.mode as number,
      default_channel_ids: request.default_channel_ids as string[],
      prompts: requestPrompts.map((prompt, promptIndex) => ({
        ...prompt,
        id: `400000000000000${String(promptIndex + 1).padStart(3, '0')}`,
        options: (prompt.options as Array<Record<string, unknown>>).map((option, optionIndex) => ({
          ...option,
          id: `5000000000000${String(promptIndex + 1).padStart(2, '0')}${String(optionIndex + 1).padStart(3, '0')}`,
        })),
      })),
    };

    expect(onboardingResponseHasIds(response)).toBe(true);
    expect(onboardingSemanticallyMatches(response, request)).toBe(true);

    const retry = desiredOnboardingBody(blueprint, bindings(), response)!;
    expect((retry.prompts as Array<Record<string, unknown>>).map((prompt) => prompt.id)).toEqual(
      response.prompts.map((prompt) => prompt.id),
    );
  });
});
