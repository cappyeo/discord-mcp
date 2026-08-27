import type { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';

const APPLICATION_ID_RE = /^\d{17,20}$/;

interface CurrentApplicationResponse {
  readonly id?: unknown;
}

// Application identity is stable for the lifetime of a REST client (which is
// also the lifetime of one configured bot credential). Keep the lookup small
// and process-local; no application or credential data is persisted.
const currentApplicationIds = new WeakMap<REST, Promise<string>>();

/**
 * Resolve an omitted application_id to the application belonging to the
 * authenticated bot. Explicit IDs are preserved for backwards compatibility;
 * Discord still remains the authority for route authorization in that case.
 */
export function resolveApplicationId(
  rest: REST,
  applicationId: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  if (applicationId !== undefined) return Promise.resolve(applicationId);

  const cached = currentApplicationIds.get(rest);
  if (cached !== undefined) return cached;

  const pending = (async () => {
    const raw = (await rest.get(Routes.currentApplication(), {
      signal,
    })) as CurrentApplicationResponse;
    if (typeof raw.id !== 'string' || !APPLICATION_ID_RE.test(raw.id)) {
      throw new Error('Discord /applications/@me returned an invalid application ID');
    }
    return raw.id;
  })().catch((error: unknown) => {
    currentApplicationIds.delete(rest);
    throw error;
  });
  currentApplicationIds.set(rest, pending);
  return pending;
}
