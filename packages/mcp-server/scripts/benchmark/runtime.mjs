import { readAuditCursor, readAuditTrail, verifyBlueprintAuditTrail } from './audit-trail.mjs';
import { verifyBlueprintSnapshot } from './blueprint-oracle.mjs';
import { createDiscordRestClient, readDiscordSnapshot } from './discord-rest.mjs';
import { buildBenchmarkExpectations } from './expectations.mjs';
import { openMcpBenchmarkSession } from './mcp-session.mjs';
import { compareSnapshots } from './oracle.mjs';
import { snapshotFingerprint } from './snapshot-fingerprint.mjs';

export function createTrialDependencies({
  token,
  apiBaseUrl,
  fetchImpl,
  sleep,
  maxAttempts,
  timeoutMs,
} = {}) {
  const rest = createDiscordRestClient({
    token,
    ...(apiBaseUrl === undefined ? {} : { apiBaseUrl }),
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    ...(sleep === undefined ? {} : { sleep }),
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return {
    rest,
    openSession: openMcpBenchmarkSession,
    readSnapshot: (options) => readDiscordSnapshot(rest, options),
    snapshotFingerprint,
    readAuditCursor: (options) => readAuditCursor(rest, options),
    readAuditTrail: (options) => readAuditTrail(rest, options),
    buildExpectations: buildBenchmarkExpectations,
    compareSnapshots,
    verifyBlueprintSnapshot,
    verifyAuditTrail: verifyBlueprintAuditTrail,
  };
}
