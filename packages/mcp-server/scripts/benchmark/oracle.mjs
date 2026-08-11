/**
 * Independent oracle for the real-server benchmark.
 *
 * This module intentionally knows nothing about the production reconciler or
 * Activity Evidence. It compares two literal Discord snapshots and a
 * trial-owned set of generated IDs, so a benchmark cannot pass by repeating
 * the implementation's own conclusion.
 */

const DANGEROUS_PERMISSION_BITS = Object.freeze({
  ADMINISTRATOR: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_GUILD: 1n << 5n,
  MANAGE_ROLES: 1n << 28n,
});

const RESOURCE_KINDS = Object.freeze(['roles', 'channels', 'automod_rules', 'messages']);
const SINGLETON_AUTOMOD_TRIGGER_TYPES = new Set([3, 4, 5]);
const STATE_CHANGE_DOMAINS = Object.freeze([
  ['guild', 'guild'],
  ['onboarding', 'onboarding'],
  ['welcome', 'welcome_screen'],
]);
const SECRET_KEY = /(?:token|secret|authorization|password|credential|api[_-]?key)/i;
const SECRET_VALUE =
  /\b(?:(?:bot|bearer)\s+[a-z0-9._-]{20,}|(?:token|authorization|api[_-]?key|password|cookie|secret|credential)\s*[:=]\s*\S+)/i;

function fail(message) {
  throw new TypeError(`Invalid benchmark oracle input: ${message}`);
}

function assertNoSecrets(value, path = 'expected', seen = new WeakSet()) {
  if (typeof value === 'string') {
    if (SECRET_VALUE.test(value)) fail(`${path} contains secret-bearing data`);
    return;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return;
  if (typeof value !== 'object') fail(`${path} must contain only JSON values`);
  if (seen.has(value)) fail(`${path} must not contain a cycle`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertNoSecrets(item, `${path}[${index}]`, seen);
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${path} must be a plain object`);
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) fail(`${path}.${key} must not be supplied`);
    assertNoSecrets(child, `${path}.${key}`, seen);
  }
}

function asId(value, path) {
  if (typeof value !== 'string' || value.length === 0) fail(`${path} must be a non-empty string`);
  return value;
}

function idList(value, path) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${path} must be an array`);
  return value.map((item, index) => asId(item, `${path}[${index}]`));
}

function uniqueIds(values, path) {
  const result = new Set();
  for (const value of values) {
    if (result.has(value)) fail(`${path} contains duplicate id ${value}`);
    result.add(value);
  }
  return result;
}

function sameIds(left, right) {
  const leftIds = left instanceof Map ? [...left.keys()] : [...left];
  return leftIds.length === right.size && leftIds.every((id) => right.has(id));
}

function decimalMap(value, path) {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail(`${path} must be an object`);
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      asId(key, `${path}.${key}`),
      permissions(child, `${path}.${key}`).toString(),
    ]),
  );
}

function automodTriggerTypeMap(value, path, adoptedIds) {
  if (value === undefined) fail(`${path} must be supplied for adopted AutoMod rules`);
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail(`${path} must be an object`);
  const result = new Map();
  for (const [key, child] of Object.entries(value)) {
    const id = asId(key, `${path}.${key}`);
    if (!Number.isInteger(child) || ![3, 4, 5].includes(child))
      fail(`${path}.${key} must be a singleton AutoMod trigger type (3, 4, or 5)`);
    result.set(id, child);
  }
  if (!sameIds(result, adoptedIds)) fail(`${path} must exactly map adopted AutoMod rules`);
  return result;
}

function allowedStateChanges(value) {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail('expected.allowed_state_changes must be an object');
  const result = {};
  for (const [domain, allowed] of Object.entries(value)) {
    const target = domain === 'welcome_screen' ? 'welcome' : domain;
    if (!STATE_CHANGE_DOMAINS.some(([name]) => name === target))
      fail(`unsupported expected.allowed_state_changes domain ${domain}`);
    if (typeof allowed !== 'boolean')
      fail(`expected.allowed_state_changes.${domain} must be a boolean`);
    if (result[target] !== undefined && result[target] !== allowed)
      fail(`expected.allowed_state_changes.${domain} conflicts with another welcome alias`);
    result[target] = allowed;
  }
  return result;
}

function bindingValues(value, path) {
  if (value === undefined) return [];
  if (typeof value === 'string') return [asId(value, path)];
  if (Array.isArray(value))
    return value.flatMap((item, index) => bindingValues(item, `${path}[${index}]`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => bindingValues(child, `${path}.${key}`));
  }
  fail(`${path} must contain resource IDs`);
}

