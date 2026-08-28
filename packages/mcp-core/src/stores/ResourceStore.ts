import { listV2Resources, readV2Resource } from '../resources/components-v2.js';

const GUILD_INFO_URI_RE = /^discord:\/\/guild\/(\d{17,20})\/info$/u;
const DEFAULT_DYNAMIC_TTL_MS = 5_000;

/**
 * MCP `resources/list` entry - minimal shape exposed to handlers.
 *
 * Mirrors the wire shape sent in `resources/list` responses (sans optional
 * `annotations`, which we don't currently emit).
 */
export interface ResourceListing {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string;
}

/**
 * MCP `resources/read` content - single content blob.
 *
 * The MCP wire format wraps this in a `contents` array; the store returns the
 * single blob and lets the handler do the wrapping.
 */
export interface ResourceContent {
  readonly uri: string;
  readonly mimeType: string;
  readonly text: string;
}

export interface ResourceStoreOptions {
  /** Guild IDs the deployment is willing to advertise as dynamic resources. */
  readonly guildIds?: readonly string[];
  /** Read one fresh guild snapshot from the caller-owned Discord connection. */
  readonly readGuildInfo?: (guildId: string) => Promise<unknown>;
  /** Reuse the same scope policy as resource subscriptions and tool calls. */
  readonly authorize?: (uri: string) => Promise<void> | void;
  readonly cacheTtlMs?: number;
  /** Injectable clock for deterministic cache tests. */
  readonly now?: () => number;
}

interface DynamicCacheEntry {
  readonly pending: Promise<ResourceContent>;
  expiresAt: number;
}

/**
 * Plain-class store wrapping the V2 resource list/read functions.
 *
 * Static Components V2 resources remain pure; configured guild-info URIs use
 * an injected, scope-authorized Discord reader with short-lived caching.
 *
 * Subscriptions remain on `SubscriptionRegistry` (Plan 6) - those are
 * per-request-time state, not static pieces, so they live separately.
 */
export class ResourceStore {
  private readonly options: ResourceStoreOptions;
  private readonly dynamicUris: readonly string[];
  private readonly dynamicUriSet: ReadonlySet<string>;
  private readonly dynamicCache = new Map<string, DynamicCacheEntry>();

  public constructor(options: ResourceStoreOptions = {}) {
    this.options = options;
    const ids = new Set((options.guildIds ?? []).filter((id) => /^\d{17,20}$/u.test(id)));
    this.dynamicUris = [...ids].map((id) => `discord://guild/${id}/info`);
    this.dynamicUriSet = new Set(this.dynamicUris);
  }

  /** List all known static resources (V2 templates + components-v2 schema). */
  public async list(): Promise<readonly ResourceListing[]> {
    const staticResources = await listV2Resources();
    if (this.options.readGuildInfo === undefined || this.dynamicUris.length === 0) {
      return staticResources;
    }
    return [
      ...staticResources,
      ...this.dynamicUris.map((uri) => ({
        uri,
        name: `Live guild snapshot - ${uri.split('/')[3] ?? 'unknown'}`,
        description:
          'Read-only Discord REST snapshot invalidated when the Gateway reports a guild update.',
        mimeType: 'application/json',
      })),
    ];
  }

  /**
   * Read a static or configured dynamic resource by URI. Returns `null` if the
   * URI does not match a known resource or configured dynamic target.
   */
  public async read(uri: string): Promise<ResourceContent | null> {
    const staticContent = await readV2Resource(uri);
    if (staticContent !== null) return staticContent;

    const match = GUILD_INFO_URI_RE.exec(uri);
    if (match === null || this.options.readGuildInfo === undefined) return null;
    // Authorize before the configured-URI check so an active allowlist fails
    // closed for a denied guild instead of turning a scope violation into a
    // misleading "not found" result. With no policy, unconfigured URIs still
    // return null without invoking the reader.
    await this.options.authorize?.(uri);
    if (!this.dynamicUriSet.has(uri)) return null;
    return this.readDynamicGuild(uri, match[1]!);
  }

  /** Invalidate a dynamic snapshot before sending its MCP update notification. */
  public invalidate(uri: string): void {
    if (GUILD_INFO_URI_RE.test(uri)) this.dynamicCache.delete(uri);
  }

  private readDynamicGuild(uri: string, guildId: string): Promise<ResourceContent> {
    const now = this.options.now ?? Date.now;
    const cached = this.dynamicCache.get(uri);
    if (cached !== undefined && cached.expiresAt > now()) return cached.pending;

    const pending = this.options.readGuildInfo!(guildId)
      .then((data) => ({
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(
          {
            resource_uri: uri,
            source: 'discord_rest',
            fetched_at: new Date(now()).toISOString(),
            data,
          },
          null,
          2,
        ),
      }))
      .catch((error: unknown) => {
        this.dynamicCache.delete(uri);
        throw error;
      });

    const entry: DynamicCacheEntry = { pending, expiresAt: Number.POSITIVE_INFINITY };
    this.dynamicCache.set(uri, entry);
    void pending.then(
      () => {
        if (this.dynamicCache.get(uri) === entry)
          entry.expiresAt = now() + (this.options.cacheTtlMs ?? DEFAULT_DYNAMIC_TTL_MS);
      },
      () => undefined,
    );
    return pending;
  }
}
