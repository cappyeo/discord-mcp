const DEFAULT_API_BASE = 'https://discord.com/api/v10';
const SNOWFLAKE = /^\d{17,20}$/;
const MESSAGE_PAGE_SIZE = 100;
const MESSAGE_HISTORY_CONCURRENCY = 4;
const MAX_RETRY_AFTER_MS = 15 * 60_000;
const DISCORD_VIRTUAL_AUTOMOD_RULE_ID = '1030554520465440818';
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export class DiscordRestError extends Error {
  constructor(
    message,
    { status = null, discordCode = null, method, path, disposition, retryAfterMs = null },
  ) {
    super(message);
    this.name = 'DiscordRestError';
    this.status = status;
    this.code = discordCode;
    this.method = method;
    this.path = path;
    this.disposition = disposition;
    this.retryAfterMs = retryAfterMs;
  }
}

function restFailure(
  message,
  {
    status = null,
    discordCode = null,
    method,
    path,
    disposition: dispositionOverride,
    retryAfterMs = null,
  },
) {
  const disposition =
    dispositionOverride ??
    (status === null || status === 429 || status >= 500 || (method === 'DELETE' && status === 404)
      ? 'ambiguous'
      : 'deterministic');
  return new DiscordRestError(message, {
    status,
    discordCode,
    method,
    path,
    disposition,
    retryAfterMs,
  });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function mapBounded(values, concurrency, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function redact(value, secret) {
  return String(value).split(secret).join('[REDACTED]');
}

function assertApiBase(value) {
  const url = new URL(value);
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(url.hostname);
  const officialDiscord = url.protocol === 'https:' && url.hostname === 'discord.com';
  if (!officialDiscord && !(url.protocol === 'http:' && loopback)) {
    throw new TypeError(
      'Discord API base must be official Discord HTTPS or an HTTP loopback address',
    );
  }
  return new URL(`${url.toString().replace(/\/+$/, '')}/`);
}

function assertSnowflake(value, label) {
  if (typeof value !== 'string' || !SNOWFLAKE.test(value)) {
    throw new TypeError(`${label} must be a Discord snowflake`);
  }
  return value;
}

function assertArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} response must be an array`);
  return value;
}

function assertScopedId(value, expected, label) {
  if (value !== expected) throw new Error(`${label} guild mismatch`);
}

function assertDecimal(value, label) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error(`${label} must be an unsigned decimal bitfield`);
  }
}

function assertUniqueIds(values, label) {
  const seen = new Set();
  for (const [index, value] of values.entries()) {
    const id = assertSnowflake(value?.id, `${label}[${index}].id`);
    if (seen.has(id)) throw new Error(`${label} response contains duplicate id ${id}`);
    seen.add(id);
  }
  return seen;
}

async function readBody(response) {
  if (response.status === 204) return null;
  const text = await response.text();
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 500) };
  }
}

function parseRetryAfterMilliseconds(value) {
  const text =
    typeof value === 'number' && Number.isFinite(value) ? String(value) : String(value ?? '');
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const [secondsText, fractionText = ''] = text.split('.');
  let milliseconds;
  try {
    const fractionMilliseconds = BigInt(`${fractionText.slice(0, 3)}00`.slice(0, 3));
    const fractionRemainder = fractionText.slice(3);
    milliseconds =
      BigInt(secondsText) * 1_000n +
      fractionMilliseconds +
      (fractionRemainder !== '' && /[1-9]/.test(fractionRemainder) ? 1n : 0n);
  } catch {
    return null;
  }
  return milliseconds <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(milliseconds) : null;
}

function retryAfterMetadata(response, body) {
  if (body !== null && typeof body === 'object' && 'retry_after' in body) {
    return { present: true, milliseconds: parseRetryAfterMilliseconds(body.retry_after) };
  }
  const header = response.headers.get('retry-after');
  return header === null
    ? { present: false, milliseconds: null }
    : { present: true, milliseconds: parseRetryAfterMilliseconds(header) };
}

function retryDelay(metadata, attempt) {
  if (metadata.present) {
    return metadata.milliseconds !== null && metadata.milliseconds <= MAX_RETRY_AFTER_MS
      ? metadata.milliseconds
      : null;
  }
  return Math.min(250 * 2 ** attempt, 4_000);
}

export function createDiscordRestClient({
  token,
  apiBaseUrl = DEFAULT_API_BASE,
  fetchImpl = globalThis.fetch,
  sleep = wait,
  maxAttempts = 4,
  timeoutMs = 15_000,
}) {
  if (typeof token !== 'string' || token.trim() === '') {
    throw new TypeError('Discord benchmark token is required');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 8) {
    throw new TypeError('maxAttempts must be an integer from 1 to 8');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw new TypeError('timeoutMs must be an integer from 100 to 120000');
  }
  const rawToken = token.startsWith('Bot ') ? token.slice(4) : token;
  if (rawToken.trim() === '') throw new TypeError('Discord benchmark token is required');
  const base = assertApiBase(apiBaseUrl);

  async function request(method, path, { body, reason, signal, retry = method !== 'POST' } = {}) {
    if (!METHODS.has(method)) throw new TypeError('Discord REST method is not supported');
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
      throw new TypeError('Discord REST path must be an absolute API path');
    }
    if (typeof retry !== 'boolean') throw new TypeError('retry must be boolean');
    let encodedReason;
    if (reason !== undefined) {
      if (typeof reason !== 'string' || reason.length === 0) {
        throw new TypeError('Discord audit reason must be a nonempty string');
      }
      encodedReason = encodeURIComponent(reason);
      if (encodedReason.length > 512) {
        throw new TypeError('Discord audit reason must be at most 512 URL-encoded characters');
      }
    }
    let payload;
    if (body !== undefined) {
      try {
        payload = JSON.stringify(body);
      } catch {
        throw new TypeError('Discord REST body must be JSON-serializable');
      }
      if (payload === undefined) throw new TypeError('Discord REST body must be JSON-serializable');
    }
    const url = new URL(path.slice(1), base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
      throw new TypeError('Discord REST path escaped the configured API base');
    }
    let lastError;
    let accumulatedRetryWaitMs = 0;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (signal?.aborted) throw signal.reason;
      const timeout = AbortSignal.timeout(timeoutMs);
      const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
      try {
        const headers = {
          accept: 'application/json',
          authorization: `Bot ${rawToken}`,
          'user-agent': 'discord-mcp-real-benchmark/1.0',
        };
        if (payload !== undefined) headers['content-type'] = 'application/json';
        if (encodedReason !== undefined) headers['x-audit-log-reason'] = encodedReason;
        const response = await fetchImpl(url, {
          method,
          headers,
          ...(payload === undefined ? {} : { body: payload }),
          signal: requestSignal,
        });
        const body = await readBody(response);
        const retryAfter = retryAfterMetadata(response, body);
        const retryAfterMs = response.status === 429 ? retryAfter.milliseconds : null;
        if (response.ok) return body;
        if (
          retry &&
          (response.status === 429 || response.status >= 500) &&
          attempt + 1 < maxAttempts
        ) {
          const delay = retryDelay(retryAfter, attempt);
          if (delay === null || accumulatedRetryWaitMs + delay > MAX_RETRY_AFTER_MS) {
            throw restFailure('Discord REST Retry-After exceeds the benchmark wait budget', {
              status: 429,
              discordCode: 'RETRY_AFTER_EXCEEDS_CAMPAIGN_BUDGET',
              method,
              path,
              disposition: 'deterministic',
              retryAfterMs,
            });
          }
          accumulatedRetryWaitMs += delay;
          await sleep(delay);
          continue;
        }
        const code = body !== null && typeof body === 'object' ? body.code : undefined;
        const message = body !== null && typeof body === 'object' ? body.message : undefined;
        throw restFailure(
          redact(
            `Discord REST ${response.status}${code === undefined ? '' : ` code ${String(code)}`}${message === undefined ? '' : `: ${String(message).slice(0, 300)}`}`,
            rawToken,
          ),
          {
            status: response.status,
            discordCode: code ?? null,
            method,
            path,
            retryAfterMs,
          },
        );
      } catch (error) {
        if (signal?.aborted) {
          throw restFailure(redact(signal.reason ?? 'Discord REST request aborted', rawToken), {
            method,
            path,
          });
        }
        if (error instanceof DiscordRestError || !retry || attempt + 1 >= maxAttempts) {
          if (error instanceof DiscordRestError) throw error;
          throw restFailure(redact(error instanceof Error ? error.message : error, rawToken), {
            method,
            path,
          });
        }
        lastError = error;
        await sleep(Math.min(250 * 2 ** attempt, 4_000));
      }
    }
    if (lastError instanceof DiscordRestError) throw lastError;
    throw restFailure(
      redact(lastError instanceof Error ? lastError.message : lastError, rawToken),
      {
        method,
        path,
      },
    );
  }

  async function get(path, options) {
    return request('GET', path, { ...options, retry: true });
  }

  return { get, request };
}

export async function readDiscordSnapshot(
  rest,
  { guildId, botId, messageChannelIds = [], allowMissingMessageChannelIds = false, signal } = {},
) {
  assertSnowflake(guildId, 'guildId');
  assertSnowflake(botId, 'botId');
  if (typeof allowMissingMessageChannelIds !== 'boolean') {
    throw new TypeError('allowMissingMessageChannelIds must be boolean');
  }
  const uniqueMessageChannelIds = [...new Set(messageChannelIds)];
  if (uniqueMessageChannelIds.length !== messageChannelIds.length) {
    throw new TypeError('messageChannelIds must not contain duplicates');
  }
  for (const channelId of uniqueMessageChannelIds) {
    assertSnowflake(channelId, 'messageChannelIds item');
  }

  const [currentUser, guild, bot, rolesValue, channelsValue, rulesValue] = await Promise.all([
    rest.get('/users/@me', { signal }),
    rest.get(`/guilds/${guildId}?with_counts=true`, { signal }),
    rest.get(`/guilds/${guildId}/members/${botId}`, { signal }),
    rest.get(`/guilds/${guildId}/roles`, { signal }),
    rest.get(`/guilds/${guildId}/channels`, { signal }),
    rest.get(`/guilds/${guildId}/auto-moderation/rules`, { signal }),
  ]);
  if (currentUser?.id !== botId || currentUser?.bot !== true) {
    throw new Error('current bot identity mismatch');
  }
  assertScopedId(guild?.id, guildId, 'guild');
  if (bot?.user?.id !== botId) throw new Error('guild member bot identity mismatch');
  const roles = assertArray(rolesValue, 'roles');
  const channels = assertArray(channelsValue, 'channels');
  const automodRules = assertArray(rulesValue, 'AutoMod rules');
  assertUniqueIds(roles, 'roles');
  assertUniqueIds(channels, 'channels');
  assertUniqueIds(automodRules, 'AutoMod rules');
  for (const [index, role] of roles.entries()) {
    assertDecimal(role?.permissions, `roles[${index}].permissions`);
    if (!Number.isInteger(role?.position) || role.position < 0)
      throw new Error(`roles[${index}].position must be a nonnegative integer`);
    if (typeof role?.managed !== 'boolean')
      throw new Error(`roles[${index}].managed must be boolean`);
  }
  for (const [index, channel] of channels.entries()) {
    assertScopedId(channel?.guild_id, guildId, 'channel');
    if (!Number.isInteger(channel?.type) || channel.type < 0)
      throw new Error(`channels[${index}].type must be a nonnegative integer`);
    if (!Number.isInteger(channel?.position) || channel.position < 0)
      throw new Error(`channels[${index}].position must be a nonnegative integer`);
    const overwriteKeys = new Set();
    for (const [overwriteIndex, overwrite] of (channel.permission_overwrites ?? []).entries()) {
      const overwriteId = assertSnowflake(
        overwrite?.id,
        `channels[${index}].permission_overwrites[${overwriteIndex}].id`,
      );
      if (overwrite?.type !== 0 && overwrite?.type !== 1)
        throw new Error('channel permission overwrite type must be 0 or 1');
      assertDecimal(overwrite?.allow, 'channel permission overwrite allow');
      assertDecimal(overwrite?.deny, 'channel permission overwrite deny');
      const key = `${overwrite.type}:${overwriteId}`;
      if (overwriteKeys.has(key))
        throw new Error('channel permission overwrites contain duplicate');
      overwriteKeys.add(key);
    }
  }
  for (const [index, rule] of automodRules.entries()) {
    assertScopedId(rule?.guild_id, guildId, 'AutoMod rule');
    assertSnowflake(rule?.creator_id, `AutoMod rules[${index}].creator_id`);
    if (!Number.isInteger(rule?.trigger_type) || rule.trigger_type < 1 || rule.trigger_type > 6) {
      throw new Error(`AutoMod rules[${index}].trigger_type must be an integer from 1 to 6`);
    }
  }
  const returnedAutomodRules = automodRules.filter(
    (rule) => rule.id !== DISCORD_VIRTUAL_AUTOMOD_RULE_ID,
  );

  const community = Array.isArray(guild.features) && guild.features.includes('COMMUNITY');
  const [onboarding, welcomeScreen] = community
    ? await Promise.all([
        rest.get(`/guilds/${guildId}/onboarding`, { signal }),
        rest.get(`/guilds/${guildId}/welcome-screen`, { signal }),
      ])
    : [null, null];
  if (onboarding !== null) assertScopedId(onboarding?.guild_id, guildId, 'onboarding');

  const channelIds = new Set(channels.map((channel) => String(channel.id)));
  const messageEntries = await mapBounded(
    uniqueMessageChannelIds,
    MESSAGE_HISTORY_CONCURRENCY,
    async (channelId) => {
      if (!channelIds.has(channelId)) {
        if (allowMissingMessageChannelIds) return [channelId, [], true];
        throw new Error('publication channel guild mismatch');
      }
      const messages = assertArray(
        await rest.get(`/channels/${channelId}/messages?limit=${MESSAGE_PAGE_SIZE}`, { signal }),
        'messages',
      );
      if (messages.length > MESSAGE_PAGE_SIZE) throw new Error('messages response exceeds limit');
      assertUniqueIds(messages, 'messages');
      for (const message of messages) {
        if (message?.channel_id !== channelId) throw new Error('message channel mismatch');
        if (message?.guild_id !== undefined) assertScopedId(message.guild_id, guildId, 'message');
        assertSnowflake(message?.author?.id, 'message author id');
      }
      return [channelId, messages, messages.length < MESSAGE_PAGE_SIZE];
    },
  );

  return {
    guild,
    bot,
    roles,
    channels,
    automod_rules: returnedAutomodRules,
    onboarding,
    welcome_screen: welcomeScreen,
    recent_messages: Object.fromEntries(
      messageEntries.map(([channelId, messages]) => [channelId, messages]),
    ),
    publication_history_complete: Object.fromEntries(
      messageEntries.map(([channelId, , complete]) => [channelId, complete]),
    ),
  };
}
