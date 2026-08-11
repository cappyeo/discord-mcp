import { RateLimitError, type REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import {
  desiredAutoModBody,
  desiredCategoryBody,
  desiredChannelBody,
  desiredGuildBody,
  desiredOnboardingBody,
  desiredPublicationBody,
  desiredRoleBody,
  desiredWelcomeBody,
  onboardingResponseHasIds,
  onboardingSemanticallyMatches,
  welcomeSemanticallyMatches,
} from './blueprint.desired.js';
import type {
  BlueprintBindings,
  BlueprintOperation,
  GuildBlueprintPlanPayload,
} from './blueprint.execution.schema.js';
import { compareDiscordRoles, isDiscordRoleStrictlyBelow } from './blueprint.role-hierarchy.js';
import type {
  BlueprintTargetSnapshot,
  TargetOnboarding,
  TargetRole,
  TargetWelcomeScreen,
} from './blueprint.target.js';

export class BlueprintExecutionError extends Error {
  public override readonly name = 'BlueprintExecutionError';

  public constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

interface IdResponse {
  readonly id?: string;
  readonly guild_id?: string;
  readonly channel_id?: string;
  readonly author?: { readonly id?: string };
}

function reason(plan: GuildBlueprintPlanPayload, operation: BlueprintOperation): string {
  return `discord-mcp blueprint ${plan.blueprint_id.slice(7, 19)} ${operation.operation_id}`;
}

function requireId(value: IdResponse, context: string): string {
  if (typeof value.id !== 'string') {
    throw new BlueprintExecutionError('DISCORD_RESPONSE_INVALID', `${context} returned no id.`);
  }
  return value.id;
}

function assertGuild(response: IdResponse, guildId: string, context: string): void {
  if (response.guild_id !== guildId) {
    throw new BlueprintExecutionError(
      'TARGET_GUILD_MISMATCH',
      `${context} response belonged to a different guild.`,
    );
  }
}

function roleByKey(plan: GuildBlueprintPlanPayload, key: string) {
  const role = plan.blueprint.roles.find((item) => item.key === key);
  if (role === undefined) {
    throw new BlueprintExecutionError('PLAN_INVALID', `Unknown role key ${key}.`);
  }
  return role;
}

function categoryByKey(plan: GuildBlueprintPlanPayload, key: string) {
  const category = plan.blueprint.categories.find((item) => item.key === key);
  if (category === undefined) {
    throw new BlueprintExecutionError('PLAN_INVALID', `Unknown category key ${key}.`);
  }
  return category;
}

function channelByKey(plan: GuildBlueprintPlanPayload, key: string) {
  const channel = plan.blueprint.channels.find((item) => item.key === key);
  if (channel === undefined) {
    throw new BlueprintExecutionError('PLAN_INVALID', `Unknown channel key ${key}.`);
  }
  return channel;
}

function ruleByKey(plan: GuildBlueprintPlanPayload, key: string) {
  const rule = plan.blueprint.automod.rules.find((item) => item.key === key);
  if (rule === undefined) {
    throw new BlueprintExecutionError('PLAN_INVALID', `Unknown AutoMod key ${key}.`);
  }
  return rule;
}

function publicationByKey(plan: GuildBlueprintPlanPayload, key: string) {
  const publication = plan.blueprint.components_v2.publications.find((item) => item.key === key);
  if (publication === undefined) {
    throw new BlueprintExecutionError('PLAN_INVALID', `Unknown publication key ${key}.`);
  }
  return publication;
}

function requireBody(
  value: Record<string, unknown> | null,
  operation: BlueprintOperation,
): Record<string, unknown> {
  if (value === null) {
    throw new BlueprintExecutionError(
      'PLAN_DEPENDENCY_UNRESOLVED',
      `Dependencies for ${operation.operation_id} are unresolved.`,
    );
  }
  return value;
}

function unresolved(operation: BlueprintOperation): never {
  return requireBody(null, operation) as never;
}

const PUBLICATION_RETRY_DELAYS_MS = [250, 750, 1_500] as const;
const MAX_PUBLICATION_RETRY_DELAY_MS = 10_000;

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as { readonly status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

async function waitForPublicationRetry(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted) {
    throw new BlueprintExecutionError('CANCELLED', 'Blueprint apply was cancelled by the client.');
  }
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(
        new BlueprintExecutionError('CANCELLED', 'Blueprint apply was cancelled by the client.'),
      );
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function publicationReadbackIsRetriable(error: unknown): boolean {
  if (error instanceof RateLimitError) return true;
  const status = errorStatus(error);
  return status === 404 || status === 429 || (status !== undefined && status >= 500);
}

function publicationReadbackDelay(error: unknown, fallbackMs: number): number | null {
  if (!(error instanceof RateLimitError)) return fallbackMs;
  const delayMs = Math.max(fallbackMs, Math.ceil(error.retryAfter));
  return Number.isSafeInteger(delayMs) && delayMs <= MAX_PUBLICATION_RETRY_DELAY_MS
    ? delayMs
    : null;
}

async function readPublicationChannel(
  rest: REST,
  channelId: string,
  signal: AbortSignal,
): Promise<IdResponse> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return (await rest.get(Routes.channel(channelId), { signal })) as IdResponse;
    } catch (error) {
      if (signal.aborted) {
        throw new BlueprintExecutionError(
          'CANCELLED',
          'Blueprint apply was cancelled by the client.',
        );
      }
      const retriable = publicationReadbackIsRetriable(error);
      if (!retriable) {
        throw new BlueprintExecutionError(
          'PUBLICATION_CHANNEL_READBACK_FAILED',
          'Publication channel identity could not be read back.',
          errorStatus(error),
        );
      }
      const delayMs = PUBLICATION_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined) {
        throw new BlueprintExecutionError(
          'PUBLICATION_CHANNEL_NOT_READY',
          'Publication channel identity was not available after bounded readback retries.',
          errorStatus(error),
        );
      }
      const retryDelayMs = publicationReadbackDelay(error, delayMs);
      if (retryDelayMs === null) throw error;
      await waitForPublicationRetry(signal, retryDelayMs);
    }
  }
}

