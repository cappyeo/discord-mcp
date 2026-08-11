/**
 * Independent audit-log observer for the real Discord benchmark.
 *
 * This module intentionally has no dependency on the production reconciler.
 * It treats the audit log as the authority for mutations, including mutations
 * which were subsequently overwritten by a safer update.
 */

const AUDIT_PAGE_SIZE = 100;
const SNOWFLAKE = /^\d{17,20}$/;
const BLUEPRINT_ID = /^sha256:[0-9a-f]{64}$/;
const DANGEROUS_BITS = Object.freeze({
  ADMINISTRATOR: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_GUILD: 1n << 5n,
  MANAGE_ROLES: 1n << 28n,
});

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function snowflake(value, label) {
  if (typeof value !== 'string' || !SNOWFLAKE.test(value))
    throw new TypeError(`${label} must be a Discord snowflake`);
  return value;
}

function ids(value, label) {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return [snowflake(value, label)];
  if (Array.isArray(value)) return value.flatMap((item) => ids(item, label));
  if (record(value)) return Object.values(value).flatMap((item) => ids(item, label));
  throw new TypeError(`${label} must contain Discord snowflakes`);
}

function uniqueIds(value, label) {
  const result = new Set();
  for (const id of ids(value, label)) {
    if (result.has(id)) throw new TypeError(`${label} contains duplicate id ${id}`);
    result.add(id);
  }
  return result;
}

function auditEntryId(value, label) {
  return snowflake(value, label);
}

function permissionBits(value, label) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new TypeError(`${label} must be an unsigned decimal permission bitfield`);
  }
  try {
    return BigInt(value);
  } catch {
    throw new TypeError(`${label} must be an unsigned decimal permission bitfield`);
  }
}

function allowlistMap(value, label) {
  if (value === undefined || value === null) return {};
  if (!record(value)) throw new TypeError(`${label} must be an object`);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      permissionBits(item, `${label}.${key}`).toString(),
    ]),
  );
}

function issue(code, entry, details = {}) {
  return { code, entry_id: entry?.id, action_type: entry?.action_type, ...details };
}

function generatedBindingIds(bindings, kind) {
  return uniqueIds(bindings?.[kind], `bindings.${kind}`);
}

function expectedAllowMap(expected, names) {
  for (const name of names) {
    if (expected?.[name] !== undefined) return allowlistMap(expected[name], `expected.${name}`);
  }
  return {};
}

function expectedPromptIds(expected) {
  const candidates = [
    expected?.onboarding_prompt_ids,
    expected?.onboarding_prompts,
    expected?.generated?.onboarding_prompts,
    expected?.generated?.onboarding_prompt_ids,
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined) return uniqueIds(candidate, 'expected onboarding prompt IDs');
  }
  return new Set();
}

function snapshotPromptIds(snapshot) {
  return uniqueIds(
    (snapshot?.onboarding?.prompts ?? []).map((prompt) => prompt?.id),
    'snapshot onboarding prompt IDs',
  );
}

function overwriteKeyCandidates(channelId, overwriteId, type) {
  const id = String(overwriteId);
  const kind = type === undefined || type === null ? '' : String(type);
  return [
    `${channelId}:${kind}:${id}`,
    `${channelId}:${id}:${kind}`,
    `${channelId}:${id}`,
    `${channelId}/${kind}/${id}`,
    `${channelId}/${id}`,
    id,
  ];
}

function extractOverwriteId(change, entry) {
  const fromOptions = entry?.options?.id ?? entry?.options?.overwrite_id;
  if (fromOptions !== undefined) {
    return { id: String(fromOptions), type: entry.options.type };
  }
  const value = change?.new_value;
  if (record(value) && value.id !== undefined) return { id: String(value.id), type: value.type };
  for (const candidate of Array.isArray(entry?.changes) ? entry.changes : []) {
    const nested = candidate?.new_value;
    if (record(nested) && nested.id !== undefined) {
      return { id: String(nested.id), type: nested.type };
    }
    if (Array.isArray(nested)) {
      const overwrite = nested.find((item) => record(item) && item.id !== undefined);
      if (overwrite) return { id: String(overwrite.id), type: overwrite.type };
    }
  }
  return null;
}

