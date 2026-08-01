import { listV2Resources, readV2Resource } from '../resources/components-v2.js';

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

/**
 * Plain-class store wrapping the V2 resource list/read functions.
 *
 * Plan 12 Phase B - extracted from `server.ts` to provide a stable seam for
 * future dynamic resources (e.g., gateway-driven snapshots). For now it
 * delegates to the pure functions in `resources/components-v2.ts`.
 *
 * Subscriptions remain on `SubscriptionRegistry` (Plan 6) - those are
 * per-request-time state, not static pieces, so they live separately.
 */
export class ResourceStore {
  /** List all known static resources (V2 templates + components-v2 schema). */
  public async list(): Promise<readonly ResourceListing[]> {
    return listV2Resources();
  }

  /**
   * Read a static resource by URI. Returns `null` if the URI does not match
   * any known resource (template, schema, or otherwise).
   */
  public async read(uri: string): Promise<ResourceContent | null> {
    return readV2Resource(uri);
  }
}