async function postPublication(
  rest: REST,
  channelId: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<IdResponse> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return (await rest.post(Routes.channelMessages(channelId), { body, signal })) as IdResponse;
    } catch (error) {
      if (signal.aborted) {
        throw new BlueprintExecutionError(
          'CANCELLED',
          'Blueprint apply was cancelled by the client.',
        );
      }
      if (errorStatus(error) !== 404) throw error;
      if (attempt >= PUBLICATION_RETRY_DELAYS_MS.length) {
        throw new BlueprintExecutionError(
          'PUBLICATION_CHANNEL_NOT_READY',
          'Discord did not make the newly created publication channel writable within the bounded retry window.',
          404,
        );
      }
      await waitForPublicationRetry(signal, PUBLICATION_RETRY_DELAYS_MS[attempt]!);
    }
  }
}

export interface ExecuteBlueprintOperationInput {
  readonly rest: REST;
  readonly plan: GuildBlueprintPlanPayload;
  readonly operation: BlueprintOperation;
  readonly bindings: BlueprintBindings;
  readonly snapshot: BlueprintTargetSnapshot;
  readonly signal: AbortSignal;
}

export interface ExecuteBlueprintOperationResult {
  readonly resource_id: string | null;
}

/** Execute exactly one already-approved, preflighted graph operation. */
export async function executeBlueprintOperation(
  input: ExecuteBlueprintOperationInput,
): Promise<ExecuteBlueprintOperationResult> {
  if (input.signal.aborted) {
    throw new BlueprintExecutionError('CANCELLED', 'Blueprint apply was cancelled by the client.');
  }
  const { rest, plan, operation, bindings } = input;
  const guildId = plan.target.guild_id;
  const botId = plan.target.bot_id;
  const auditReason = reason(plan, operation);

  if (operation.resource === 'role') {
    const desired = roleByKey(plan, operation.key);
    const body = desiredRoleBody(desired);
    if (operation.action === 'create') {
      const response = (await rest.post(Routes.guildRoles(guildId), {
        body,
        reason: auditReason,
        signal: input.signal,
      })) as IdResponse;
      const id = requireId(response, 'Role create');
      bindings.roles[desired.key] = id;
      return { resource_id: id };
    }
    const id = bindings.roles[desired.key];
    if (id === undefined) return unresolved(operation);
    const response = (await rest.patch(Routes.guildRole(guildId, id), {
      body,
      reason: auditReason,
      signal: input.signal,
    })) as IdResponse;
    const responseId = requireId(response, 'Role update');
    if (responseId !== id) {
      throw new BlueprintExecutionError(
        'DISCORD_RESPONSE_INVALID',
        'Role update changed identity.',
      );
    }
    return { resource_id: id };
  }

  if (operation.resource === 'category') {
    const desired = categoryByKey(plan, operation.key);
    const body = requireBody(desiredCategoryBody(desired, guildId, botId, bindings), operation);
    if (operation.action === 'create') {
      const response = (await rest.post(Routes.guildChannels(guildId), {
        body,
        reason: auditReason,
        signal: input.signal,
      })) as IdResponse;
      assertGuild(response, guildId, 'Category create');
      const id = requireId(response, 'Category create');
      bindings.categories[desired.key] = id;
      return { resource_id: id };
    }
    const id = bindings.categories[desired.key];
    if (id === undefined) return unresolved(operation);
    const response = (await rest.patch(Routes.channel(id), {
      body,
      reason: auditReason,
      signal: input.signal,
    })) as IdResponse;
    assertGuild(response, guildId, 'Category update');
    if (requireId(response, 'Category update') !== id) {
      throw new BlueprintExecutionError(
        'DISCORD_RESPONSE_INVALID',
        'Category update changed identity.',
      );
    }
    return { resource_id: id };
  }

  if (operation.resource === 'channel') {
    const desired = channelByKey(plan, operation.key);
    const body = requireBody(desiredChannelBody(desired, guildId, botId, bindings), operation);
    if (operation.action === 'create') {
      const response = (await rest.post(Routes.guildChannels(guildId), {
        body,
        reason: auditReason,
        signal: input.signal,
      })) as IdResponse;
      assertGuild(response, guildId, 'Channel create');
      const id = requireId(response, 'Channel create');
      bindings.channels[desired.key] = id;
      return { resource_id: id };
    }
    const id = bindings.channels[desired.key];
    if (id === undefined) return unresolved(operation);
    const response = (await rest.patch(Routes.channel(id), {
      body,
      reason: auditReason,
      signal: input.signal,
    })) as IdResponse;
    assertGuild(response, guildId, 'Channel update');
    if (requireId(response, 'Channel update') !== id) {
      throw new BlueprintExecutionError(
        'DISCORD_RESPONSE_INVALID',
        'Channel update changed identity.',
      );
    }
    return { resource_id: id };
  }

  if (operation.resource === 'role_order') {
    const positions = plan.blueprint.role_order.map((key, index) => {
      const id = bindings.roles[key];
      if (id === undefined) throw new BlueprintExecutionError('PLAN_DEPENDENCY_UNRESOLVED', key);
      return { id, position: index + 1 };
    });
    const botTopRole = input.snapshot.roles
      .filter((role) => input.snapshot.bot.roles.includes(role.id))
      .sort(compareDiscordRoles)
      .at(-1);
    const unsafeRole = positions.find(
      (role) => botTopRole === undefined || !isDiscordRoleStrictlyBelow(role, botTopRole),
    );
    if (unsafeRole !== undefined) {
      throw new BlueprintExecutionError(
        'BOT_ROLE_HIERARCHY',
        'The current bot highest role cannot safely contain the proposed generated role order.',
      );
    }
    const response = await rest.patch(Routes.guildRoles(guildId), {
      body: positions,
      reason: auditReason,
      signal: input.signal,
    });
    if (
      !Array.isArray(response) ||
      positions.some(
        ({ id }) =>
          !(response as unknown[]).some(
            (role) =>
              typeof role === 'object' &&
              role !== null &&
              (role as Pick<TargetRole, 'id'>).id === id,
          ),
      )
    ) {
      throw new BlueprintExecutionError(
        'DISCORD_RESPONSE_INVALID',
        'Role ordering response did not contain every managed role.',
      );
    }
    return { resource_id: null };
  }

  if (operation.resource === 'channel_order') {
    const positions: Array<Record<string, unknown>> = [];
    for (const category of plan.blueprint.categories) {
      const id = bindings.categories[category.key];
      if (id === undefined) {
        throw new BlueprintExecutionError('PLAN_DEPENDENCY_UNRESOLVED', category.key);
      }
      positions.push({ id, position: category.position });
    }
    for (const channel of plan.blueprint.channels) {
      const id = bindings.channels[channel.key];
      const parentId = bindings.categories[channel.parent_key];
      if (id === undefined || parentId === undefined) {
        throw new BlueprintExecutionError('PLAN_DEPENDENCY_UNRESOLVED', channel.key);
      }
      positions.push({ id, position: channel.position });
    }
    await rest.patch(Routes.guildChannels(guildId), {
      body: positions,
      reason: auditReason,
      signal: input.signal,
    });
    return { resource_id: null };
  }

  if (operation.resource === 'guild') {
    const body = requireBody(
      desiredGuildBody(plan.blueprint, input.snapshot.guild.features, bindings),
      operation,
    );
    const response = (await rest.patch(Routes.guild(guildId), {
      body,
      reason: auditReason,
      signal: input.signal,
    })) as IdResponse;
    if (requireId(response, 'Guild update') !== guildId) {
      throw new BlueprintExecutionError('TARGET_GUILD_MISMATCH', 'Guild update changed target.');
    }
    return { resource_id: guildId };
  }

  if (operation.resource === 'welcome_screen') {
    const body = requireBody(desiredWelcomeBody(plan.blueprint, bindings), operation);
    const response = await rest.patch(Routes.guildWelcomeScreen(guildId), {
      body,
      reason: auditReason,
      signal: input.signal,
    });
    if (
      typeof response !== 'object' ||
      response === null ||
      !Array.isArray((response as Partial<TargetWelcomeScreen>).welcome_channels) ||
      !welcomeSemanticallyMatches(response as TargetWelcomeScreen, body)
    ) {
      throw new BlueprintExecutionError(
        'WELCOME_READBACK_MISMATCH',
        'Welcome Screen response did not prove the approved channel configuration.',
      );
    }
    return { resource_id: null };
  }

  if (operation.resource === 'onboarding') {
    const body = requireBody(
      desiredOnboardingBody(plan.blueprint, bindings, input.snapshot.onboarding),
      operation,
    );
    const response = (await rest.put(Routes.guildOnboarding(guildId), {
      body,
      reason: auditReason,
      signal: input.signal,
    })) as TargetOnboarding;
    if (response.guild_id !== guildId) {
      throw new BlueprintExecutionError(
        'TARGET_GUILD_MISMATCH',
        'Onboarding response changed target guild.',
      );
    }
    if (!onboardingResponseHasIds(response) || !onboardingSemanticallyMatches(response, body)) {
      throw new BlueprintExecutionError(
        'ONBOARDING_READBACK_MISMATCH',
        'Onboarding response did not prove the approved prompt configuration.',
      );
    }
    return { resource_id: null };
  }

  if (operation.resource === 'automod_rule') {
    const desired = ruleByKey(plan, operation.key);
    const body = requireBody(desiredAutoModBody(desired, bindings), operation);
    if (operation.action === 'create') {
      const response = (await rest.post(Routes.guildAutoModerationRules(guildId), {
        body,
        reason: auditReason,
        signal: input.signal,
      })) as IdResponse;
      assertGuild(response, guildId, 'AutoMod create');
      const id = requireId(response, 'AutoMod create');
      bindings.automod_rules[desired.key] = id;
      return { resource_id: id };
    }
    const id = bindings.automod_rules[desired.key];
    if (id === undefined) return unresolved(operation);
    const patchBody = { ...body };
    delete patchBody.trigger_type;
    const response = (await rest.patch(Routes.guildAutoModerationRule(guildId, id), {
      body: patchBody,
      reason: auditReason,
      signal: input.signal,
    })) as IdResponse;
    assertGuild(response, guildId, 'AutoMod update');
    if (requireId(response, 'AutoMod update') !== id) {
      throw new BlueprintExecutionError(
        'DISCORD_RESPONSE_INVALID',
        'AutoMod update changed identity.',
      );
    }
    return { resource_id: id };
  }

  if (operation.resource === 'publication') {
    const publication = publicationByKey(plan, operation.key);
    const desired = desiredPublicationBody(
      publication,
      plan.blueprint_id,
      guildId,
      botId,
      bindings,
    );
    if (desired === null) return unresolved(operation);
    const response = await postPublication(rest, desired.channel_id, desired.body, input.signal);
    if (response.channel_id !== desired.channel_id || response.author?.id !== botId) {
      throw new BlueprintExecutionError(
        'DISCORD_RESPONSE_INVALID',
        'Publication response did not match the bound bot and channel.',
      );
    }
    if (response.guild_id === undefined) {
      const channel = await readPublicationChannel(rest, desired.channel_id, input.signal);
      assertGuild(channel, guildId, 'Publication channel readback');
      if (requireId(channel, 'Publication channel readback') !== desired.channel_id) {
        throw new BlueprintExecutionError(
          'DISCORD_RESPONSE_INVALID',
          'Publication channel readback changed identity.',
        );
      }
    } else {
      assertGuild(response, guildId, 'Publication create');
    }
    const id = requireId(response, 'Publication create');
    bindings.publications[publication.key] = id;
    return { resource_id: id };
  }

  throw new BlueprintExecutionError(
    'PLAN_INVALID',
    `Unsupported blueprint operation ${operation.operation_id}.`,
  );
}