function checkPermissionBits({ value, allowed, path, entry, kind, serious }) {
  let actual;
  try {
    actual = permissionBits(value, path);
  } catch (error) {
    serious.push(issue('MALFORMED_PERMISSION_BITFIELD', entry, { kind, error: error.message }));
    return;
  }
  let expected = 0n;
  try {
    expected = permissionBits(allowed ?? '0', `${path}.expected_allow`);
  } catch (error) {
    serious.push(
      issue('MALFORMED_EXPECTED_PERMISSION_ALLOWLIST', entry, { kind, error: error.message }),
    );
    return;
  }
  const unexpected = actual & ~expected;
  if (unexpected !== 0n) {
    serious.push(
      issue('PERMISSION_OUTSIDE_ALLOWLIST', entry, {
        kind,
        actual: actual.toString(),
        expected_allow: expected.toString(),
        unexpected_bits: unexpected.toString(),
      }),
    );
  }
  const dangerous = Object.entries(DANGEROUS_BITS)
    .filter(([, bit]) => (actual & bit) !== 0n)
    .map(([name]) => name);
  if (dangerous.length)
    serious.push(issue('DANGEROUS_PERMISSION', entry, { kind, permissions: dangerous }));
}

function inspectOverwriteAllow(value, entry, overwriteAllows, serious, path) {
  if (!record(value) || value.allow === undefined) {
    serious.push(issue('MALFORMED_PERMISSION_OVERWRITE', entry));
    return;
  }
  const key =
    value.id === undefined
      ? undefined
      : overwriteKeyCandidates(entry.target_id, value.id, value.type).find((item) =>
          Object.hasOwn(overwriteAllows, item),
        );
  checkPermissionBits({
    value: value.allow,
    allowed: key === undefined ? '0' : overwriteAllows[key],
    path,
    entry,
    kind: 'overwrite_allow',
    serious,
  });
}

function inspectChange(entry, change, roleAllows, overwriteAllows, serious) {
  if (!record(change) || typeof change.key !== 'string') {
    serious.push(issue('MALFORMED_AUDIT_CHANGE', entry));
    return;
  }
  if (change.key === 'permissions') {
    checkPermissionBits({
      value: change.new_value,
      allowed: roleAllows[entry.target_id] ?? '0',
      path: `entry ${entry.id} permissions`,
      entry,
      kind: 'role_permissions',
      serious,
    });
    return;
  }
  if (change.key === 'allow') {
    const overwrite = extractOverwriteId(change, entry);
    const key = overwrite
      ? overwriteKeyCandidates(entry.target_id, overwrite.id, overwrite.type).find((item) =>
          Object.hasOwn(overwriteAllows, item),
        )
      : undefined;
    checkPermissionBits({
      value: change.new_value,
      allowed: key === undefined ? '0' : overwriteAllows[key],
      path: `entry ${entry.id} overwrite allow`,
      entry,
      kind: 'overwrite_allow',
      serious,
    });
    return;
  }
  if (change.key === 'permission_overwrites') {
    if (!Array.isArray(change.new_value)) {
      serious.push(issue('MALFORMED_PERMISSION_OVERWRITES', entry));
      return;
    }
    for (const overwriteChange of change.new_value)
      inspectOverwriteAllow(
        overwriteChange,
        entry,
        overwriteAllows,
        serious,
        `entry ${entry.id} permission_overwrites allow`,
      );
    return;
  }
  if (record(change.new_value) && change.new_value.allow !== undefined) {
    inspectOverwriteAllow(
      change.new_value,
      entry,
      overwriteAllows,
      serious,
      `entry ${entry.id} overwrite allow`,
    );
  }
}