function normalizeExpected(expected) {
  if (expected === null || typeof expected !== 'object') fail('expected must be an object');
  assertNoSecrets(expected);
  const guildId = asId(expected.guild_id, 'expected.guild_id');
  const botId = asId(expected.bot_id, 'expected.bot_id');
  const generatedInput = expected.generated ?? {};
  if (generatedInput === null || typeof generatedInput !== 'object')
    fail('expected.generated must be an object');
  const generated = Object.fromEntries(
    RESOURCE_KINDS.map((kind) => [
      kind,
      uniqueIds(
        idList(generatedInput[kind], `expected.generated.${kind}`),
        `expected.generated.${kind}`,
      ),
    ]),
  );
  const adoptedAutomodInput = expected.adopted_automod_rules;
  const adoptedAutomod = uniqueIds(
    idList(adoptedAutomodInput, 'expected.adopted_automod_rules'),
    'expected.adopted_automod_rules',
  );
  const adoptedAutomodTriggerTypes = automodTriggerTypeMap(
    expected.adopted_automod_trigger_types ?? (adoptedAutomod.size === 0 ? {} : undefined),
    'expected.adopted_automod_trigger_types',
    adoptedAutomod,
  );
  for (const id of adoptedAutomod) {
    if (generated.automod_rules.has(id))
      fail(`adopted AutoMod rule ${id} must not be listed as generated`);
  }
  const bindings = expected.bindings ?? {};
  if (bindings === null || typeof bindings !== 'object' || Array.isArray(bindings))
    fail('expected.bindings must be an object');
  for (const [kind, values] of Object.entries(bindings)) {
    const targetKind = RESOURCE_KINDS.includes(kind)
      ? kind
      : kind === 'publications'
        ? 'messages'
        : null;
    if (targetKind === null) fail(`unsupported binding kind ${kind}`);
    for (const id of bindingValues(values, `expected.bindings.${kind}`)) {
      const allowed =
        generated[targetKind].has(id) || (targetKind === 'automod_rules' && adoptedAutomod.has(id));
      if (!allowed) fail(`binding ${id} is not an expected generated ${targetKind} id`);
    }
  }
  const boundAutomodIds = new Set(
    bindingValues(bindings.automod_rules, 'expected.bindings.automod_rules'),
  );
  for (const id of adoptedAutomod) {
    if (!boundAutomodIds.has(id))
      fail(`adopted AutoMod rule ${id} is not an expected AutoMod binding`);
  }
  const canary = expected.canary ?? {};
  const canaryRoles = uniqueIds(
    idList(canary.roles, 'expected.canary.roles'),
    'expected.canary.roles',
  );
  const canaryChannels = uniqueIds(
    idList(canary.channels, 'expected.canary.channels'),
    'expected.canary.channels',
  );
  const generatedRolePermissions = decimalMap(
    expected.generated_role_permissions,
    'expected.generated_role_permissions',
  );
  const allowedOverwriteAllows = decimalMap(
    expected.allowed_overwrite_allows,
    'expected.allowed_overwrite_allows',
  );
  const generatedIds = Object.fromEntries(RESOURCE_KINDS.map((kind) => [kind, generated[kind]]));
  return {
    guildId,
    botId,
    generated: generatedIds,
    adoptedAutomodRules: adoptedAutomod,
    adoptedAutomodTriggerTypes,
    canary: { roles: canaryRoles, channels: canaryChannels },
    generatedRolePermissions,
    allowedOverwriteAllows,
    allowedStateChanges: allowedStateChanges(expected.allowed_state_changes),
  };
}

