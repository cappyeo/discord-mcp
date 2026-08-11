import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib';
import {
  type GuildBlueprintPlanPayload,
  GuildBlueprintPlanPayloadSchema,
} from './blueprint.execution.schema.js';
import { canonicalJson } from './blueprint.validation.js';

const TOKEN_PATTERN = /^dmbp1\.([a-f0-9]{64})\.([a-f0-9]{64})\.([A-Za-z0-9_-]+)$/;
const MAX_TOKEN_BYTES = 64 * 1024;
const MAX_JSON_BYTES = 512 * 1024;

export class BlueprintPlanTokenError extends Error {
  public override readonly name = 'BlueprintPlanTokenError';

  public constructor(
    public readonly code: 'PLAN_TOKEN_INVALID' | 'PLAN_TOKEN_TOO_LARGE',
    message: string,
  ) {
    super(message);
  }
}

function planDigest(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex');
}

function authenticationCode(digest: string, encodedPayload: string, signingSecret: string): string {
  return createHmac('sha256', signingSecret)
    .update(`discord-mcp-blueprint-token.v1\0${digest}\0${encodedPayload}`)
    .digest('hex');
}

function approvalId(planId: string, signingSecret: string): string {
  return `sha256:${createHmac('sha256', signingSecret)
    .update(`discord-mcp-blueprint-approval.v1\0${planId}`)
    .digest('hex')}`;
}

function equalHex(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/**
 * Encode a compact caller-carried plan. A profile-secret HMAC authenticates
 * the exact payload and approval id to this bot profile. It complements rather
 * than replaces the expected-bot lock, guild allowlist, and confirmation gate.
 */
export function encodeBlueprintPlan(
  payload: GuildBlueprintPlanPayload,
  signingSecret: string,
): {
  plan_id: string;
  approval_id: string;
  plan_token: string;
} {
  const parsed = GuildBlueprintPlanPayloadSchema.parse(payload);
  const canonical = canonicalJson(parsed);
  if (Buffer.byteLength(canonical, 'utf8') > MAX_JSON_BYTES) {
    throw new BlueprintPlanTokenError('PLAN_TOKEN_TOO_LARGE', 'Blueprint plan JSON is too large.');
  }
  const digest = planDigest(canonical);
  const compressed = brotliCompressSync(Buffer.from(canonical, 'utf8'), {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
      [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
    },
  });
  const encodedPayload = compressed.toString('base64url');
  const mac = authenticationCode(digest, encodedPayload, signingSecret);
  const planToken = `dmbp1.${digest}.${mac}.${encodedPayload}`;
  if (Buffer.byteLength(planToken, 'utf8') > MAX_TOKEN_BYTES) {
    throw new BlueprintPlanTokenError(
      'PLAN_TOKEN_TOO_LARGE',
      'Compressed blueprint plan is too large.',
    );
  }
  const planId = `sha256:${digest}`;
  return {
    plan_id: planId,
    approval_id: approvalId(planId, signingSecret),
    plan_token: planToken,
  };
}

export function decodeBlueprintPlan(
  planToken: string,
  signingSecret: string,
): {
  payload: GuildBlueprintPlanPayload;
  plan_id: string;
  approval_id: string;
} {
  if (Buffer.byteLength(planToken, 'utf8') > MAX_TOKEN_BYTES) {
    throw new BlueprintPlanTokenError('PLAN_TOKEN_TOO_LARGE', 'Blueprint plan token is too large.');
  }
  const match = TOKEN_PATTERN.exec(planToken);
  if (match === null) {
    throw new BlueprintPlanTokenError(
      'PLAN_TOKEN_INVALID',
      'Blueprint plan token format is invalid.',
    );
  }
  const expectedMac = authenticationCode(match[1]!, match[3]!, signingSecret);
  if (!equalHex(match[2]!, expectedMac)) {
    throw new BlueprintPlanTokenError(
      'PLAN_TOKEN_INVALID',
      'Blueprint plan token authentication failed.',
    );
  }
  let json: string;
  try {
    const compressed = Buffer.from(match[3]!, 'base64url');
    json = brotliDecompressSync(compressed, { maxOutputLength: MAX_JSON_BYTES }).toString('utf8');
  } catch {
    throw new BlueprintPlanTokenError(
      'PLAN_TOKEN_INVALID',
      'Blueprint plan token could not be decompressed safely.',
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new BlueprintPlanTokenError(
      'PLAN_TOKEN_INVALID',
      'Blueprint plan token JSON is invalid.',
    );
  }
  const parsed = GuildBlueprintPlanPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BlueprintPlanTokenError(
      'PLAN_TOKEN_INVALID',
      'Blueprint plan token violates the current plan schema.',
    );
  }
  const canonical = canonicalJson(parsed.data);
  const digest = planDigest(canonical);
  if (digest !== match[1]) {
    throw new BlueprintPlanTokenError(
      'PLAN_TOKEN_INVALID',
      'Blueprint plan token checksum does not match its payload.',
    );
  }
  const planId = `sha256:${digest}`;
  return {
    payload: parsed.data,
    plan_id: planId,
    approval_id: approvalId(planId, signingSecret),
  };
}