function checkEntryTarget(entry, guildId, botId, bindings, promptIds, serious, functional) {
  const action = entry.action_type;
  const target = entry.target_id;
  const roles = generatedBindingIds(bindings, 'roles');
  const categories = generatedBindingIds(bindings, 'categories');
  const channels = generatedBindingIds(bindings, 'channels');
  const automod = generatedBindingIds(bindings, 'automod_rules');
  let allowed = false;
  if (action === 1) allowed = target === guildId;
  else if (action === 10 || action === 11) allowed = categories.has(target) || channels.has(target);
  else if (action === 13 || action === 14) allowed = categories.has(target) || channels.has(target);
  else if (action === 30 || action === 31) allowed = roles.has(target);
  else if (action === 140 || action === 141) allowed = automod.has(target);
  else if (action === 163 || action === 164) allowed = promptIds.has(target);
  else if (action === 166 || action === 167) allowed = target === guildId;
  if (action === 25) {
    serious.push(issue('MEMBER_ROLE_MUTATION', entry, { target_id: target }));
  }
  if (!allowed)
    functional.push(issue('UNEXPECTED_AUDIT_ACTION_OR_TARGET', entry, { target_id: target }));
  if (action === 13 || action === 14) {
    const overwrite = extractOverwriteId(null, entry);
    const knownTargets = new Set([guildId, botId, ...roles]);
    if (overwrite === null || !knownTargets.has(overwrite.id)) {
      functional.push(issue('UNKNOWN_OVERWRITE_TARGET', entry, { overwrite_id: overwrite?.id }));
    }
  }
}

export async function readAuditTrail(
  rest,
  { guildId, afterEntryId = null, maxEntries = 1000, signal } = {},
) {
  if (rest === null || typeof rest?.get !== 'function') throw new TypeError('rest.get is required');
  snowflake(guildId, 'guildId');
  if (afterEntryId !== null) auditEntryId(afterEntryId, 'afterEntryId');
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 1000)
    throw new TypeError('maxEntries must be an integer from 1 to 1000');

  const entries = [];
  const seen = new Set();
  let before = null;
  let previousOldest = null;
  for (;;) {
    const path = `/guilds/${guildId}/audit-logs?limit=${AUDIT_PAGE_SIZE}${before === null ? '' : `&before=${before}`}`;
    const body = await rest.get(path, { signal });
    if (!record(body) || !Array.isArray(body.audit_log_entries))
      throw new Error('audit log response is malformed');
    const page = body.audit_log_entries;
    if (page.length > AUDIT_PAGE_SIZE) throw new Error('audit log page exceeds Discord limit');
    let oldest = null;
    for (const [index, entry] of page.entries()) {
      if (!record(entry)) throw new Error(`audit log entry ${index} is malformed`);
      const id = auditEntryId(entry.id, `audit log entry ${index} id`);
      if (seen.has(id)) throw new Error(`duplicate audit log entry id ${id}`);
      seen.add(id);
      if (oldest !== null && BigInt(id) >= BigInt(oldest))
        throw new Error('audit log page is not newest-to-oldest');
      oldest = id;
    }
    if (oldest !== null && previousOldest !== null && BigInt(oldest) >= BigInt(previousOldest))
      throw new Error('audit log pagination stalled');
    if (oldest !== null) previousOldest = oldest;

    if (afterEntryId !== null) {
      const baselineIndex = page.findIndex((entry) => entry.id === afterEntryId);
      if (baselineIndex !== -1) {
        if (entries.length + baselineIndex > maxEntries) {
          throw new Error('audit log baseline was not found before cap');
        }
        entries.push(...page.slice(0, baselineIndex));
        return { entries, complete: true };
      }
    }
    entries.push(...page);
    if (entries.length >= maxEntries) {
      if (afterEntryId !== null) throw new Error('audit log baseline was not found before cap');
      entries.length = maxEntries;
      return { entries, complete: false };
    }
    if (page.length < AUDIT_PAGE_SIZE) {
      if (afterEntryId !== null) throw new Error('audit log baseline was not found');
      return { entries, complete: true };
    }
    if (oldest === null || oldest === before) throw new Error('audit log pagination stalled');
    before = oldest;
  }
}