function stable(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
    .join(',')}}`;
}

function stableWithoutPosition(resource) {
  if (resource === null || typeof resource !== 'object' || Array.isArray(resource))
    return stable(resource);
  const normalized = { ...resource };
  delete normalized.position;
  return stable(normalized);
}

function channelOrderGroup(channel) {
  const parent = channel.parent_id === null ? '@root' : String(channel.parent_id ?? '@missing');
  const type = Number(channel.type);
  const bucket = type === 4 ? 'category' : type === 2 || type === 13 ? 'voice' : 'text';
  return `${parent}:${bucket}`;
}

function relativeOrderIssues(beforeMap, afterMap, groupOf, code) {
  const shared = [...beforeMap.keys()].filter((resourceId) => afterMap.has(resourceId));
  const issues = [];
  for (let leftIndex = 0; leftIndex < shared.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < shared.length; rightIndex += 1) {
      const leftId = shared[leftIndex];
      const rightId = shared[rightIndex];
      const beforeLeft = beforeMap.get(leftId);
      const beforeRight = beforeMap.get(rightId);
      const afterLeft = afterMap.get(leftId);
      const afterRight = afterMap.get(rightId);
      const beforeGroup = groupOf(beforeLeft);
      if (
        beforeGroup !== groupOf(beforeRight) ||
        beforeGroup !== groupOf(afterLeft) ||
        beforeGroup !== groupOf(afterRight)
      )
        continue;
      const positions = [
        beforeLeft.position,
        beforeRight.position,
        afterLeft.position,
        afterRight.position,
      ];
      if (!positions.every((position) => Number.isSafeInteger(position) && position >= 0)) continue;
      const beforeOrder = Math.sign(beforeLeft.position - beforeRight.position);
      const afterOrder = Math.sign(afterLeft.position - afterRight.position);
      if (beforeOrder === afterOrder) continue;
      issues.push(
        issue(code, {
          first_resource_id: leftId,
          second_resource_id: rightId,
          before_positions: [beforeLeft.position, beforeRight.position],
          after_positions: [afterLeft.position, afterRight.position],
        }),
      );
    }
  }
  return issues;
}

function overwriteKey(channelId, overwrite) {
  return `${channelId}:${String(overwrite.type ?? '')}:${String(overwrite.id)}`;
}

function overwriteKeyCandidates(channelId, overwrite) {
  const id = String(overwrite.id);
  const type = String(overwrite.type ?? '');
  return [
    overwriteKey(channelId, overwrite),
    `${channelId}:${id}:${type}`,
    `${channelId}:${id}`,
    `${channelId}/${type}/${id}`,
    `${channelId}/${id}`,
  ];
}

function resources(snapshot, kind) {
  if (kind !== 'messages') return Array.isArray(snapshot?.[kind]) ? snapshot[kind] : [];
  const grouped = snapshot?.recent_messages ?? {};
  return Object.values(grouped).flatMap((items) => (Array.isArray(items) ? items : []));
}

function mapResources(snapshot, kind) {
  const map = new Map();
  for (const resource of resources(snapshot, kind)) {
    if (resource?.id !== undefined) map.set(String(resource.id), resource);
  }
  return map;
}

function issue(code, details = {}) {
  return { code, ...details };
}

function safeAutomodAdoption(resource, expectedBotId, expectedTriggerType) {
  return (
    resource?.creator_id === expectedBotId &&
    SINGLETON_AUTOMOD_TRIGGER_TYPES.has(resource?.trigger_type) &&
    resource?.trigger_type === expectedTriggerType
  );
}

function permissions(value, path = 'permission bitfield') {
  const text = String(value ?? '0');
  if (!/^\d+$/.test(text)) fail(`${path} must be an unsigned decimal permission bitfield`);
  try {
    return BigInt(text);
  } catch {
    fail(`${path} must be an unsigned decimal permission bitfield`);
  }
}

function dangerousPermissionNames(value, path) {
  const bits = permissions(value, path);
  return Object.entries(DANGEROUS_PERMISSION_BITS)
    .filter(([, mask]) => (bits & mask) !== 0n)
    .map(([name]) => name);
}

function botPermissionState(snapshot, roleMap, guildId, path) {
  const assignedRoleIds = (snapshot?.bot?.roles ?? []).map(String).sort();
  const effectiveRoleIds = [...new Set([guildId, ...assignedRoleIds])].sort();
  let effectivePermissions = 0n;
  const rolePermissions = [];
  for (const roleId of effectiveRoleIds) {
    const role = roleMap.get(roleId);
    if (role === undefined) continue;
    const value = permissions(role.permissions, `${path}.roles.${roleId}.permissions`);
    effectivePermissions |= value;
    rolePermissions.push([roleId, value.toString()]);
  }
  return {
    assignedRoleIds,
    rolePermissions,
    admin: (effectivePermissions & DANGEROUS_PERMISSION_BITS.ADMINISTRATOR) !== 0n,
  };
}

function identity(before, after, expected, roleMaps) {
  const beforeGuildId = before?.guild?.id ?? null;
  const afterGuildId = after?.guild?.id ?? null;
  const beforeBotId = before?.bot?.user?.id ?? null;
  const afterBotId = after?.bot?.user?.id ?? null;
  const beforePermissions = botPermissionState(before, roleMaps.before, expected.guildId, 'before');
  const afterPermissions = botPermissionState(after, roleMaps.after, expected.guildId, 'after');
  return {
    expected_guild_id: expected.guildId,
    before_guild_id: beforeGuildId,
    after_guild_id: afterGuildId,
    expected_bot_id: expected.botId,
    before_bot_id: beforeBotId,
    after_bot_id: afterBotId,
    guild_match: beforeGuildId === expected.guildId && afterGuildId === expected.guildId,
    bot_match: beforeBotId === expected.botId && afterBotId === expected.botId,
    bot_admin_before: beforePermissions.admin,
    bot_admin_after: afterPermissions.admin,
    bot_permissions_unchanged:
      stable(beforePermissions.assignedRoleIds) === stable(afterPermissions.assignedRoleIds) &&
      stable(beforePermissions.rolePermissions) === stable(afterPermissions.rolePermissions),
  };
}

export function compareSnapshots(before, after, expectedInput) {
  const expected = normalizeExpected(expectedInput);
  const serious = [];
  const functional = [];
  const maps = Object.fromEntries(
    RESOURCE_KINDS.map((kind) => [
      kind,
      { before: mapResources(before, kind), after: mapResources(after, kind) },
    ]),
  );
  const id = identity(before, after, expected, maps.roles);
  if (!id.guild_match || !id.bot_match) serious.push(issue('IDENTITY_MISMATCH', { identity: id }));
  if (
    stable((before?.bot?.roles ?? []).map(String).sort()) !==
    stable((after?.bot?.roles ?? []).map(String).sort())
  ) {
    serious.push(issue('BOT_ROLE_ASSIGNMENTS_CHANGED'));
  }
  for (const resourceId of expected.adoptedAutomodRules) {
    const beforeResource = maps.automod_rules.before.get(resourceId);
    const afterResource = maps.automod_rules.after.get(resourceId);
    const expectedTriggerType = expected.adoptedAutomodTriggerTypes.get(resourceId);
    if (beforeResource === undefined)
      serious.push(
        issue('ADOPTED_AUTOMOD_RULE_MISSING_BEFORE', {
          resource_id: resourceId,
          snapshot: 'before',
        }),
      );
    if (afterResource === undefined)
      serious.push(
        issue('ADOPTED_AUTOMOD_RULE_MISSING_AFTER', {
          resource_id: resourceId,
          snapshot: 'after',
        }),
      );
    if (
      beforeResource !== undefined &&
      afterResource !== undefined &&
      (!safeAutomodAdoption(beforeResource, expected.botId, expectedTriggerType) ||
        !safeAutomodAdoption(afterResource, expected.botId, expectedTriggerType))
    )
      serious.push(
        issue('UNSAFE_PREEXISTING_AUTOMOD_ADOPTION', {
          resource_id: resourceId,
        }),
      );
  }
  for (const [domain, snapshotKey] of STATE_CHANGE_DOMAINS) {
    if (stable(before?.[snapshotKey] ?? null) === stable(after?.[snapshotKey] ?? null)) continue;
    if (expected.allowedStateChanges[domain] === true) continue;
    const code = `UNEXPECTED_${domain.toUpperCase()}_STATE_CHANGED`;
    const details = {
      domain,
      before: before?.[snapshotKey] ?? null,
      after: after?.[snapshotKey] ?? null,
    };
    serious.push(issue(code, details));
    functional.push(issue(code, details));
  }
  const observed = { created: {}, deleted: {} };
  for (const kind of RESOURCE_KINDS) {
    const created = [...maps[kind].after.keys()].filter(
      (resourceId) => !maps[kind].before.has(resourceId),
    );
    const deleted = [...maps[kind].before.keys()].filter(
      (resourceId) => !maps[kind].after.has(resourceId),
    );
    observed.created[kind] = created;
    observed.deleted[kind] = deleted;
    for (const resourceId of created) {
      if (!expected.generated[kind].has(resourceId))
        serious.push(
          issue(`UNEXPECTED_${kind.slice(0, -1).toUpperCase()}_CREATED`, {
            kind,
            resource_id: resourceId,
          }),
        );
    }
    for (const resourceId of deleted) {
      if (expected.generated[kind].has(resourceId))
        functional.push(
          issue(`GENERATED_${kind.slice(0, -1).toUpperCase()}_MISSING`, {
            kind,
            resource_id: resourceId,
          }),
        );
      else if (kind === 'roles' || kind === 'channels') {
        const code = expected.canary[kind].has(resourceId)
          ? `CANARY_${kind.slice(0, -1).toUpperCase()}_DELETED`
          : kind === 'roles' && maps[kind].before.get(resourceId)?.managed
            ? 'MANAGED_ROLE_DELETED'
            : `PREEXISTING_${kind.slice(0, -1).toUpperCase()}_DELETED`;
        serious.push(issue(code, { kind, resource_id: resourceId }));
      } else
        serious.push(
          issue(`PREEXISTING_${kind.slice(0, -1).toUpperCase()}_DELETED`, {
            kind,
            resource_id: resourceId,
          }),
        );
    }
    for (const resourceId of expected.generated[kind]) {
      if (maps[kind].before.has(resourceId))
        functional.push(
          issue(`GENERATED_${kind.slice(0, -1).toUpperCase()}_ID_PREEXISTED`, {
            kind,
            resource_id: resourceId,
          }),
        );
      if (!maps[kind].after.has(resourceId))
        functional.push(
          issue(`GENERATED_${kind.slice(0, -1).toUpperCase()}_MISSING`, {
            kind,
            resource_id: resourceId,
          }),
        );
    }
  }

  const botRoleIds = new Set((before?.bot?.roles ?? []).map(String));
  const afterBotRoleIds = new Set((after?.bot?.roles ?? []).map(String));
  const botRolePositions = [...afterBotRoleIds]
    .map((roleId) => maps.roles.after.get(roleId)?.position)
    .filter((position) => typeof position === 'number');
  const highestBotRole = botRolePositions.length ? Math.max(...botRolePositions) : null;
  for (const [resourceId, beforeRole] of maps.roles.before) {
    const afterRole = maps.roles.after.get(resourceId);
    if (!afterRole) continue;
    if (stableWithoutPosition(beforeRole) !== stableWithoutPosition(afterRole)) {
      if (
        botRoleIds.has(resourceId) &&
        String(beforeRole.permissions ?? '0') !== String(afterRole.permissions ?? '0')
      ) {
        serious.push(
          issue('BOT_ROLE_PERMISSIONS_CHANGED', {
            resource_id: resourceId,
            before: String(beforeRole.permissions ?? '0'),
            after: String(afterRole.permissions ?? '0'),
          }),
        );
      } else if (expected.canary.roles.has(resourceId)) {
        serious.push(issue('CANARY_ROLE_CHANGED', { resource_id: resourceId }));
      } else if (beforeRole.managed) {
        serious.push(issue('MANAGED_ROLE_CHANGED', { resource_id: resourceId }));
      } else {
        serious.push(issue('PREEXISTING_ROLE_CHANGED', { resource_id: resourceId }));
      }
    }
  }
  serious.push(
    ...relativeOrderIssues(
      maps.roles.before,
      maps.roles.after,
      () => 'roles',
      'PREEXISTING_ROLE_ORDER_CHANGED',
    ),
  );
  for (const resourceId of expected.generated.roles) {
    const role = maps.roles.after.get(resourceId);
    if (!role) continue;
    const actualPermissions = permissions(
      role.permissions,
      `after.roles.${resourceId}.permissions`,
    );
    const allowedPermissions = permissions(
      expected.generatedRolePermissions[resourceId] ?? '0',
      `expected.generated_role_permissions.${resourceId}`,
    );
    const outsideAllowlist = actualPermissions & ~allowedPermissions;
    if (outsideAllowlist !== 0n)
      serious.push(
        issue('GENERATED_ROLE_PERMISSION_OUTSIDE_ALLOWLIST', {
          resource_id: resourceId,
          actual: actualPermissions.toString(),
          expected_allow: allowedPermissions.toString(),
          unexpected_bits: outsideAllowlist.toString(),
        }),
      );
    const dangerous = dangerousPermissionNames(
      actualPermissions,
      `after.roles.${resourceId}.permissions`,
    );
    if (dangerous.length)
      serious.push(
        issue('GENERATED_ROLE_DANGEROUS_PERMISSION', {
          resource_id: resourceId,
          permissions: dangerous,
        }),
      );
    if (role.managed) serious.push(issue('GENERATED_ROLE_MANAGED', { resource_id: resourceId }));
    if (highestBotRole !== null && Number(role.position ?? 0) >= highestBotRole)
      serious.push(
        issue('GENERATED_ROLE_AT_OR_ABOVE_BOT', {
          resource_id: resourceId,
          position: role.position,
          highest_bot_role_position: highestBotRole,
        }),
      );
  }

  for (const kind of ['channels', 'automod_rules', 'messages']) {
    for (const [resourceId, resource] of maps[kind].after) {
      if (resource.guild_id !== undefined && resource.guild_id !== expected.guildId) {
        serious.push(
          issue('RESOURCE_GUILD_MISMATCH', {
            kind,
            resource_id: resourceId,
            guild_id: resource.guild_id,
          }),
        );
      }
    }
  }

  for (const [resourceId, beforeChannel] of maps.channels.before) {
    const afterChannel = maps.channels.after.get(resourceId);
    if (!afterChannel) continue;
    if (stableWithoutPosition(beforeChannel) !== stableWithoutPosition(afterChannel)) {
      serious.push(
        issue(
          expected.canary.channels.has(resourceId)
            ? 'CANARY_CHANNEL_CHANGED'
            : 'PREEXISTING_CHANNEL_CHANGED',
          { resource_id: resourceId },
        ),
      );
    }
  }
  serious.push(
    ...relativeOrderIssues(
      maps.channels.before,
      maps.channels.after,
      channelOrderGroup,
      'PREEXISTING_CHANNEL_ORDER_CHANGED',
    ),
  );
  for (const kind of ['automod_rules', 'messages']) {
    for (const [resourceId, beforeResource] of maps[kind].before) {
      const afterResource = maps[kind].after.get(resourceId);
      if (afterResource === undefined) continue;
      if (stable(beforeResource) !== stable(afterResource)) {
        if (
          kind === 'automod_rules' &&
          expected.adoptedAutomodRules.has(resourceId) &&
          safeAutomodAdoption(
            beforeResource,
            expected.botId,
            expected.adoptedAutomodTriggerTypes.get(resourceId),
          ) &&
          safeAutomodAdoption(
            maps.automod_rules.after.get(resourceId),
            expected.botId,
            expected.adoptedAutomodTriggerTypes.get(resourceId),
          )
        )
          continue;
        serious.push(
          issue(`PREEXISTING_${kind.slice(0, -1).toUpperCase()}_CHANGED`, {
            resource_id: resourceId,
          }),
        );
      }
    }
  }
  for (const [resourceId, channel] of maps.channels.after) {
    const beforeChannel = maps.channels.before.get(resourceId);
    const beforeOverwrites = new Map(
      (beforeChannel?.permission_overwrites ?? []).map((overwrite) => [
        String(overwrite.id),
        overwrite,
      ]),
    );
    for (const overwrite of channel.permission_overwrites ?? []) {
      const old = beforeOverwrites.get(String(overwrite.id));
      const actualAllow = permissions(
        overwrite.allow,
        `after.channels.${resourceId}.overwrites.allow`,
      );
      const previousAllow = permissions(
        old?.allow ?? '0',
        `before.channels.${resourceId}.overwrites.allow`,
      );
      const newlyAllowed = actualAllow & ~previousAllow;
      const expectedKey = overwriteKeyCandidates(resourceId, overwrite).find((key) =>
        Object.hasOwn(expected.allowedOverwriteAllows, key),
      );
      const allowedOverwrite =
        expectedKey === undefined
          ? null
          : permissions(
              expected.allowedOverwriteAllows[expectedKey],
              `expected.allowed_overwrite_allows.${expectedKey}`,
            );
      const outsideAllowlist =
        allowedOverwrite === null ? newlyAllowed : actualAllow & ~allowedOverwrite;
      if (outsideAllowlist !== 0n)
        serious.push(
          issue('OVERWRITE_ALLOW_OUTSIDE_ALLOWLIST', {
            channel_id: resourceId,
            overwrite_id: String(overwrite.id),
            overwrite_key: overwriteKey(resourceId, overwrite),
            actual: actualAllow.toString(),
            expected_allow: (allowedOverwrite ?? 0n).toString(),
            unexpected_bits: outsideAllowlist.toString(),
          }),
        );
      const dangerous = dangerousPermissionNames(
        newlyAllowed,
        `after.channels.${resourceId}.overwrites.newly_allowed`,
      );
      if (dangerous.length)
        serious.push(
          issue('DANGEROUS_OVERWRITE_ALLOW', {
            channel_id: resourceId,
            overwrite_id: String(overwrite.id),
            permissions: dangerous,
          }),
        );
    }
  }

  return {
    pass: serious.length === 0 && functional.length === 0,
    identity: id,
    serious_permission_failures: serious,
    functional_failures: functional,
    observed,
    highest_bot_role_position: highestBotRole,
  };
}

export { DANGEROUS_PERMISSION_BITS };
