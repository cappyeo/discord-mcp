import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/** One issued access token, keyed by the token value the client holds. */
const GrantSchema = z.object({
  userId: z.string(),
  username: z.string().nullable().optional(),
  clientId: z.string(),
  scope: z.string(),
  expiresAt: z.number(),
});

export interface Grant {
  readonly userId: string;
  /** Discord username, for human-readable attribution of created resources. */
  readonly username: string | null;
  readonly clientId: string;
  readonly scope: string;
  readonly expiresAt: number;
}

/**
 * Where issued broker tokens live between requests.
 *
 * The broker issues its own tokens, so their lifetime is this process's
 * choice - not Discord's. Keeping them only in memory means every restart and
 * every deploy silently logs out every connected client.
 */
export interface GrantStore {
  /** The grant for a token, or undefined when unknown or expired. */
  get(token: string): Grant | undefined;
  set(token: string, grant: Grant): void;
}

/** Process-local store: correct for a single long-lived process, lost on restart. */
export class MemoryGrantStore implements GrantStore {
  private readonly grants = new Map<string, Grant>();
  private readonly now: () => number;

  public constructor(now: () => number = Date.now) {
    this.now = now;
  }

  public get(token: string): Grant | undefined {
    const grant = this.grants.get(token);
    if (grant === undefined) return undefined;
    if (grant.expiresAt <= this.now()) {
      this.grants.delete(token);
      return undefined;
    }
    return grant;
  }

  public set(token: string, grant: Grant): void {
    this.grants.set(token, grant);
  }
}

/**
 * File-backed store so issued tokens survive a process restart.
 *
 * Single-host only: two replicas do not share this file, so they would not
 * honour each other's tokens. Writes are atomic (temp file + rename) and the
 * file is created 0600 because it is bearer material.
 */
export class FileGrantStore implements GrantStore {
  private readonly path: string;
  private readonly now: () => number;
  private loaded = false;
  private grants = new Map<string, Grant>();

  private readonly warn: (message: string) => void;

  public constructor(
    directory: string,
    now: () => number = Date.now,
    warn: (message: string) => void = () => undefined,
  ) {
    this.path = join(directory, 'oauth-grants.json');
    this.now = now;
    this.warn = warn;
    // A read-only or wrongly owned directory must not take the broker down:
    // tokens then fall back to this process only, which is the behaviour
    // without the setting at all.
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    } catch {
      this.warn(`OAuth state directory ${directory} is not writable; tokens will not persist`);
    }
  }

  public get(token: string): Grant | undefined {
    this.load();
    const grant = this.grants.get(token);
    if (grant === undefined) return undefined;
    if (grant.expiresAt <= this.now()) {
      this.grants.delete(token);
      this.persist();
      return undefined;
    }
    return grant;
  }

  public set(token: string, grant: Grant): void {
    this.load();
    this.grants.set(token, grant);
    this.persist();
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch {
      // A missing file is the first boot, not an error.
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A truncated write cannot happen with rename(), but a hand-edited file
      // can. Start empty rather than refusing to boot.
      return;
    }
    const now = this.now();
    const record = z.record(z.string(), GrantSchema).safeParse(parsed);
    if (!record.success) return;
    for (const [token, grant] of Object.entries(record.data)) {
      if (grant.expiresAt > now) {
        this.grants.set(token, { ...grant, username: grant.username ?? null });
      }
    }
  }

  private persist(): void {
    const now = this.now();
    const live = Object.fromEntries([...this.grants].filter(([, grant]) => grant.expiresAt > now));
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporaryPath, JSON.stringify(live), { mode: 0o600 });
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, this.path);
    } catch {
      // Persistence is best-effort: the in-memory map already holds the grant,
      // so an unwritable state directory must not fail the request. Without
      // this, a root-owned volume returned HTTP 500 on /token.
      this.warn('OAuth token persistence failed; tokens will not survive a restart');
    }
  }
}