export async function readAuditCursor(rest, { guildId, signal } = {}) {
  if (rest === null || typeof rest?.get !== 'function') throw new TypeError('rest.get is required');
  snowflake(guildId, 'guildId');
  const body = await rest.get(`/guilds/${guildId}/audit-logs?limit=1`, { signal });
  if (!record(body) || !Array.isArray(body.audit_log_entries)) {
    throw new Error('audit log cursor response is malformed');
  }
  if (body.audit_log_entries.length > 1)
    throw new Error('audit log cursor returned too many entries');
  const entry = body.audit_log_entries[0];
  if (entry === undefined) return null;
  if (!record(entry)) throw new Error('audit log cursor entry is malformed');
  return auditEntryId(entry.id, 'audit log cursor entry id');
}

export function verifyBlueprintAuditTrail({
  entries,
  complete = false,
  botId,
  guildId,
  blueprintId,
  bindings,
  expected,
  beforeSnapshot,
  snapshot,
} = {}) {
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array');
  snowflake(botId, 'botId');
  snowflake(guildId, 'guildId');
  if (typeof blueprintId !== 'string' || !BLUEPRINT_ID.test(blueprintId))
    throw new TypeError('blueprintId must be a sha256 blueprint ID');
  if (!record(bindings)) throw new TypeError('bindings must be an object');
  if (!record(expected)) throw new TypeError('expected must be an object');
  const roleAllows = expectedAllowMap(expected, ['generated_role_permissions', 'role_permissions']);
  const overwriteAllows = expectedAllowMap(expected, [
    'allowed_overwrite_allows',
    'overwrite_allows',
  ]);
  const beforePromptIds = snapshotPromptIds(beforeSnapshot);
  const generatedPromptIds = [...snapshotPromptIds(snapshot)].filter(
    (promptId) => !beforePromptIds.has(promptId),
  );
  const promptIds = new Set([...expectedPromptIds(expected), ...generatedPromptIds]);
  const reasonPrefix = `discord-mcp blueprint ${blueprintId.slice(7, 19)} `;
  const serious = [];
  const functional = [];
  if (complete !== true) functional.push({ code: 'AUDIT_TRAIL_INCOMPLETE' });
  const seen = new Set();
  for (const [index, entry] of entries.entries()) {
    if (!record(entry)) {
      functional.push({ code: 'MALFORMED_AUDIT_ENTRY', index });
      continue;
    }
    try {
      auditEntryId(entry.id, `audit entry ${index} id`);
    } catch {
      functional.push({ code: 'MALFORMED_AUDIT_ENTRY_ID', index });
    }
    if (seen.has(entry.id)) functional.push(issue('DUPLICATE_AUDIT_ENTRY', entry));
    seen.add(entry.id);
    if (entry.user_id !== botId) functional.push(issue('FOREIGN_AUDIT_ACTOR', entry));
    if (typeof entry.reason !== 'string' || !entry.reason.startsWith(reasonPrefix))
      functional.push(issue('UNEXPECTED_AUDIT_REASON', entry));
    if (!Number.isInteger(entry.action_type)) functional.push(issue('UNKNOWN_AUDIT_ACTION', entry));
    if (typeof entry.target_id !== 'string' || !SNOWFLAKE.test(entry.target_id))
      functional.push(issue('MALFORMED_AUDIT_TARGET', entry));
    checkEntryTarget(entry, guildId, botId, bindings, promptIds, serious, functional);
    if (entry.changes !== undefined && !Array.isArray(entry.changes))
      serious.push(issue('MALFORMED_AUDIT_CHANGES', entry));
    for (const change of Array.isArray(entry.changes) ? entry.changes : [])
      inspectChange(entry, change, roleAllows, overwriteAllows, serious);
  }
  return {
    pass: serious.length === 0 && functional.length === 0,
    serious_permission_failures: serious,
    functional_failures: functional,
    observed_count: entries.length,
  };
}

export { DANGEROUS_BITS };
